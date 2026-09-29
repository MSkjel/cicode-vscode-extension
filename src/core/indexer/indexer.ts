import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  debounce,
  type Debounced,
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
  INCLUDE_DBF_GLOB,
  LABELS_DBF_GLOB,
  LOCVAR_DBF_GLOB,
  MASTER_DBF_PATTERN,
} from "../../shared/globs";
import { getBuiltins } from "../builtins/builtins";
import type { FunctionInfo, VariableEntry } from "../../shared/types";
import type { FunctionRange } from "./types";
import { parseLabelsDbf, type LabelRecord } from "./labelsReader";
import { parseLocvarDbf } from "./localVarsParser";
import { blankComments, parseCicode, type ParsedFunction } from "./parser";
import {
  buildProjectGraph,
  type GraphBuild,
  ProjectGraph,
  type ProjectInfo,
  projectKey,
} from "./projectGraph";
import { isDir } from "./includeProject";
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

const isIncludeDbf = (p: string) =>
  path.basename(p).toLowerCase() === "include.dbf";

// Windows paths ignore case: one file reached by two spellings is one file.
const foldCase = process.platform === "win32";

/** A folder as the file system spells it (MASTER.DBF's PATH may differ in
 *  case), so its files get the paths an opened file has. A junction or
 *  link keeps the path it was reached by. */
function diskSpelling(folder: string): string {
  try {
    const real = fs.realpathSync.native(folder);
    if (real.toLowerCase() === path.resolve(folder).toLowerCase()) return real;
  } catch {
    /* gone */
  }
  return folder;
}

// A graph refresh that finds a table cut short reads again this often
// before it takes what it can read.
const REFRESH_RETRIES = 5;

/** Source files of the workspace, or of the out-of-workspace projects. */
interface Sources {
  ci: string[];
  labels: string[];
  locvar: string[];
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

/** Same definition, also across the copies scoped lookups hand out (a
 *  library function with its shipped help merged in): same file, name and
 *  origin. */
export function sameDefinition(
  a: FunctionInfo | undefined,
  b: FunctionInfo | undefined,
): boolean {
  if (a === b) return true;
  return (
    !!a &&
    !!b &&
    a.file === b.file &&
    a.origin === b.origin &&
    nameKey(a.name) === nameKey(b.name)
  );
}

/** Resolved names for the files of one project, built on demand. */
interface ScopeView {
  functions?: Map<string, FunctionInfo>;
  labels?: Map<string, LabelRecord>;
  /** Keys of every label, constant or function-like. */
  labelKeys?: Set<string>;
  globals?: VariableEntry[];
}

/**
 * Indexes Cicode files, labels.DBF and locvar.DBF tables: function
 * definitions, variable declarations and labels, with their locations.
 * Every map is keyed by nameKey: names ignore the case of ASCII letters
 * only, as the compiler does. Definitions are stored per source file; a
 * lookup sees those of the projects compiled together with the asking file
 * (see ProjectGraph), including projects outside the workspace, which are
 * read from disk.
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
  // Per-project resolved views (visibleKey -> names), dropped on any change.
  private readonly _views = new Map<string, ScopeView>();

  private readonly variableCache = new Map<string, VariableEntry[]>();
  private readonly functionRangesByFile = new Map<string, FunctionRange[]>();
  private readonly _ignoreSpansByFile = new Map<string, FileIgnoreSpans>();

  // Reverse indexes for O(1) file purge instead of O(n) iteration
  private readonly _functionKeysByFile = new Map<string, Set<string>>();
  private readonly _variableKeysByFile = new Map<string, Set<string>>();
  private readonly _labelKeysByFile = new Map<string, Set<string>>();
  // Indexed source files per folder (projectKey of the folder).
  private readonly _filesByFolder = new Map<string, Set<string>>();
  // Indexed source files by lower-case path (foldCase only).
  private readonly _fileByLowerPath = new Map<string, string>();

  // Content fingerprint of the last indexed text per file. Opening a document
  // (e.g. diagnostics iterating the workspace) fires onDidOpenTextDocument;
  // without this guard every such open re-indexes unchanged content and fires
  // onIndexed, cascading into another diagnostics run per file.
  private readonly _indexedTextHash = new Map<string, string>();

  // labels.DBF tables read from outside the workspace (the Include project).
  private _externalLabelFiles: string[] = [];
  private _graph = ProjectGraph.empty();
  // Out-of-workspace projects being indexed (external and loose ones):
  // project key -> watchers.
  private readonly _external = new Map<string, vscode.Disposable[]>();
  // Folders of .ci files opened from outside the workspace (projectKey ->
  // folder): indexed with the projects they compile with.
  private readonly _loose = new Map<string, string>();
  private _masterWatchers: vscode.Disposable[] = [];
  private _masterWatchKey = "";
  private _refreshRetries = 0;

  private readonly _onIndexed = new vscode.EventEmitter<string | undefined>();
  /** Fires after indexing completes. Carries the source file path for
   *  single-file reindex (a .ci file, or a labels.DBF/locvar.DBF path),
   *  undefined for full rebuild and for project graph changes. */
  readonly onIndexed = this._onIndexed.event;

