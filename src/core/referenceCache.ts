import * as path from "path";
import * as vscode from "vscode";
import type { Indexer } from "./indexer/indexer";
import {
  buildLineIndex,
  lineAtOffset,
  nameKey,
  type LineIndex,
} from "../shared/textUtils";
import { KEYWORDS, lex } from "./indexer/lexer";
import {
  debounce,
  debouncePerKey,
  error,
  type Debounced,
  type PerKeyDebounced,
} from "../shared/utils";
import { CI_FILE_GLOB } from "../shared/globs";
import { findOpenDocument, readSourceText } from "./indexer/sourceText";
import { findWorkspaceFiles } from "../config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single occurrence of a symbol in a file */
export interface RawReference {
  readonly file: string;
  readonly offset: number;
  readonly length: number;
}

/** All references for a single symbol */
export interface SymbolReferences {
  readonly symbolName: string;
  refs: RawReference[];
  count: number;
}

// ---------------------------------------------------------------------------
// ReferenceCache
// ---------------------------------------------------------------------------

/**
 * Pre-computes and caches function reference locations across all workspace
 * files.  Builds in the background after the indexer finishes, then updates
 * incrementally when individual files change.
 */
export class ReferenceCache implements vscode.Disposable {
  // symbol name (nameKey) → all references
  private readonly symbolRefs = new Map<string, SymbolReferences>();

  // file path → set of symbol names (nameKey) that are referenced in that file
  private readonly fileIndex = new Map<string, Set<string>>();

  // Monotonic version counter, incremented on every build/update so stale
  // async work can detect it has been superseded.
  private _buildVersion = 0;

  private _isReady = false;
  get isReady(): boolean {
    return this._isReady;
  }

  private readonly _onCacheUpdated = new vscode.EventEmitter<void>();
  readonly onCacheUpdated = this._onCacheUpdated.event;

  private readonly _disposables: vscode.Disposable[] = [];

  private readonly _debouncedHandleChange: PerKeyDebounced<
    (file: string) => void
  >;

  // Track the set of known function names so we can detect additions/removals
  private _knownFunctions = new Set<string>();

  // True while a full build runs; incremental updates are deferred until then.
  private _fullBuildInProgress = false;
  private readonly _pendingChanges = new Set<string>();

  // Serializes incremental updates so concurrent per-key handlers can never
  // overlap and drop or duplicate references mid-flight.
  private _updateChain: Promise<void> = Promise.resolve();

  // Newly discovered function names awaiting a deferred workspace-wide scan.
  private readonly _pendingNewSymbols = new Set<string>();
  // Names whose deferred workspace-wide scan is running right now.
  private readonly _scanningSymbols = new Set<string>();
  private readonly _debouncedScanNewSymbols: Debounced<() => void>;

