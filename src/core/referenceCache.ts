import * as vscode from "vscode";
import type { Indexer } from "./indexer/indexer";
import { buildIgnoreSpans, inSpan } from "../shared/textUtils";
import { debounce } from "../shared/utils";

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
  // symbol name (lowercase) → all references
  private readonly symbolRefs = new Map<string, SymbolReferences>();

  // file path → set of symbol names (lowercase) that are referenced in that file
  private readonly fileIndex = new Map<string, Set<string>>();

  // Monotonic version counter – incremented on every build/update so stale
  // async work can detect it has been superseded.
  private _buildVersion = 0;

  private _isReady = false;
  get isReady(): boolean {
    return this._isReady;
  }

  private readonly _onCacheUpdated = new vscode.EventEmitter<void>();
  readonly onCacheUpdated = this._onCacheUpdated.event;

  private readonly _disposables: vscode.Disposable[] = [];

  private readonly _debouncedHandleChange: (file: string) => void;

  // Track the set of known function names so we can detect additions/removals
  private _knownFunctions = new Set<string>();

  // When true, a full build is in progress incremental updates are deferred.
  private _fullBuildInProgress = false;
  private readonly _pendingChanges = new Set<string>();

  constructor(
    private readonly indexer: Indexer,
    private readonly cfg: () => vscode.WorkspaceConfiguration,
  ) {
    this._debouncedHandleChange = debounce(
      (file: string) => this._handleFileChanged(file),
      500,
    );

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

    // File deletions – purge immediately (indexer fires onIndexed too, but
    // the file is already gone so re-scanning would fail).
    this._disposables.push(
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const f of e.files) {
          this._purgeReferencesFromFile(f.fsPath);
        }
        this._onCacheUpdated.fire();
      }),
    );

    // File renames – update paths in cached references
    this._disposables.push(
      vscode.workspace.onDidRenameFiles((e) => {
        for (const { oldUri, newUri } of e.files) {
          this._renameFile(oldUri.fsPath, newUri.fsPath);
        }
        this._onCacheUpdated.fire();
      }),
    );
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /** Get all references for a function name (case-insensitive). */
  getReferences(symbolName: string): SymbolReferences | undefined {
    return this.symbolRefs.get(symbolName.toLowerCase());
  }

  /** Get reference count for a function name. Returns 0 if not cached. */
  getReferenceCount(symbolName: string): number {
    return this.symbolRefs.get(symbolName.toLowerCase())?.count ?? 0;
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

    const functionNames = this._collectFunctionNames();
    this._knownFunctions = new Set(functionNames);

    const exclude = this._getExcludeGlob();
    const files = await vscode.workspace.findFiles("**/*.ci", exclude);

    const BATCH_SIZE = 10;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      if (this._buildVersion !== version) return; // superseded by another _buildAll
      const batch = files.slice(i, i + BATCH_SIZE);
      for (const uri of batch) {
        await this._scanFile(uri, functionNames);
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
    // Defer incremental updates while a full build is running the build
    // scans everything anyway, and incrementing _buildVersion here would
    // cancel it, leaving _isReady permanently false.
    if (this._fullBuildInProgress) {
      this._pendingChanges.add(changedFile);
      return;
    }

    const version = ++this._buildVersion;

    // Purge references sourced from the changed file
    this._purgeReferencesFromFile(changedFile);

    // Detect newly added / removed functions
    const currentFunctions = this._collectFunctionNames();
    const newSymbols: string[] = [];
    for (const fn of currentFunctions) {
      if (!this._knownFunctions.has(fn)) newSymbols.push(fn);
    }
    // Remove symbols that no longer exist
    for (const sym of this._knownFunctions) {
      if (!currentFunctions.has(sym)) this.symbolRefs.delete(sym);
    }
    this._knownFunctions = new Set(currentFunctions);

    // Re-scan the changed file for all known function names
    try {
      const uri = vscode.Uri.file(changedFile);
      await this._scanFile(uri, currentFunctions);
    } catch {
      /* file may have been deleted */
    }

    // For newly added function names, scan ALL files
    if (newSymbols.length > 0) {
      const newSet = new Set(newSymbols);
      const exclude = this._getExcludeGlob();
      const allFiles = await vscode.workspace.findFiles("**/*.ci", exclude);
      for (const uri of allFiles) {
        if (this._buildVersion !== version) return;
        if (uri.fsPath === changedFile) continue;
        await this._scanFile(uri, newSet);
      }
    }

    if (this._buildVersion !== version) return;
    this._finalizeCounts();
    this._onCacheUpdated.fire();
  }

  // =========================================================================
  // File scanning (single-pass word matching)
  // =========================================================================

  private async _scanFile(
    uri: vscode.Uri,
    functionNames: Set<string>,
  ): Promise<void> {
    const file = uri.fsPath;
    let text: string;
    let ignore: Array<[number, number]> | undefined;

    // Try to use cached ignore spans from the indexer (much faster)
    ignore = this.indexer.getIgnoreSpans(file);
    if (ignore) {
      // Indexer has processed this file — use raw fs read
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        text = new TextDecoder().decode(bytes);
      } catch {
        return;
      }
    } else {
      // Fallback: file not yet indexed, use openTextDocument + compute spans
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        text = doc.getText();
      } catch {
        return;
      }
      ignore = buildIgnoreSpans(text, { includeFunctionHeaders: false });
    }

    const symbolsFoundInFile = new Set<string>();

    const wordRe = /\b[A-Za-z_]\w*\b/g;
    let m: RegExpExecArray | null;

    while ((m = wordRe.exec(text))) {
      const key = m[0].toLowerCase();
      if (!functionNames.has(key)) continue;
      if (inSpan(m.index, ignore)) continue;

      symbolsFoundInFile.add(key);

      let entry = this.symbolRefs.get(key);
      if (!entry) {
        entry = { symbolName: key, refs: [], count: 0 };
        this.symbolRefs.set(key, entry);
      }
      entry.refs.push({ file, offset: m.index, length: m[0].length });
    }

    // Merge into file index
    const existing = this.fileIndex.get(file);
    if (existing) {
      for (const s of symbolsFoundInFile) existing.add(s);
    } else {
      this.fileIndex.set(file, symbolsFoundInFile);
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

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

  /** Collect the lowercase names of all user-defined functions from the indexer. */
  private _collectFunctionNames(): Set<string> {
    const names = new Set<string>();
    for (const [key, info] of this.indexer.getAllFunctions()) {
      names.add(key);
    }
    return names;
  }

  /** Read the exclude glob from configuration. */
  private _getExcludeGlob(): string | undefined {
    const ex = this.cfg().get("cicode.indexing.excludeGlobs");
    if (Array.isArray(ex) && ex.length) return `{${ex.join(",")}}`;
    if (typeof ex === "string" && (ex as string).trim())
      return (ex as string).trim();
    return undefined;
  }
}
