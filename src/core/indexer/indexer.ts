import * as path from "path";
import * as vscode from "vscode";
import {
  debouncePerKey,
  error,
  type PerKeyDebounced,
  warn,
} from "../../shared/utils";
import {
  buildIgnoreSpans,
  buildLineIndex,
  lineAtOffset,
  type LineIndex,
  mergeSpans,
  nameKey,
  extractLeadingTripleSlashDoc,
  extractSlashDoubleStarDoc,
  parseDocLines,
} from "../../shared/textUtils";
import {
  CI_FILE_GLOB,
  LABELS_DBF_GLOB,
  LOCVAR_DBF_GLOB,
} from "../../shared/globs";
import { getBuiltins } from "../builtins/builtins";
import type { FunctionInfo, VariableEntry } from "../../shared/types";
import type { FunctionRange } from "./types";
import { parseLabelsDbf, type LabelRecord } from "./labelsReader";
import { parseLocvarDbf } from "./localVarsParser";
import { blankComments, parseCicode, type ParsedFunction } from "./parser";
import { locateIncludeLabels } from "./includeProject";
import { findOpenDocument, isIndexableUri, readSourceText } from "./sourceText";
import { findWorkspaceFiles } from "../../config";

class FileIgnoreSpans {
  private _withHeaders?: Array<[number, number]>;

  constructor(
    readonly withoutHeaders: Array<[number, number]>,
    private readonly _headerSpans: Array<[number, number]>,
  ) {}

  get withHeaders(): Array<[number, number]> {
    return (this._withHeaders ??= mergeSpans([
      ...this.withoutHeaders,
      ...this._headerSpans,
    ]));
  }

  get(
    opts: { includeFunctionHeaders?: boolean } = {},
  ): Array<[number, number]> {
    return opts.includeFunctionHeaders ? this.withHeaders : this.withoutHeaders;
  }
}

/** Minimal document view accepted by the indexing pipeline, so files can be
 *  indexed from disk without opening a TextDocument. */
interface IndexableDocument {
  readonly uri: vscode.Uri;
  getText(): string;
  positionAt(offset: number): vscode.Position;
}

/** IndexableDocument backed by a plain string read from disk. */
class FileDocument implements IndexableDocument {
  private _lineIndex?: LineIndex;

  constructor(
    readonly uri: vscode.Uri,
    private readonly _text: string,
  ) {}

  /** Built lazily (a content-hash hit never needs it) and shared with the
   *  indexer so the text is only split into lines once. */
  get lineIndex(): LineIndex {
    return (this._lineIndex ??= buildLineIndex(this._text));
  }

  getText(): string {
    return this._text;
  }

  positionAt(offset: number): vscode.Position {
    const li = this.lineIndex;
    const off = Math.max(0, Math.min(offset, this._text.length));
    const line = lineAtOffset(li, off);
    return new vscode.Position(line, off - li.starts[line]);
  }
}

type SourceKind = "ci" | "labels" | "locvar";

/** Which kind of indexer source a path is, judged by its name (the compiler
 *  ignores case: FOO.CI and LABELS.DBF count). */
function sourceKind(p: string): SourceKind | undefined {
  const base = path.basename(p).toLowerCase();
  if (base.endsWith(".ci")) return "ci";
  if (base === "labels.dbf") return "labels";
  if (base === "locvar.dbf") return "locvar";
  return undefined;
}

/** FNV-1a 32-bit hash: cheap content fingerprint for skip-if-unchanged. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Argument bounds of a parameter list. A call fills parameters from the
 *  left, so every parameter up to the last one without a default is
 *  required, even when an earlier one has a default. */
function argBounds(hasDefault: readonly boolean[]): {
  minArgs: number;
  maxArgs: number;
} {
  let last = -1;
  hasDefault.forEach((d, i) => {
    if (!d) last = i;
  });
  return { minArgs: last + 1, maxArgs: hasDefault.length };
}