  constructor(
    private readonly indexer: Indexer,
    private readonly cfg: () => vscode.WorkspaceConfiguration,
  ) {
    this._debouncedHandleChange = debouncePerKey(
      (file: string) => {
        this._updateChain = this._updateChain
          .then(() => this._handleFileChanged(file))
          .catch((e) => error("reference cache update failed", file, e));
      },
      500,
      (file) => file,
    );
    this._debouncedScanNewSymbols = debounce(() => {
      this._updateChain = this._updateChain
        .then(() => this._scanForNewSymbols())
        .catch((e) => error("reference cache scan failed", e));
    }, 2000);

    // After each indexer pass, update the cache
    this._disposables.push(
      indexer.onIndexed((file) => {
        if (file === undefined) {
          // Full rebuild (e.g. buildAll / reindex-all command)
          this._buildAll();
        } else {
          this._debouncedHandleChange(file);
        }
      }),
    );

    // File deletions: purge immediately (the indexer fires onIndexed too;
    // _handleFileChanged skips the rescan once the indexer has dropped the
    // file, so a lingering TextDocument can't re-add its references).
    this._disposables.push(
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const f of e.files) {
          this._purgePath(f.fsPath);
        }
        this._onCacheUpdated.fire();
      }),
    );

    // File renames: update paths in cached references
    this._disposables.push(
      vscode.workspace.onDidRenameFiles((e) => {
        for (const { oldUri, newUri } of e.files) {
          this._renamePath(oldUri.fsPath, newUri.fsPath);
        }
        this._onCacheUpdated.fire();
      }),
    );
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** Get all references for a function name (case-insensitive). Undefined
   *  while a newly added function's workspace scan is still pending; its
   *  cached refs cover only the files changed so far, so callers should use
   *  their live-scan fallback. */
  getReferences(symbolName: string): SymbolReferences | undefined {
    const key = nameKey(symbolName);
    if (this._pendingNewSymbols.has(key) || this._scanningSymbols.has(key)) {
      return undefined;
    }
    return this.symbolRefs.get(key);
  }

  /** Get reference count for a function name. Returns 0 if not cached. */
  getReferenceCount(symbolName: string): number {
    return this.symbolRefs.get(nameKey(symbolName))?.count ?? 0;
  }

  /** Convert raw references to `vscode.Location` objects. */
  async toLocations(
    refs: ReadonlyArray<RawReference>,
  ): Promise<vscode.Location[]> {
    const byFile = new Map<string, RawReference[]>();
    for (const r of refs) {
      let arr = byFile.get(r.file);
      if (!arr) {
        arr = [];
        byFile.set(r.file, arr);
      }
      arr.push(r);
    }

    const locations: vscode.Location[] = [];
    for (const [file, fileRefs] of byFile) {
      const uri = vscode.Uri.file(file);
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        continue;
      }
      for (const r of fileRefs) {
        const start = doc.positionAt(r.offset);
        const end = doc.positionAt(r.offset + r.length);
        locations.push(new vscode.Location(uri, new vscode.Range(start, end)));
      }
    }
    return locations;
  }

  /** Force a full rebuild (e.g. triggered by reindex-all command). */
  rebuildAll(): void {
    this._buildAll();
  }

  dispose(): void {
    this._debouncedHandleChange.cancelAll();
    this._debouncedScanNewSymbols.cancel();
    for (const d of this._disposables) d.dispose();
    this._onCacheUpdated.dispose();
  }

  // =========================================================================
  // Full build
  // =========================================================================

  private async _buildAll(): Promise<void> {
    const version = ++this._buildVersion;
    this.symbolRefs.clear();
    this.fileIndex.clear();
    this._isReady = false;
    this._fullBuildInProgress = true;
    this._pendingChanges.clear();
    this._pendingNewSymbols.clear(); // the full build covers everything

    const functionNames = this._collectFunctionNames();
    this._knownFunctions = new Set(functionNames);

    const files = await findWorkspaceFiles(CI_FILE_GLOB, this.cfg);

    const BATCH_SIZE = 10;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      if (this._buildVersion !== version) return; // superseded by another _buildAll
      const batch = files.slice(i, i + BATCH_SIZE);
      for (const uri of batch) {
        await this._scanFile(
          uri,
          functionNames,
          () => this._buildVersion !== version,
        );
      }
      // Update counts and notify after each batch so CodeLens shows progress
      this._finalizeCounts();
      this._onCacheUpdated.fire();
      // Yield to event loop between batches
      await new Promise<void>((r) => setTimeout(r, 0));
    }

    if (this._buildVersion !== version) return;
    this._fullBuildInProgress = false;
    this._isReady = true;
    this._onCacheUpdated.fire();

    // Drain any file changes that arrived during the full build
    if (this._pendingChanges.size > 0) {
      const pending = [...this._pendingChanges];
      this._pendingChanges.clear();
      for (const file of pending) {
        this._debouncedHandleChange(file);
      }
    }
  }

  // =========================================================================
  // Incremental update
  // =========================================================================

  private async _handleFileChanged(changedFile: string): Promise<void> {
    // Defer incremental updates while a full build is running: the build
    // scans everything anyway, and incrementing _buildVersion here would
    // cancel it, leaving _isReady permanently false.
    if (this._fullBuildInProgress) {
      this._pendingChanges.add(changedFile);
      return;
    }

    const version = ++this._buildVersion;
    // A full build may start while we're awaiting; its scans cover
    // everything, so any further incremental work would duplicate refs.
    const isStale = () =>
      this._buildVersion !== version || this._fullBuildInProgress;

    // Purge references sourced from the changed file
    this._purgeReferencesFromFile(changedFile);

    // Detect newly added / removed functions
    const currentFunctions = this._collectFunctionNames();
    const newSymbols = new Set<string>();
    for (const fn of currentFunctions) {
      if (!this._knownFunctions.has(fn)) newSymbols.add(fn);
    }
    // Remove symbols that no longer exist
    for (const sym of this._knownFunctions) {
      if (!currentFunctions.has(sym)) this.symbolRefs.delete(sym);
    }
    this._knownFunctions = new Set(currentFunctions);

    // Re-scan the changed file for all known function names. Skip non-.ci
    // sources (labels.DBF / locvar.DBF reindexes); word-scanning a DBF
    // would insert bogus references; only the symbol diff above matters.
    // Also skip files the indexer no longer knows (deleted, or renamed
    // away): their TextDocument may linger and would re-add references.
    // Files of projects outside the workspace are never scanned.
    if (
      changedFile.toLowerCase().endsWith(".ci") &&
      this.indexer.getIgnoreSpans(changedFile) !== undefined &&
      !this.indexer.isExternal(changedFile)
    ) {
      try {
        const uri = vscode.Uri.file(changedFile);
        if (isStale()) return;
        await this._scanFile(uri, currentFunctions, isStale);
      } catch {
        /* file may have been deleted */
      }
      if (isStale()) return;
    }

    // For newly added function names, defer a batched workspace-wide scan.
    // While a name is being typed/renamed each indexing pause surfaces a
    // transient "new" function; scanning every file per pause is wasteful,
    // so let the name settle first.
    if (newSymbols.size > 0) {
      for (const sym of newSymbols) this._pendingNewSymbols.add(sym);
      this._debouncedScanNewSymbols();
    }

    if (isStale()) return;
    this._finalizeCounts();
    this._onCacheUpdated.fire();
  }

  /** Deferred workspace-wide scan for recently added function names. */
  private async _scanForNewSymbols(): Promise<void> {
    if (this._fullBuildInProgress) return; // full build scans everything

    // Drop transient names (e.g. partials seen while a name was being typed)
    const symbols = new Set<string>();
    for (const sym of this._pendingNewSymbols) {
      if (this._knownFunctions.has(sym)) symbols.add(sym);
    }
    this._pendingNewSymbols.clear();
    if (symbols.size === 0) return;

    // Snapshot (do NOT increment: that would cancel in-flight incremental
    // updates whose files were already purged). Incremental updates are
    // serialized with this scan on _updateChain, so only a full build can
    // make it stale, and that build covers these symbols, so just stop.
    const version = this._buildVersion;
    const isStale = () =>
      this._buildVersion !== version || this._fullBuildInProgress;

    for (const sym of symbols) this._scanningSymbols.add(sym);
    try {
      // Collect off to the side and swap the complete result in at the end,
      // so readers never see refs wiped mid-scan.
      const collected: Array<[string, Map<string, RawReference[]>]> = [];
      const allFiles = await findWorkspaceFiles(CI_FILE_GLOB, this.cfg);
      for (const uri of allFiles) {
        if (isStale()) return;
        const found = await this._collectFileRefs(uri, symbols, isStale);
        if (found) collected.push([uri.fsPath, found]);
      }
      if (isStale()) return;

      // Commit synchronously. Wipe refs gathered so far for these symbols
      // (the changed-file scan in _handleFileChanged already added some) so
      // the swap cannot duplicate them.
      for (const sym of symbols) {
        this.symbolRefs.delete(sym);
        for (const set of this.fileIndex.values()) set.delete(sym);
      }
      for (const [file, found] of collected) this._commitFileRefs(file, found);
    } finally {
      for (const sym of symbols) this._scanningSymbols.delete(sym);
    }
    this._finalizeCounts();
    this._onCacheUpdated.fire();
  }

  // =========================================================================
  // File scanning (single-pass word matching)
  // =========================================================================

  private async _scanFile(
    uri: vscode.Uri,
    functionNames: Set<string>,
    isStale?: () => boolean,
  ): Promise<void> {
    const found = await this._collectFileRefs(uri, functionNames, isStale);
    if (found) this._commitFileRefs(uri.fsPath, found);
  }

  /** Read a file and find its references to `functionNames` without
   *  touching the cache. Undefined when unreadable or the work went stale. */
  private async _collectFileRefs(
    uri: vscode.Uri,
    functionNames: Set<string>,
    isStale?: () => boolean,
  ): Promise<Map<string, RawReference[]> | undefined> {
    const file = uri.fsPath;
    let text: string;

    try {
      text = findOpenDocument(uri)?.getText() ?? (await readSourceText(uri));
    } catch {
      return undefined;
    }
    // The read yielded to the event loop; a newer build may have cleared
    // the cache since; don't commit stale results.
    if (isStale?.()) return undefined;

    // Offsets where function names are defined (not referenced)
    const defOffsets = new Set(
      this.indexer.getFunctionRanges(file).map((f) => f.nameOffset),
    );

    const found = new Map<string, RawReference[]>();
    const { tokens } = lex(text);
    const ranges = this.indexer.getFunctionRanges(file);
    let lineIndex: LineIndex | undefined;
    // A bare name (no call parentheses) that a variable visible at that point
    // declares is that variable, not the function.
    const isVariableUse = (name: string, offset: number): boolean => {
      lineIndex ??= buildLineIndex(text);
      const line = lineAtOffset(lineIndex, offset);
      const at = new vscode.Position(line, offset - lineIndex.starts[line]);
      const encl = ranges.find(
        (r) => offset >= r.startOffset && offset < r.endOffset,
      );
      const scope = encl ? this.indexer.localScopeId(file, encl.name) : null;
      return (
        this.indexer.resolveVariableInScope(name, file, scope, at) !== null
      );
    };
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      // A keyword is never a call, even to a function named like it, and
      // the field of a tag reference (`Tag.Field`) is not a name of its own.
      if (t.kind !== "w" || KEYWORDS.has(t.text)) continue;
      if (i > 0 && tokens[i - 1].text === ".") continue;
      const key = nameKey(t.text);
      if (!functionNames.has(key) || defOffsets.has(t.start)) continue;
      if (tokens[i + 1]?.text !== "(" && isVariableUse(t.text, t.start))
        continue;

      let refs = found.get(key);
      if (!refs) {
        refs = [];
        found.set(key, refs);
      }
      refs.push({ file, offset: t.start, length: t.end - t.start });
    }
    return found;
  }

  /** Merge one file's collected references into the cache. */
  private _commitFileRefs(
    file: string,
    found: Map<string, RawReference[]>,
  ): void {
    for (const [key, refs] of found) {
      let entry = this.symbolRefs.get(key);
      if (!entry) {
        entry = { symbolName: key, refs: [], count: 0 };
        this.symbolRefs.set(key, entry);
      }
      for (const r of refs) entry.refs.push(r);
    }

    // Merge into file index
    const existing = this.fileIndex.get(file);
    if (existing) {
      for (const s of found.keys()) existing.add(s);
    } else {
      this.fileIndex.set(file, new Set(found.keys()));
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  /** All cached file paths located under a directory. */
  private _filesUnder(dir: string): string[] {
    const prefix = dir + path.sep;
    return [...this.fileIndex.keys()].filter((f) => f.startsWith(prefix));
  }

  /** Purge a deleted path: a single file, or every cached file under a folder
   *  (VS Code fires one event with the folder URI for folder deletes). */
  private _purgePath(fsPath: string): void {
    const children = this._filesUnder(fsPath);
    if (children.length) {
      for (const f of children) this._purgeReferencesFromFile(f);
    } else {
      this._purgeReferencesFromFile(fsPath);
    }
  }

  /** Rename a path: a single file, or every cached file under a folder
   *  (VS Code fires one event with the folder URI for folder renames). */
  private _renamePath(oldPath: string, newPath: string): void {
    const children = this._filesUnder(oldPath);
    if (children.length) {
      for (const f of children) {
        this._renameFile(f, newPath + f.slice(oldPath.length));
      }
    } else {
      this._renameFile(oldPath, newPath);
    }
  }

  /** Purge all references that were sourced from a specific file. */
  private _purgeReferencesFromFile(file: string): void {
    const symbols = this.fileIndex.get(file);
    if (!symbols) return;

    for (const sym of symbols) {
      const entry = this.symbolRefs.get(sym);
      if (!entry) continue;
      entry.refs = entry.refs.filter((r) => r.file !== file);
      entry.count = entry.refs.length;
      if (entry.count === 0) this.symbolRefs.delete(sym);
    }

    this.fileIndex.delete(file);
  }

  /** Update file paths in cache after a rename. */
  private _renameFile(oldPath: string, newPath: string): void {
    const symbols = this.fileIndex.get(oldPath);
    if (!symbols) return;

    for (const sym of symbols) {
      const entry = this.symbolRefs.get(sym);
      if (!entry) continue;
      entry.refs = entry.refs.map((r) =>
        r.file === oldPath ? { ...r, file: newPath } : r,
      );
    }

    this.fileIndex.set(newPath, symbols);
    this.fileIndex.delete(oldPath);
  }

  /** Recalculate .count for all entries. */
  private _finalizeCounts(): void {
    for (const entry of this.symbolRefs.values()) {
      entry.count = entry.refs.length;
    }
  }

  /** Keys (nameKey) of every function the indexer knows (built-ins, .ci
   *  functions and label macros). */
  private _collectFunctionNames(): Set<string> {
    const names = new Set<string>();
    for (const [key] of this.indexer.getAllFunctions()) {
      names.add(key);
    }
    return names;
  }
}