  // Monotonic version counter so a superseded buildAll can bail out instead
  // of racing a newer build (duplicating locvar entries, corrupting flags).
  private _buildVersion = 0;
  // Same for project graph refreshes, which also yield to any buildAll.
  private _graphVersion = 0;
  private _building = false;
  private _graphStale = false;

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
  private readonly _debouncedRefreshProjects: Debounced<() => void>;
  private readonly _debouncedBuildAll: Debounced<() => void>;

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
        // Its folder may have left the out-of-workspace set since the edit:
        // it becomes a loose project instead of an orphan.
        this._noteLoose(doc.uri);
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
    // include.DBF and MASTER.DBF are rewritten in bursts (Studio, compiles).
    this._debouncedRefreshProjects = debounce(() => {
      void this._refreshProjects().catch((e) =>
        error("project graph refresh failed", e),
      );
    }, 1000);
    this._debouncedBuildAll = debounce(() => {
      void this.buildAll().catch((e) => error("index rebuild failed", e));
    }, 1000);

    const labelsWatcher =
      vscode.workspace.createFileSystemWatcher(LABELS_DBF_GLOB);
    const locvarWatcher =
      vscode.workspace.createFileSystemWatcher(LOCVAR_DBF_GLOB);
    const includeWatcher =
      vscode.workspace.createFileSystemWatcher(INCLUDE_DBF_GLOB);
    // .ci files edited outside VS Code (AVEVA editors, git, Explorer) never
    // raise TextDocument events for unopened files.
    const ciWatcher = vscode.workspace.createFileSystemWatcher(CI_FILE_GLOB);
    // A source appearing in or leaving a folder may add or drop a project.
    const andProjects = (reindex: (p: string) => void) => (uri: vscode.Uri) => {
      reindex(uri.fsPath);
      this._debouncedRefreshProjects();
    };
    const refreshProjects = () => this._debouncedRefreshProjects();
    context.subscriptions.push(
      ciWatcher,
      ciWatcher.onDidChange((uri) => this._debouncedSyncFromDisk(uri.fsPath)),
      ciWatcher.onDidCreate(andProjects(this._debouncedSyncFromDisk)),
      ciWatcher.onDidDelete(andProjects(this._debouncedSyncFromDisk)),
      labelsWatcher,
      labelsWatcher.onDidChange((uri) =>
        this._debouncedReindexLabels(uri.fsPath),
      ),
      labelsWatcher.onDidCreate(andProjects(this._debouncedReindexLabels)),
      labelsWatcher.onDidDelete(andProjects(this._debouncedReindexLabels)),
      locvarWatcher,
      locvarWatcher.onDidChange((uri) =>
        this._debouncedReindexLocvar(uri.fsPath),
      ),
      locvarWatcher.onDidCreate(andProjects(this._debouncedReindexLocvar)),
      locvarWatcher.onDidDelete(andProjects(this._debouncedReindexLocvar)),
      includeWatcher,
      includeWatcher.onDidChange(refreshProjects),
      includeWatcher.onDidCreate(refreshProjects),
      includeWatcher.onDidDelete(refreshProjects),
      vscode.workspace.onDidSaveTextDocument((d) => this._maybeIndex(d)),
      vscode.workspace.onDidOpenTextDocument((d) => this._maybeIndex(d)),
      vscode.workspace.onDidChangeTextDocument((e) =>
        this._maybeIndex(e.document),
      ),
      vscode.workspace.onDidDeleteFiles((e) => {
        e.files.forEach((f) => this._purgePath(f.fsPath));
        this._debouncedRefreshProjects();
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        e.files.forEach(({ oldUri, newUri }) =>
          this._movePath(oldUri.fsPath, newUri.fsPath),
        );
        this._debouncedRefreshProjects();
      }),
      // New or removed folders bring or take whole workspace projects.
      vscode.workspace.onDidChangeWorkspaceFolders(() =>
        this._debouncedBuildAll(),
      ),
      // extension.ts rebuilds the index when cicode.indexing.includeProjectPath
      // or cicode.avevaPath (both steer the MASTER.DBF and Include lookup)
      // changes.
      { dispose: () => this._disposeProjectWatchers() },
    );
  }

  /** The projects and compile units the lookups are scoped by. */
  get projects(): ProjectGraph {
    return this._graph;
  }

  /** A file of a project outside the workspace, indexed read-only from
   *  disk (never diagnosed, renamed or scanned for references). */
  isExternal(file: string): boolean {
    return this._graph.isExternal(file);
  }

  /** Build the index for all workspace sources and the projects outside
   *  the workspace that are compiled together with them. */
  async buildAll(): Promise<void> {
    const version = ++this._buildVersion;
    this._building = true;
    try {
      await this._buildAll(version);
    } finally {
      if (version === this._buildVersion) {
        this._building = false;
        if (this._graphStale) {
          this._graphStale = false;
          this._debouncedRefreshProjects();
        }
      }
    }
  }

  private async _buildAll(version: number): Promise<void> {
    this._debouncedBuildAll.cancel();
    // This build reads every table: a refresh asked for before is moot.
    this._debouncedRefreshProjects.cancel();
    this._refreshRetries = 0;
    this.builtinFunctions.clear();
    this._ciDefs.clear();
    this._macroDefs.clear();
    this._constDefs.clear();
    this._ciView.clear();
    this._macroView.clear();
    this.labelCache.clear();
    this._mergedFunctions = null;
    this._views.clear();
    this.variableCache.clear();
    this.functionRangesByFile.clear();
    this._functionKeysByFile.clear();
    this._variableKeysByFile.clear();
    this._labelKeysByFile.clear();
    this._filesByFolder.clear();
    this._fileByLowerPath.clear();
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

    // Superseded by a newer buildAll.
    const superseded = () => version !== this._buildVersion;
    const ws = await this._findWorkspaceSources();
    if (superseded()) return;
    const explicit = this._includeSetting();
    if (
      explicit &&
      !isDir(/\.dbf$/i.test(explicit) ? path.dirname(explicit) : explicit)
    ) {
      warn("no folder at cicode.indexing.includeProjectPath", explicit);
    }
    this._seedLoose();
    // The first graph is kept even when a table was being rewritten (its
    // units count as incomplete); a refresh reads it again after the build,
    // since tables outside the workspace are not all watched.
    const built = this._buildGraph(ws.folders, ws.partial);
    if (!built.ok) this._graphStale = true;
    this._setGraph(built.graph);
    for (const k of [...this._external.keys()]) this._unwatchExternal(k);
    const ext = await this._externalSources(this._diskFolders(), superseded);
    if (superseded()) return;

    const done = await this._indexSources(
      {
        ci: [...ws.ci, ...ext.ci],
        labels: [...ws.labels, ...ext.labels],
        locvar: [...ws.locvar, ...ext.locvar],
      },
      superseded,
    );
    if (!done) return;
    this._onIndexed.fire(undefined);
    this._fireLoose();
  }

  /** Index sources, labels first (the compiler expands them before anything
   *  else); false when superseded midway. Files `wanted` rejects by then
   *  are skipped. */
  private async _indexSources(
    src: Sources,
    superseded: () => boolean,
    wanted: (file: string) => boolean = () => true,
  ): Promise<boolean> {
    for (const f of src.labels) if (wanted(f)) this._indexLabels(f);
    for (const file of src.ci) {
      if (!wanted(file)) continue;
      try {
        await this._indexPath(vscode.Uri.file(file), true);
      } catch (e) {
        error("index fail", file, e);
      }
      // Superseded: the newer build owns the caches.
      if (superseded()) return false;
    }
    for (const f of src.locvar) if (wanted(f)) this._indexLocvar(f);
    return true;
  }

  /** Workspace sources, the folders holding them (include.DBF too), and
   *  the folders of .ci files excludePatterns hides. */
  private async _findWorkspaceSources(): Promise<
    Sources & { folders: string[]; partial: string[] }
  > {
    const hidden: vscode.Uri[] = [];
    const [ci, labels, locvar, include] = await Promise.all(
      [CI_FILE_GLOB, LABELS_DBF_GLOB, LOCVAR_DBF_GLOB, INCLUDE_DBF_GLOB].map(
        async (g) =>
          (
            await findWorkspaceFiles(
              g,
              this.cfg,
              g === CI_FILE_GLOB ? hidden : undefined,
            )
          ).map((u) => u.fsPath),
      ),
    );
    const folders = new Set<string>();
    for (const f of [...ci, ...labels, ...locvar, ...include]) {
      folders.add(path.dirname(f));
    }
    const partial = [...new Set(hidden.map((u) => path.dirname(u.fsPath)))];
    return { ci, labels, locvar, folders: [...folders], partial };
  }

  private _includeSetting(): string | undefined {
    return (
      this.cfg()
        .get<string>("cicode.indexing.includeProjectPath", "")
        ?.trim() || undefined
    );
  }

  private _buildGraph(
    sourceFolders: string[],
    partialFolders: string[],
  ): GraphBuild {
    return buildProjectGraph({
      workspaceFolders: (vscode.workspace.workspaceFolders ?? [])
        .filter((f) => f.uri.scheme === "file")
        .map((f) => f.uri.fsPath),
      sourceFolders,
      partialFolders,
      looseFolders: [...this._loose.values()],
      includeProjectPath: this._includeSetting(),
      avevaPath:
        this.cfg().get<string>("cicode.avevaPath", "")?.trim() || undefined,
    });
  }

  private _setGraph(graph: ProjectGraph): void {
    this._graph = graph;
    this._views.clear();
    this._watchMasters();
  }

  /** Projects read from disk: the external ones and the loose ones. */
  private _diskFolders(): ProjectInfo[] {
    return [...this._graph.externalFolders(), ...this._graph.looseProjects()];
  }

  /** Folders of the .ci documents open now (the graph ignores those of the
   *  workspace); folders whose files were closed since are dropped. */
  private _seedLoose(): void {
    this._loose.clear();
    for (const d of vscode.workspace.textDocuments) {
      if (d.uri.scheme !== "file" || sourceKind(d.uri.fsPath) !== "ci") {
        continue;
      }
      const dir = path.dirname(d.uri.fsPath);
      this._loose.set(projectKey(dir), dir);
    }
  }

  /** A .ci file opened from outside the workspace brings its project and
   *  the projects compiled with it (graph refresh). */
  private _noteLoose(uri: vscode.Uri): void {
    if (uri.scheme !== "file") return;
    const dir = path.dirname(uri.fsPath);
    const key = projectKey(dir);
    if (this._loose.has(key) || this._external.has(key)) return;
    if (this._graph.projectOf(uri.fsPath).inWorkspace) return;
    this._loose.set(key, dir);
    this._debouncedRefreshProjects();
  }

  /** Announce the open files of loose projects one by one: onIndexed
   *  (undefined) consumers go over the workspace only. */
  private _fireLoose(): void {
    const loose = new Set(this._graph.looseProjects().map((p) => p.key));
    if (!loose.size) return;
    for (const d of vscode.workspace.textDocuments) {
      const f = d.uri.fsPath;
      if (
        d.uri.scheme === "file" &&
        this._indexedTextHash.has(f) &&
        loose.has(this._graph.visibleKey(f))
      ) {
        this._onIndexed.fire(f);
      }
    }
  }

  /**
   * Rebuild the project graph after include.DBF, MASTER.DBF, project folder
   * or loose file changes. A table cut short is read again a few times, as
   * tables outside the workspace are not all watched, then taken as read
   * (its units incomplete), unless it is a MASTER.DBF: the previous graph
   * stays. A changed graph replaces the previous one, the projects that
   * joined the out-of-workspace set are indexed and those that left it
   * dropped. onIndexed(undefined) fires once when what the workspace
   * compiles with changed; other registrations (a probe rig's) swap the
   * graph silently. The open files of loose projects are announced.
   */
  private async _refreshProjects(): Promise<void> {
    this._debouncedRefreshProjects.cancel(); // covered by this one
    if (this._building) {
      this._graphStale = true; // buildAll reschedules when done
      return;
    }
    const version = this._buildVersion;
    const graphVersion = ++this._graphVersion;
    const superseded = () =>
      version !== this._buildVersion || graphVersion !== this._graphVersion;

    const ws = await this._findWorkspaceSources();
    if (superseded()) return;
    const built = this._buildGraph(ws.folders, ws.partial);
    if (built.ok) {
      this._refreshRetries = 0;
    } else if (++this._refreshRetries < REFRESH_RETRIES) {
      this._debouncedRefreshProjects();
      return;
    } else {
      this._refreshRetries = 0;
      if (!built.mastersOk) return;
    }
    let any = built.graph.signature !== this._graph.signature;
    let all =
      any && built.graph.workspaceSignature !== this._graph.workspaceSignature;
    const implicit =
      any && built.graph.implicitSignature !== this._graph.implicitSignature;
    if (any) this._setGraph(built.graph);
    // Folders join or leave under the same graph only after an unforeseen
    // interruption: announce everything then.
    const same = !any;

    const now = new Map(this._diskFolders().map((p) => [p.key, p]));
    for (const key of [...this._external.keys()]) {
      if (now.has(key)) continue;
      any = true;
      all ||= same;
      this._unwatchExternal(key);
      // A folder that became a workspace project keeps its files.
      if (this._graph.project(key)?.inWorkspace) continue;
      for (const f of [...(this._filesByFolder.get(key) ?? [])]) {
        this._purgeFile(f, false);
      }
    }
    const joined = [...now.values()].filter((p) => !this._external.has(p.key));
    if (joined.length) {
      any = true;
      all ||= same;
      // Finished even when a newer refresh starts, which sees these folders
      // as joined already; only a buildAll takes over.
      const rebuilt = () => version !== this._buildVersion;
      const ext = await this._externalSources(joined, rebuilt);
      const done =
        !rebuilt() &&
        (await this._indexSources(ext, rebuilt, (f) =>
          this._external.has(projectKey(path.dirname(f))),
        ));
      if (!done) return;
    }
    if (all) {
      this._onIndexed.fire(undefined);
    } else if (implicit) {
      // Include or System in the workspace sees every unit: only what
      // their own files see changed.
      for (const p of this._graph.projects) {
        if (!p.inWorkspace || !this._graph.isImplicit(p.key)) continue;
        for (const f of this.projectSourceFiles(p.key)) {
          this._onIndexed.fire(f);
        }
      }
    }
    if (any) this._fireLoose();
  }

  /** Watch and list the sources of out-of-workspace projects, until
   *  `superseded`. The compiler reads only a project's own folder, so
   *  subfolders are skipped. */
  private async _externalSources(
    projects: readonly { key: string; folder: string }[],
    superseded: () => boolean,
  ): Promise<Sources> {
    const out: Sources = { ci: [], labels: [], locvar: [] };
    for (const p of projects) {
      if (superseded()) break;
      // A newer graph (an overlapping refresh) may have dropped it.
      if (!this._diskFolders().some((d) => d.key === p.key)) continue;
      const folder = diskSpelling(p.folder);
      const watchers = this._watchExternal(folder);
      this._unwatchExternal(p.key);
      this._external.set(p.key, watchers);
      let entries: [string, vscode.FileType][] = [];
      try {
        entries = await vscode.workspace.fs.readDirectory(
          vscode.Uri.file(folder),
        );
      } catch {
        continue; // gone; the MASTER.DBF watcher brings the next graph
      }
      if (superseded()) {
        // The newer build lists and watches it (its reset disposed ours).
        if (this._external.get(p.key) === watchers) {
          this._unwatchExternal(p.key);
        }
        break;
      }
      for (const [name, type] of entries.sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        const kind = (type & vscode.FileType.File) !== 0 && sourceKind(name);
        if (kind) {
          out[kind].push(vscode.Uri.file(path.join(folder, name)).fsPath);
        }
      }
    }
    return out;
  }

  /** Non-recursive watcher on an out-of-workspace project folder. */
  private _watchExternal(folder: string): vscode.Disposable[] {
    try {
      const w = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(folder), "*"),
      );
      const route = (uri: vscode.Uri) => {
        const p = uri.fsPath;
        switch (sourceKind(p)) {
          case "ci":
            return this._debouncedSyncFromDisk(p);
          case "labels":
            return this._debouncedReindexLabels(p);
          case "locvar":
            return this._debouncedReindexLocvar(p);
        }
        if (isIncludeDbf(p)) this._debouncedRefreshProjects();
      };
      // Whether Include holds sources decides whether units are complete.
      const andProjects = (uri: vscode.Uri) => {
        route(uri);
        if (sourceKind(uri.fsPath)) this._debouncedRefreshProjects();
      };
      return [
        w,
        w.onDidChange(route),
        w.onDidCreate(andProjects),
        w.onDidDelete(andProjects),
      ];
    } catch (e) {
      error("cannot watch", folder, e);
      return [];
    }
  }

  private _unwatchExternal(key: string): void {
    for (const d of this._external.get(key) ?? []) d.dispose();
    this._external.delete(key);
  }

  /** Watch the MASTER.DBF of every User folder the graph was built from:
   *  projects are registered, removed and renamed there. */
  private _watchMasters(): void {
    const dirs = this._graph.userFolders;
    const key = dirs.map(projectKey).join("|");
    if (key === this._masterWatchKey) return;
    for (const d of this._masterWatchers) d.dispose();
    this._masterWatchers = [];
    this._masterWatchKey = key;
    const refresh = () => this._debouncedRefreshProjects();
    for (const dir of dirs) {
      try {
        const w = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(dir), MASTER_DBF_PATTERN),
        );
        this._masterWatchers.push(
          w,
          w.onDidChange(refresh),
          w.onDidCreate(refresh),
          w.onDidDelete(refresh),
        );
      } catch (e) {
        error("cannot watch", dir, e);
      }
    }
  }

  private _disposeProjectWatchers(): void {
    for (const k of [...this._external.keys()]) this._unwatchExternal(k);
    for (const d of this._masterWatchers) d.dispose();
    this._masterWatchers = [];
    this._masterWatchKey = "";
  }

  private _indexLabels(filePath: string): void {
    this._purgeFile(filePath, false);
    const records = parseLabelsDbf(filePath);
    if (records.length) this._track(filePath);
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
    this._views.clear();
  }

  private _indexLocvar(filePath: string): void {
    this._purgeFile(filePath, false);
    const records = parseLocvarDbf(filePath);
    if (records.length) this._track(filePath);
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
    this._views.clear();
  }

  private _reindexLocvarFile(filePath: string): void {
    filePath = this._indexedAs(filePath);
    if (!this._inScope(filePath)) return;
    this._indexLocvar(filePath);
    this._onIndexed.fire(filePath);
  }

  private _reindexLabelsFile(filePath: string): void {
    filePath = this._indexedAs(filePath);
    if (!this._inScope(filePath)) return;
    this._indexLabels(filePath);
    this._onIndexed.fire(filePath);
  }

  private _maybeIndex(doc: vscode.TextDocument): void {
    if (!doc || !isIndexableUri(doc.uri)) return;
    if (sourceKind(doc.uri.fsPath) !== "ci") return;
    this._noteLoose(doc.uri);
    this._debouncedIndex(doc);
  }

  /** The path a file is indexed under when it is reached by another
   *  spelling (Windows paths ignore case), else the path itself. */
  private _indexedAs(file: string): string {
    return (foldCase && this._fileByLowerPath.get(file.toLowerCase())) || file;
  }

  /** The open document of a file, also under another spelling. */
  private _openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
    const doc = findOpenDocument(uri);
    if (doc || !foldCase) return doc;
    const lower = uri.fsPath.toLowerCase();
    return vscode.workspace.textDocuments.find(
      (d) =>
        d.uri.scheme === uri.scheme && d.uri.fsPath.toLowerCase() === lower,
    );
  }

  /** Re-sync one .ci file after it changed on disk. Cheap when nothing
   *  changed: open documents and unchanged bytes hit the content-hash guard. */
  private async _syncFromDisk(fsPath: string): Promise<void> {
    fsPath = this._indexedAs(fsPath);
    const uri = vscode.Uri.file(fsPath);
    const known = this._indexedTextHash.has(fsPath);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      // Deleted (in-app deletes/renames were already purged by their events)
      if (known) this._purgeFile(fsPath);
      return;
    }
    if (!known && !this._inScope(fsPath)) return;
    // excludePatterns are workspace-relative: they never apply to projects
    // read from disk.
    if (
      !known &&
      !this._external.has(projectKey(path.dirname(fsPath))) &&
      this._isExcluded(uri)
    ) {
      return;
    }
    await this._indexPath(uri);
  }

  /** A source the index keeps: under a workspace folder, or in a project
   *  read from disk. A change queued for a folder that has left the
   *  out-of-workspace set since is dropped. */
  private _inScope(file: string): boolean {
    return (
      this._external.has(projectKey(path.dirname(file))) ||
      this._graph.underWorkspace(file)
    );
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

  /** Record an indexed source under its folder's project key. */
  private _track(file: string): void {
    if (!path.isAbsolute(file)) return;
    const key = projectKey(path.dirname(file));
    let s = this._filesByFolder.get(key);
    if (!s) this._filesByFolder.set(key, (s = new Set()));
    s.add(file);
    if (foldCase) this._fileByLowerPath.set(file.toLowerCase(), file);
  }

  private _untrack(file: string): void {
    if (!path.isAbsolute(file)) return;
    const key = projectKey(path.dirname(file));
    const s = this._filesByFolder.get(key);
    if (s?.delete(file) && !s.size) this._filesByFolder.delete(key);
    const lower = file.toLowerCase();
    if (this._fileByLowerPath.get(lower) === file) {
      this._fileByLowerPath.delete(lower);
    }
  }

  /** The indexed .ci files of the project folder keyed `key`
   *  (projectKey), in compile order (upper-case names). */
  projectSourceFiles(key: string): string[] {
    const upper = (f: string) => path.basename(f).toUpperCase();
    return [...(this._filesByFolder.get(key) ?? [])]
      .filter((f) => sourceKind(f) === "ci")
      .sort((a, b) => (upper(a) < upper(b) ? -1 : upper(a) > upper(b) ? 1 : 0));
  }

  /** Purge all cache entries owned by a file. Definitions of the same names
   *  in other files take over automatically. */
  private _purgeFile(file: string, fireEvent = true): void {
    this._indexedTextHash.delete(file);
    this._untrack(file);

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

  /** All indexed file paths located under a directory (paths compare
   *  case-insensitively, like the file system). */
  private _indexedFilesUnder(dir: string): string[] {
    const prefix = (dir + path.sep).toLowerCase();
    const files = new Set<string>();
    for (const keys of [
      this._functionKeysByFile.keys(),
      this._variableKeysByFile.keys(),
      this._labelKeysByFile.keys(),
      this.functionRangesByFile.keys(),
      this._ignoreSpansByFile.keys(),
    ]) {
      for (const f of keys) {
        if (f.toLowerCase().startsWith(prefix)) files.add(f);
      }
    }
    return [...files];
  }

  /** Purge a deleted path: a single file, or every indexed file under a folder
   *  (VS Code fires one event with the folder URI for folder deletes). */
  private _purgePath(fsPath: string): void {
    const children = this._indexedFilesUnder(fsPath);
    if (children.length) for (const f of children) this._purgeFile(f);
    else this._purgeFile(this._indexedAs(fsPath));
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
      this._moveFile(this._indexedAs(oldPath), newPath);
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
   *  and otherwise reading it from disk. `quiet` (bulk indexing, announced
   *  once at the end): no onIndexed(file). */
  private async _indexPath(uri: vscode.Uri, quiet = false): Promise<void> {
    const openDoc = this._openDocument(uri);
    if (openDoc) {
      await this._indexFile(openDoc, quiet);
      return;
    }
    const file = this._indexedAs(uri.fsPath);
    if (file !== uri.fsPath) uri = vscode.Uri.file(file);
    const text = await readSourceText(uri);
    await this._indexFile(new FileDocument(uri, text), quiet);
  }

  private async _indexFile(
    doc: IndexableDocument,
    quiet = false,
  ): Promise<void> {
    const file = doc.uri.fsPath;
    const text = doc.getText();

    // No-op when the content is what we already indexed (see _indexedTextHash).
    const hash = `${text.length}:${fnv1a(text)}`;
    if (this._indexedTextHash.get(file) === hash) return;

    // Indexed under another spelling: the open document's takes over.
    const was = this._indexedAs(file);
    if (was !== file) this._purgeFile(was, !quiet);
    this._purgeFile(file, false);
    this._indexedTextHash.set(file, hash);
    this._track(file);
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
    this._views.clear();

    if (!quiet) this._onIndexed.fire(file);
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
    this._debouncedRefreshProjects.cancel();
    this._debouncedBuildAll.cancel();
    this._disposeProjectWatchers();
    this._onIndexed.dispose();
  }
}