/** Splits a label macro's parameter list at top-level commas. */
function splitMacroParams(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "^") {
        cur += c + (s[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim() || out.length) out.push(cur.trim());
  return out.filter(Boolean);
}

/** Location spanning a declared name. */
function nameLocation(
  doc: IndexableDocument,
  start: number,
  name: string,
): vscode.Location {
  return new vscode.Location(
    doc.uri,
    new vscode.Range(
      doc.positionAt(start),
      doc.positionAt(start + name.length),
    ),
  );
}

/** Name key (nameKey) → per-source-file definitions. Several files may define
 *  the same name (PRIVATE functions, or unrelated projects in one
 *  workspace); keeping all of them lets a purge fall back to another one. */
type DefsByKey<T> = Map<string, Map<string, T>>;

function addDef<T>(defs: DefsByKey<T>, key: string, file: string, v: T) {
  let m = defs.get(key);
  if (!m) defs.set(key, (m = new Map()));
  if (!m.has(file)) m.set(file, v);
}

function removeDef<T>(defs: DefsByKey<T>, key: string, file: string) {
  const m = defs.get(key);
  if (m?.delete(file) && m.size === 0) defs.delete(key);
}

/**
 * Indexes Cicode files, labels.DBF and locvar.DBF tables: function
 * definitions, variable declarations and labels, with their locations.
 * Every map is keyed by nameKey: names ignore the case of ASCII letters
 * only, as the compiler does.
 */
export class Indexer {
  private readonly builtinFunctions = new Map<string, FunctionInfo>();
  private readonly _ciDefs: DefsByKey<FunctionInfo> = new Map();
  private readonly _macroDefs: DefsByKey<FunctionInfo> = new Map();
  private readonly _constDefs: DefsByKey<LabelRecord> = new Map();
  // Resolved views over the definition maps: one entry per name.
  private readonly _ciView = new Map<string, FunctionInfo>();
  private readonly _macroView = new Map<string, FunctionInfo>();
  readonly labelCache = new Map<string, LabelRecord>(); // constant labels
  private _mergedFunctions: Map<string, FunctionInfo> | null = null;

  readonly variableCache = new Map<string, VariableEntry[]>();
  private readonly functionRangesByFile = new Map<string, FunctionRange[]>();
  private readonly _ignoreSpansByFile = new Map<string, FileIgnoreSpans>();

  // Reverse indexes for O(1) file purge instead of O(n) iteration
  private readonly _functionKeysByFile = new Map<string, Set<string>>();
  private readonly _variableKeysByFile = new Map<string, Set<string>>();
  private readonly _labelKeysByFile = new Map<string, Set<string>>();

  // Content fingerprint of the last indexed text per file. Opening a document
  // (e.g. diagnostics iterating the workspace) fires onDidOpenTextDocument;
  // without this guard every such open re-indexes unchanged content and fires
  // onIndexed, cascading into another diagnostics run per file.
  private readonly _indexedTextHash = new Map<string, string>();

  // labels.DBF tables read from outside the workspace (the Include project).
  private _externalLabelFiles: string[] = [];
  private _externalWatchers: vscode.Disposable[] = [];

  private readonly _onIndexed = new vscode.EventEmitter<string | undefined>();
  /** Fires after indexing completes. Carries the source file path for
   *  single-file reindex (a .ci file, or a labels.DBF/locvar.DBF path),
   *  undefined for full rebuild. */
  readonly onIndexed = this._onIndexed.event;

  private _bulkIndexing = false;
  // Monotonic version counter so a superseded buildAll can bail out instead
  // of racing a newer build (duplicating locvar entries, corrupting flags).
  private _buildVersion = 0;

  private readonly _debouncedIndex: PerKeyDebounced<
    (doc: vscode.TextDocument) => void
  >;
  private readonly _debouncedReindexLabels: PerKeyDebounced<
    (filePath: string) => void
  >;
  private readonly _debouncedReindexLocvar: PerKeyDebounced<
    (filePath: string) => void
  >;
  private readonly _debouncedSyncFromDisk: PerKeyDebounced<
    (filePath: string) => void
  >;

  constructor(
    context: vscode.ExtensionContext,
    private readonly cfg: () => vscode.WorkspaceConfiguration,
  ) {
    this._debouncedIndex = debouncePerKey(
      (doc: vscode.TextDocument) => {
        // A document closed before its timer fired may belong to a path that
        // was deleted or renamed since; indexing it would resurrect the dead
        // path. Closed files are re-read from disk by the .ci watcher instead.
        if (doc.isClosed) return;
        void this._indexFile(doc).catch((e) =>
          error("index fail", doc.uri.fsPath, e),
        );
      },
      500,
      (doc) => doc.uri.fsPath,
    );
    this._debouncedSyncFromDisk = debouncePerKey(
      (p: string) => {
        void this._syncFromDisk(p).catch((e) => error("index fail", p, e));
      },
      500,
      (p) => p,
    );
    this._debouncedReindexLabels = debouncePerKey(
      (p: string) => this._reindexLabelsFile(p),
      500,
      (p) => p,
    );
    this._debouncedReindexLocvar = debouncePerKey(
      (p: string) => this._reindexLocvarFile(p),
      500,
      (p) => p,
    );

    const labelsWatcher =
      vscode.workspace.createFileSystemWatcher(LABELS_DBF_GLOB);
    const locvarWatcher =
      vscode.workspace.createFileSystemWatcher(LOCVAR_DBF_GLOB);
    // .ci files edited outside VS Code (AVEVA editors, git, Explorer) never
    // raise TextDocument events for unopened files.
    const ciWatcher = vscode.workspace.createFileSystemWatcher(CI_FILE_GLOB);
    context.subscriptions.push(
      ciWatcher,
      ciWatcher.onDidChange((uri) => this._debouncedSyncFromDisk(uri.fsPath)),
      ciWatcher.onDidCreate((uri) => this._debouncedSyncFromDisk(uri.fsPath)),
      ciWatcher.onDidDelete((uri) => this._debouncedSyncFromDisk(uri.fsPath)),
      labelsWatcher,
      labelsWatcher.onDidChange((uri) =>
        this._debouncedReindexLabels(uri.fsPath),
      ),
      labelsWatcher.onDidCreate((uri) =>
        this._debouncedReindexLabels(uri.fsPath),
      ),
      labelsWatcher.onDidDelete((uri) =>
        this._debouncedReindexLabels(uri.fsPath),
      ),
      locvarWatcher,
      locvarWatcher.onDidChange((uri) =>
        this._debouncedReindexLocvar(uri.fsPath),
      ),
      locvarWatcher.onDidCreate((uri) =>
        this._debouncedReindexLocvar(uri.fsPath),
      ),
      locvarWatcher.onDidDelete((uri) =>
        this._debouncedReindexLocvar(uri.fsPath),
      ),
      vscode.workspace.onDidSaveTextDocument((d) => this._maybeIndex(d)),
      vscode.workspace.onDidOpenTextDocument((d) => this._maybeIndex(d)),
      vscode.workspace.onDidChangeTextDocument((e) =>
        this._maybeIndex(e.document),
      ),
      vscode.workspace.onDidDeleteFiles((e) =>
        e.files.forEach((f) => this._purgePath(f.fsPath)),
      ),
      vscode.workspace.onDidRenameFiles((e) =>
        e.files.forEach(({ oldUri, newUri }) =>
          this._movePath(oldUri.fsPath, newUri.fsPath),
        ),
      ),
      // extension.ts rebuilds the index when cicode.indexing.includeProjectPath
      // or cicode.avevaPath (both steer the Include lookup) changes.
      { dispose: () => this._disposeExternalWatchers() },
    );
  }

  /** Build the index for all workspace sources. */
  async buildAll(): Promise<void> {
    const version = ++this._buildVersion;
    this.builtinFunctions.clear();
    this._ciDefs.clear();
    this._macroDefs.clear();
    this._constDefs.clear();
    this._ciView.clear();
    this._macroView.clear();
    this.labelCache.clear();
    this._mergedFunctions = null;
    this.variableCache.clear();
    this.functionRangesByFile.clear();
    this._functionKeysByFile.clear();
    this._variableKeysByFile.clear();
    this._labelKeysByFile.clear();
    this._ignoreSpansByFile.clear();
    this._indexedTextHash.clear();

    for (const [k, v] of getBuiltins()) {
      this.builtinFunctions.set(k, {
        ...v,
        location: null,
        file: null,
        bodyRange: null,
      });
    }

    // Labels first: the compiler expands them before anything else.
    const labelFiles = await findWorkspaceFiles(LABELS_DBF_GLOB, this.cfg);
    if (version !== this._buildVersion) return; // superseded by a newer buildAll
    const external = this._findExternalLabels(labelFiles);
    for (const f of [...labelFiles.map((u) => u.fsPath), ...external]) {
      this._indexLabels(f);
    }
    this._watchExternalLabels(external);

    const files = await findWorkspaceFiles(CI_FILE_GLOB, this.cfg);
    if (version !== this._buildVersion) return;
    this._bulkIndexing = true;
    for (const file of files) {
      try {
        await this._indexPath(file);
      } catch (e) {
        error("index fail", file.fsPath, e);
      }
      // Superseded: the newer build owns the caches and the bulk flag.
      if (version !== this._buildVersion) return;
    }
    this._bulkIndexing = false;

    const locvarFiles = await findWorkspaceFiles(LOCVAR_DBF_GLOB, this.cfg);
    if (version !== this._buildVersion) return;
    for (const file of locvarFiles) {
      this._indexLocvar(file.fsPath);
    }

    this._onIndexed.fire(undefined);
  }

  /**
   * The compiler always compiles the Include project in, so its labels are
   * active in every project. When the workspace does not contain it, read
   * its labels.DBF from the Plant SCADA User folder.
   */
  private _findExternalLabels(workspaceLabels: vscode.Uri[]): string[] {
    const inWorkspace = workspaceLabels.some(
      (u) => path.basename(path.dirname(u.fsPath)).toLowerCase() === "include",
    );
    if (inWorkspace) return [];
    const c = this.cfg();
    const explicit =
      c.get<string>("cicode.indexing.includeProjectPath", "")?.trim() ||
      undefined;
    const file = locateIncludeLabels({
      explicit,
      near: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      avevaPath: c.get<string>("cicode.avevaPath", "")?.trim() || undefined,
    });
    if (!file) {
      if (explicit)
        warn("no labels.DBF at cicode.indexing.includeProjectPath", explicit);
      return [];
    }
    const key = path.resolve(file).toLowerCase();
    return workspaceLabels.some(
      (u) => path.resolve(u.fsPath).toLowerCase() === key,
    )
      ? []
      : [file];
  }

  private _watchExternalLabels(files: string[]): void {
    this._disposeExternalWatchers();
    this._externalLabelFiles = files;
    for (const f of files) {
      try {
        const w = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(
            vscode.Uri.file(path.dirname(f)),
            path.basename(LABELS_DBF_GLOB),
          ),
        );
        const reindex = () => this._debouncedReindexLabels(f);
        this._externalWatchers.push(
          w,
          w.onDidChange(reindex),
          w.onDidCreate(reindex),
          w.onDidDelete(reindex),
        );
      } catch (e) {
        error("cannot watch", f, e);
      }
    }
  }

  private _disposeExternalWatchers(): void {
    for (const d of this._externalWatchers) d.dispose();
    this._externalWatchers = [];
  }

  private _indexLabels(filePath: string): void {
    this._purgeFile(filePath, false);
    const records = parseLabelsDbf(filePath);
    for (const rec of records) {
      const parenIdx = rec.name.indexOf("(");
      if (parenIdx === -1) {
        const key = nameKey(rec.name.trim());
        if (!key) continue;
        addDef(this._constDefs, key, filePath, rec);
        this._addToReverseIndex(this._labelKeysByFile, filePath, key);
        this._refreshLabelView(key);
        continue;
      }
      // Function-like macro: NAME(a, b=default)
      const closeIdx = rec.name.lastIndexOf(")");
      if (closeIdx < parenIdx) continue; // malformed entry
      const funcName = rec.name.slice(0, parenIdx).trim();
      if (!funcName) continue;
      const params = splitMacroParams(rec.name.slice(parenIdx + 1, closeIdx));
      const key = nameKey(funcName);
      addDef(this._macroDefs, key, filePath, {
        name: funcName,
        returnType: "",
        params,
        file: filePath,
        location: null,
        bodyRange: null,
        expr: rec.expr || undefined,
        doc: rec.comment || undefined,
        origin: "label",
        ...argBounds(params.map((p) => p.includes("="))),
      });
      this._addToReverseIndex(this._functionKeysByFile, filePath, key);
      this._refreshMacroView(key);
    }
  }

  private _indexLocvar(filePath: string): void {
    this._purgeFile(filePath, false);
    const records = parseLocvarDbf(filePath);
    for (const rec of records) {
      this._addVar(rec.name, {
        name: rec.name,
        type: rec.type || "UNKNOWN",
        scopeType: "global",
        scopeId: "global",
        location: null,
        file: filePath,
        range: null,
        isParam: false,
        doc: rec.comment || undefined,
      });
    }
  }

  private _reindexLocvarFile(filePath: string): void {
    this._indexLocvar(filePath);
    this._onIndexed.fire(filePath);
  }

  private _reindexLabelsFile(filePath: string): void {
    this._indexLabels(filePath);
    this._onIndexed.fire(filePath);
  }

  private _maybeIndex(doc: vscode.TextDocument): void {
    if (!doc || !isIndexableUri(doc.uri)) return;
    if (sourceKind(doc.uri.fsPath) !== "ci") return;
    this._debouncedIndex(doc);
  }

  /** Re-sync one .ci file after it changed on disk. Cheap when nothing
   *  changed: open documents and unchanged bytes hit the content-hash guard. */
  private async _syncFromDisk(fsPath: string): Promise<void> {
    const uri = vscode.Uri.file(fsPath);
    const known = this._indexedTextHash.has(fsPath);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      // Deleted (in-app deletes/renames were already purged by their events)
      if (known) this._purgeFile(fsPath);
      return;
    }
    if (!known && this._isExcluded(uri)) return;
    await this._indexPath(uri);
  }

  /** Same test as findWorkspaceFiles' `cicode.indexing.excludePatterns`
   *  filter, for a single file reported by the watcher. */
  private _isExcluded(uri: vscode.Uri): boolean {
    const patterns = this.cfg().get<string[]>(
      "cicode.indexing.excludePatterns",
      [],
    );
    if (!patterns.length) return false;
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
    return patterns.some((p) => {
      if (!p) return false;
      try {
        return new RegExp(p, "i").test(rel);
      } catch {
        return false;
      }
    });
  }

  /** Purge all cache entries owned by a file. Definitions of the same names
   *  in other files take over automatically. */
  private _purgeFile(file: string, fireEvent = true): void {
    this._indexedTextHash.delete(file);

    const funcKeys = this._functionKeysByFile.get(file);
    if (funcKeys) {
      for (const key of funcKeys) {
        removeDef(this._ciDefs, key, file);
        removeDef(this._macroDefs, key, file);
        this._refreshCiView(key);
        this._refreshMacroView(key);
      }
      this._functionKeysByFile.delete(file);
    }

    const varKeys = this._variableKeysByFile.get(file);
    if (varKeys) {
      for (const key of varKeys) {
        const arr = this.variableCache.get(key);
        if (arr) {
          const filtered = arr.filter((e) => e.file !== file);
          if (filtered.length) this.variableCache.set(key, filtered);
          else this.variableCache.delete(key);
        }
      }
      this._variableKeysByFile.delete(file);
    }

    const labelKeys = this._labelKeysByFile.get(file);
    if (labelKeys) {
      for (const key of labelKeys) {
        removeDef(this._constDefs, key, file);
        this._refreshLabelView(key);
      }
      this._labelKeysByFile.delete(file);
    }

    this.functionRangesByFile.delete(file);
    this._ignoreSpansByFile.delete(file);
    if (fireEvent) {
      // The file is gone: a pending reindex would resurrect it from a stale
      // TextDocument.
      this._debouncedIndex.cancel(file);
      this._onIndexed.fire(file);
    }
  }

  private _refreshCiView(key: string): void {
    // A PUBLIC definition wins over PRIVATE ones, which only their own file
    // can call.
    let pick: FunctionInfo | undefined;
    for (const info of this._ciDefs.get(key)?.values() ?? []) {
      if (!info.isPrivate) {
        pick = info;
        break;
      }
      pick ??= info;
    }
    if (pick) this._ciView.set(key, pick);
    else this._ciView.delete(key);
    this._mergedFunctions = null;
  }

  private _refreshMacroView(key: string): void {
    const defs = this._macroDefs.get(key);
    const macro = defs?.values().next().value as FunctionInfo | undefined;
    if (!macro) {
      this._macroView.delete(key);
    } else {
      // A documented function that is really a label keeps its help text,
      // but the label decides the arguments.
      const b = this.builtinFunctions.get(key);
      this._macroView.set(
        key,
        b
          ? {
              ...macro,
              returnType: macro.returnType || b.returnType,
              doc: b.doc || macro.doc,
              returns: b.returns,
              helpPath: b.helpPath,
              helpId: b.helpId,
            }
          : macro,
      );
    }
    this._mergedFunctions = null;
  }

  private _refreshLabelView(key: string): void {
    const rec = this._constDefs.get(key)?.values().next().value as
      | LabelRecord
      | undefined;
    if (rec) this.labelCache.set(key, rec);
    else this.labelCache.delete(key);
  }

  private _moveFile(oldPath: string, newPath: string): void {
    // A pending reindex of the old path would resurrect it under a dead path.
    this._debouncedIndex.cancel(oldPath);
    const oldKind = sourceKind(oldPath);
    const newKind = sourceKind(newPath);
    if (oldKind === undefined && newKind === undefined) return; // not ours

    // Locations and local scope ids embed the path, so re-read the source
    // under its new name; a source renamed to another kind of name
    // (Util.ci -> Util.ci.old) stops contributing altogether.
    this._purgeFile(oldPath, false);
    switch (newKind) {
      case "ci":
        this._indexedTextHash.delete(newPath);
        void this._indexPath(vscode.Uri.file(newPath)).catch((e) => {
          error("index fail", newPath, e);
          this._onIndexed.fire(newPath);
        });
        return;
      case "labels":
        this._indexLabels(newPath);
        break;
      case "locvar":
        this._indexLocvar(newPath);
        break;
    }
    this._onIndexed.fire(newKind ? newPath : oldPath);
  }

  /** All indexed file paths located under a directory. */
  private _indexedFilesUnder(dir: string): string[] {
    const prefix = dir + path.sep;
    const files = new Set<string>();
    for (const keys of [
      this._functionKeysByFile.keys(),
      this._variableKeysByFile.keys(),
      this._labelKeysByFile.keys(),
      this.functionRangesByFile.keys(),
      this._ignoreSpansByFile.keys(),
    ]) {
      for (const f of keys) if (f.startsWith(prefix)) files.add(f);
    }
    return [...files];
  }

  /** Purge a deleted path: a single file, or every indexed file under a folder
   *  (VS Code fires one event with the folder URI for folder deletes). */
  private _purgePath(fsPath: string): void {
    const children = this._indexedFilesUnder(fsPath);
    if (children.length) for (const f of children) this._purgeFile(f);
    else this._purgeFile(fsPath);
  }

  /** Move a renamed path: a single file, or every indexed file under a folder
   *  (VS Code fires one event with the folder URI for folder renames). */
  private _movePath(oldPath: string, newPath: string): void {
    const children = this._indexedFilesUnder(oldPath);
    if (children.length) {
      for (const f of children) {
        this._moveFile(f, newPath + f.slice(oldPath.length));
      }
    } else {
      this._moveFile(oldPath, newPath);
    }
  }

  /** Generate unique scope ID for local variables */
  localScopeId(file: string, funcName: string) {
    return `local:${file}::${funcName}`;
  }

  private _addToReverseIndex(
    index: Map<string, Set<string>>,
    file: string,
    key: string,
  ): void {
    let s = index.get(file);
    if (!s) {
      s = new Set();
      index.set(file, s);
    }
    s.add(key);
  }

  /** Index a file by path, reusing an already-open document when available
   *  and otherwise reading it from disk. */
  private async _indexPath(uri: vscode.Uri): Promise<void> {
    const openDoc = findOpenDocument(uri);
    if (openDoc) {
      await this._indexFile(openDoc);
      return;
    }
    const text = await readSourceText(uri);
    await this._indexFile(new FileDocument(uri, text));
  }

  private async _indexFile(doc: IndexableDocument): Promise<void> {
    const file = doc.uri.fsPath;
    const text = doc.getText();

    // No-op when the content is what we already indexed (see _indexedTextHash).
    const hash = `${text.length}:${fnv1a(text)}`;
    if (this._indexedTextHash.get(file) === hash) return;

    this._purgeFile(file, false);
    this._indexedTextHash.set(file, hash);
    const base = buildIgnoreSpans(text, { includeFunctionHeaders: false });
    const lineIndex =
      doc instanceof FileDocument ? doc.lineIndex : buildLineIndex(text);
    const parsed = parseCicode(text);

    const functions = parsed.functions.map((pf) =>
      this._toFunctionRange(pf, doc, text, lineIndex, parsed.comments),
    );
    // Header spans run from the first header word (scope or type) to ')'.
    const headerSpans: Array<[number, number]> = functions.map((f) => [
      f.itemStart,
      f.startOffset,
    ]);
    this._ignoreSpansByFile.set(file, new FileIgnoreSpans(base, headerSpans));
    this.functionRangesByFile.set(file, functions);

    parsed.functions.forEach((pf, idx) => {
      const f = functions[idx];
      const key = nameKey(f.name);
      addDef(this._ciDefs, key, file, {
        name: f.name,
        returnType: f.returnType || "VOID",
        params: pf.params.map((p) => p.text),
        location: f.location,
        doc: f.docText || "",
        returns: f.returnsDoc,
        paramDocs: f.paramDocs,
        file,
        bodyRange: f.bodyRange,
        origin: "cicode",
        isPrivate: f.scope === "PRIVATE",
        ...argBounds(pf.params.map((p) => p.hasDefault)),
      });
      this._addToReverseIndex(this._functionKeysByFile, file, key);
      this._refreshCiView(key);

      const scopeId = this.localScopeId(file, f.name);
      for (const p of pf.params) {
        this._addVar(p.name, {
          name: p.name,
          type: p.type,
          scopeType: "local",
          scopeId,
          location: nameLocation(doc, p.nameStart, p.name),
          file,
          range: f.bodyRange,
          isParam: true,
        });
      }
    });

    for (const d of parsed.declarations) {
      const type = d.type + d.dims.map((x) => `[${x}]`).join("");
      const f = d.fn >= 0 ? functions[d.fn] : undefined;
      this._addVar(d.name, {
        name: d.name,
        type,
        scopeType: f ? "local" : d.scope === "GLOBAL" ? "global" : "module",
        scopeId: f
          ? this.localScopeId(file, f.name)
          : d.scope === "GLOBAL"
            ? "global"
            : file,
        location: nameLocation(doc, d.nameStart, d.name),
        file,
        range: f ? f.bodyRange : null,
        isParam: false,
      });
    }

    if (!this._bulkIndexing) this._onIndexed.fire(file);
  }

  private _toFunctionRange(
    pf: ParsedFunction,
    doc: IndexableDocument,
    text: string,
    lineIndex: LineIndex,
    comments: Array<[number, number]>,
  ): FunctionRange {
    // Doc comments sit above the first header line (scope/type may be on
    // lines of their own), or directly above FUNCTION.
    let docLines = extractSlashDoubleStarDoc(lineIndex, pf.itemStart);
    if (!docLines.length) {
      docLines = extractLeadingTripleSlashDoc(lineIndex, pf.itemStart);
    }
    if (
      !docLines.length &&
      lineAtOffset(lineIndex, pf.itemStart) !==
        lineAtOffset(lineIndex, pf.keywordStart)
    ) {
      docLines = extractSlashDoubleStarDoc(lineIndex, pf.keywordStart);
      if (!docLines.length) {
        docLines = extractLeadingTripleSlashDoc(lineIndex, pf.keywordStart);
      }
    }
    // Separator rows (////////, //-----) are not documentation.
    docLines = docLines.filter((l) => !/^\s*([/\-=*_#~+])\1{2,}\s*$/.test(l));
    const parsedDoc = docLines.some((l) => l.trim())
      ? parseDocLines(docLines)
      : undefined;

    // Comments inside the list are blanked so consumers splitting it on
    // commas see only parameter text.
    const paramsRaw = blankComments(
      text,
      pf.paramsStart,
      pf.paramsEnd,
      comments,
    );

    const nameStart = doc.positionAt(pf.nameStart);
    return {
      name: pf.name,
      returnType: pf.returnType ?? "VOID",
      paramsRaw,
      headerIndex: pf.keywordStart,
      headerPos: doc.positionAt(pf.keywordStart),
      itemStart: pf.itemStart,
      nameOffset: pf.nameStart,
      hasParens: pf.hasParens,
      scope: pf.scope,
      closed: pf.closed,
      location: new vscode.Location(
        doc.uri,
        new vscode.Range(nameStart, doc.positionAt(pf.nameEnd)),
      ),
      startOffset: pf.headerEnd,
      endOffset: pf.bodyEnd,
      bodyRange: new vscode.Range(
        doc.positionAt(pf.headerEnd),
        doc.positionAt(pf.bodyEnd),
      ),
      docText: parsedDoc?.summary || undefined,
      paramDocs:
        parsedDoc && Object.keys(parsedDoc.paramDocs).length
          ? parsedDoc.paramDocs
          : undefined,
      returnsDoc: parsedDoc?.returns || undefined,
    };
  }

  private _addVar(name: string, entry: VariableEntry) {
    const k = nameKey(name);
    let arr = this.variableCache.get(k);
    if (!arr) this.variableCache.set(k, (arr = []));
    arr.push(entry);

    // Track in reverse index for efficient purge
    this._addToReverseIndex(this._variableKeysByFile, entry.file, k);
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /** Function-like label of a name: from a labels.DBF, else the Include
   *  project's own (shipped with the built-ins; Include is always compiled
   *  in). */
  private _labelMacro(key: string): FunctionInfo | undefined {
    const b = this.builtinFunctions.get(key);
    return this._macroView.get(key) ?? (b?.origin === "label" ? b : undefined);
  }

  /** Resolve a function name the way the compiler does, without the calling
   *  file: a function-like label (labels are expanded before names are
   *  looked up), a PUBLIC .ci function, a built-in, then a PRIVATE .ci
   *  function. A constant label or a variable in scope also hides a
   *  function; callers check getLabel and resolveVariableInScope first. */
  getFunction(name: string): FunctionInfo | undefined {
    const key = nameKey(name);
    const ci = this._ciView.get(key);
    return (
      this._labelMacro(key) ??
      (ci && !ci.isPrivate ? ci : undefined) ??
      this.builtinFunctions.get(key) ??
      ci
    );
  }

  /** The function a call in `file` reaches: a function-like label, the
   *  file's own function (a PRIVATE one included), a PUBLIC one, then a
   *  built-in. PRIVATE functions of other files are invisible (E2031), also
   *  where they share a built-in's name. */
  getFunctionFor(name: string, file: string): FunctionInfo | undefined {
    const key = nameKey(name);
    const ci = this._ciView.get(key);
    return (
      this._labelMacro(key) ??
      this._ciDefs.get(key)?.get(file) ??
      (ci && !ci.isPrivate ? ci : undefined) ??
      this.builtinFunctions.get(key)
    );
  }

  /** Every .ci definition of a name, one per defining file. */
  getFunctionDefinitions(name: string): FunctionInfo[] {
    return [...(this._ciDefs.get(nameKey(name))?.values() ?? [])];
  }

  getBuiltinFunction(name: string): FunctionInfo | undefined {
    return this.builtinFunctions.get(nameKey(name));
  }

  hasFunction(name: string) {
    return this.getFunction(name) !== undefined;
  }

  /** Every function name (keyed by nameKey), resolved like getFunction. */
  getAllFunctions(): ReadonlyMap<string, FunctionInfo> {
    if (!this._mergedFunctions) {
      const merged = new Map(this.builtinFunctions);
      for (const [k, v] of this._ciView) {
        const b = merged.get(k);
        if (b?.origin === "label" || (v.isPrivate && b)) continue;
        merged.set(k, v);
      }
      for (const [k, v] of this._macroView) merged.set(k, v);
      this._mergedFunctions = merged;
    }
    return this._mergedFunctions;
  }

  getVariables(name: string) {
    return this.variableCache.get(nameKey(name)) || [];
  }

  getAllVariableEntries(): ReadonlyArray<VariableEntry> {
    const out: VariableEntry[] = [];
    for (const [, arr] of this.variableCache) out.push(...arr);
    return out;
  }

  getVariablesByPredicate(
    pred: (v: VariableEntry) => boolean,
  ): VariableEntry[] {
    const out: VariableEntry[] = [];
    for (const [, arr] of this.variableCache) {
      for (const v of arr) {
        if (pred(v)) out.push(v);
      }
    }
    return out;
  }

  getTotalVariableCount(): number {
    let n = 0;
    for (const [, arr] of this.variableCache) n += arr.length;
    return n;
  }

  getVariablesInFile(file: string): VariableEntry[] {
    const keys = this._variableKeysByFile.get(file);
    if (!keys) return [];
    const out: VariableEntry[] = [];
    for (const key of keys) {
      const arr = this.variableCache.get(key);
      if (arr) {
        for (const v of arr) {
          if (v.file === file) out.push(v);
        }
      }
    }
    return out;
  }

  getFunctionRanges(file: string) {
    return this.functionRangesByFile.get(file) || [];
  }

  /** Get cached ignore spans for a file. Pass `{ includeFunctionHeaders: true }` to also
   *  exclude function header ranges (needed by inlay hints). Defaults to false. */
  getIgnoreSpans(
    file: string,
    opts: { includeFunctionHeaders?: boolean } = {},
  ): Array<[number, number]> | undefined {
    return this._ignoreSpansByFile.get(file)?.get(opts);
  }

  /**
   * Resolve a variable name against the scope chain: local (by scope id),
   * then module (same file), then global. With `at`, the compiler's
   * declaration order applies: a local or module variable is only known
   * after its declaration (an earlier use is an undefined tag, W1007), while
   * parameters and GLOBAL variables are known everywhere.
   */
  resolveVariableInScope(
    name: string,
    file: string,
    localScopeId: string | null,
    at?: vscode.Position,
  ): VariableEntry | null {
    const candidates = this.variableCache.get(nameKey(name));
    if (!candidates?.length) return null;

    const declared = (v: VariableEntry) => {
      if (!at || v.isParam || !v.location) return true;
      const p = v.location.range.start;
      return (
        p.line < at.line || (p.line === at.line && p.character <= at.character)
      );
    };

    if (localScopeId) {
      const local = candidates.find(
        (v) =>
          v.scopeType === "local" && v.scopeId === localScopeId && declared(v),
      );
      if (local) return local;
    }

    const mod = candidates.find(
      (v) => v.scopeType === "module" && v.scopeId === file && declared(v),
    );
    if (mod) return mod;

    // A compile holds one GLOBAL of a name: prefer the one in this file's
    // project folder, then the Include project's.
    const globals = candidates.filter((v) => v.scopeType === "global");
    const dir = path.dirname(file).toLowerCase();
    const folder = (v: VariableEntry) => path.dirname(v.file).toLowerCase();
    return (
      globals.find((v) => folder(v) === dir) ??
      globals.find((v) => path.basename(folder(v)) === "include") ??
      globals[0] ??
      null
    );
  }

  /** Resolve a variable name at a given position, respecting scope rules
   *  and declaration order. */
  resolveVariableAt(
    document: vscode.TextDocument,
    position: vscode.Position,
    name: string,
  ) {
    const file = document.uri.fsPath;
    if (!this.variableCache.get(nameKey(name))?.length) return null;
    const encl = this.findEnclosingFunction(document, position);
    return this.resolveVariableInScope(
      name,
      file,
      encl ? this.localScopeId(file, encl.name) : null,
      position,
    );
  }

  /** Is `name` a label (constant or function-like)? The compiler replaces
   *  such a name everywhere outside strings, declarations included. */
  isKnownLabel(name: string): boolean {
    const key = nameKey(name);
    return this.labelCache.has(key) || this._labelMacro(key) !== undefined;
  }

  /** Constant label record. */
  getLabel(name: string): LabelRecord | undefined {
    return this.labelCache.get(nameKey(name));
  }

  /** All constant labels. */
  getAllLabels(): Map<string, LabelRecord> {
    return this.labelCache;
  }

  /** labels.DBF tables read from outside the workspace (the Include project). */
  getExternalLabelFiles(): readonly string[] {
    return this._externalLabelFiles;
  }

  /** Find the function containing a given position (includes header and body) */
  findEnclosingFunction(
    document: vscode.TextDocument,
    position: vscode.Position,
  ) {
    const file = document.uri.fsPath;
    const list = this.getFunctionRanges(file);
    if (!list) return null;

    const off = document.offsetAt(position);
    for (const f of list) {
      // Check full function range: from header start to body end
      const headerStart = document.offsetAt(f.headerPos);
      const bodyEnd = document.offsetAt(f.bodyRange.end);
      if (off >= headerStart && off < bodyEnd) return f;
    }
    return null;
  }

  /** Dispose of resources (EventEmitter, pending debounce timers) */
  dispose(): void {
    this._debouncedIndex.cancelAll();
    this._debouncedReindexLabels.cancelAll();
    this._debouncedReindexLocvar.cancelAll();
    this._debouncedSyncFromDisk.cancelAll();
    this._disposeExternalWatchers();
    this._onIndexed.dispose();
  }
}
