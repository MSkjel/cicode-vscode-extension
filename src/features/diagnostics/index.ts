import * as path from "path";
import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import { buildIgnoreSpans } from "../../shared/textUtils";
import { getLintConfig, findWorkspaceFiles } from "../../config";
import {
  isCicodeDocument,
  error,
  getOptionalParamFlags,
} from "../../shared/utils";
import { splitParamsTopLevel } from "../../shared/parseHelpers";
import { CI_FILE_GLOB } from "../../shared/globs";
import type { CheckContext } from "./context";
import { ALL_RULES } from "./rules/index";

// Sources whose reindex changes symbols (labels, DBF-declared variables) that
// every Cicode file can reference.
const GLOBAL_SYMBOL_FILE_RE = /(?:^|[\\/])(?:labels|locvar)\.dbf$/i;

// Delay before re-checking other files after a cross-file symbol change.
const REFRESH_DELAY_MS = 1000;

export function registerDiagnostics(
  indexer: Indexer,
  cfg: () => vscode.WorkspaceConfiguration,
): vscode.DiagnosticCollection {
  const coll = vscode.languages.createDiagnosticCollection("cicode");
  let indexingReady = false;

  async function run(doc: vscode.TextDocument): Promise<void> {
    try {
      if (!indexingReady) return;
      if (!isCicodeDocument(doc)) return;

      const text = doc.getText();
      const lintCfg = getLintConfig(cfg);

      const ignoreNoHeaders =
        indexer.getIgnoreSpans(doc.uri.fsPath) ??
        buildIgnoreSpans(text, { includeFunctionHeaders: false });
      const ignore =
        indexer.getIgnoreSpans(doc.uri.fsPath, {
          includeFunctionHeaders: true,
        }) ?? buildIgnoreSpans(text);
      const ctx: CheckContext = {
        doc,
        text,
        ignore,
        ignoreNoHeaders,
        indexer,
        cfg: lintCfg,
        ignoredFuncs: lintCfg.ignoredFunctions,
        diagnosticsEnabled: cfg().get("cicode.diagnostics.enable", true),
      };

      const diags = ALL_RULES.flatMap((rule) => rule.check(ctx));
      coll.set(doc.uri, diags);
    } catch (err) {
      error("cicode diagnostics failed", err);
    }
  }

  // Symbols a .ci file exposes to other files (function names, scope, return
  // type and arity shape, GLOBAL variables and their types). When they
  // change, other files' call, duplicate-definition, type and
  // undeclared-variable results may change too.
  const symbolSigs = new Map<string, string>();

  function symbolSig(file: string): string {
    const parts: string[] = [];
    for (const f of indexer.getFunctionRanges(file)) {
      const params = splitParamsTopLevel(f.paramsRaw || "").filter(Boolean);
      const shape = getOptionalParamFlags(params)
        .map((opt) => (opt ? "?" : "1"))
        .join("");
      const scope = f.scope?.toUpperCase() === "PRIVATE" ? "private " : "";
      parts.push(`f:${scope}${f.returnType} ${f.name}(${shape})`);
    }
    for (const v of indexer.getVariablesInFile(file)) {
      if (v.scopeType === "global") parts.push(`g:${v.type} ${v.name}`);
    }
    return parts
      .map((p) => p.toLowerCase())
      .sort()
      .join("\n");
  }

  /** Record `file`'s exported symbols; true when they differ from last time. */
  function updateSymbolSig(file: string): boolean {
    const cur = symbolSig(file);
    const prev = symbolSigs.get(file) ?? "";
    if (cur) symbolSigs.set(file, cur);
    else symbolSigs.delete(file);
    return cur !== prev;
  }

  /** Remove diagnostics (and symbol records) for a file or everything under a
   *  folder: VS Code reports a folder delete/rename as one folder URI.
   *  Returns true when a forgotten file exposed symbols to other files. */
  function forgetPath(fsPath: string): boolean {
    // Windows paths are case-insensitive.
    const fold = (p: string) =>
      process.platform === "win32" ? p.toLowerCase() : p;
    const target = fold(fsPath);
    const prefix = target.endsWith(path.sep) ? target : target + path.sep;
    const under = (p: string) => {
      const q = fold(p);
      return q === target || q.startsWith(prefix);
    };
    const stale: vscode.Uri[] = [];
    coll.forEach((uri) => {
      if (under(uri.fsPath)) stale.push(uri);
    });
    for (const uri of stale) coll.delete(uri);
    let hadSymbols = false;
    for (const file of [...symbolSigs.keys()]) {
      if (under(file)) hadSymbols = symbolSigs.delete(file) || hadSymbols;
    }
    return hadSymbols;
  }

  let runAllGen = 0;

  async function runAll(): Promise<void> {
    const gen = ++runAllGen;
    const files = await findWorkspaceFiles(CI_FILE_GLOB, cfg);
    for (const file of files) {
      if (gen !== runAllGen) return; // superseded by a newer runAll
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        await run(doc);
        updateSymbolSig(file.fsPath);
      } catch {
        // skip unreadable files
      }
    }
    if (gen !== runAllGen) return;

    // Drop entries for files no longer in the file set (e.g. after a
    // cicode.indexing.excludePatterns change); keep files open in a tab.
    const keep = new Set(files.map((f) => f.fsPath));
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          keep.add(tab.input.uri.fsPath);
        }
      }
    }
    const stale: vscode.Uri[] = [];
    coll.forEach((uri) => {
      if (!keep.has(uri.fsPath)) stale.push(uri);
    });
    for (const uri of stale) coll.delete(uri);
  }

  let refreshGen = 0;

  /** Re-check the Cicode documents VS Code already has loaded (open editors
   *  plus the ones runAll opened), yielding between files. Loaded documents
   *  the index no longer has (deleted or renamed away) are skipped. */
  async function runLoaded(): Promise<void> {
    const gen = ++refreshGen;
    const docs = vscode.workspace.textDocuments.filter(isCicodeDocument);
    for (const doc of docs) {
      if (gen !== refreshGen) return; // superseded by a newer refresh
      if (doc.isClosed || !indexer.getIgnoreSpans(doc.uri.fsPath)) continue;
      await run(doc);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshFull = false;

  /** Debounced re-check after a cross-file symbol change: `full` re-checks
   *  every workspace file (label/locvar changes, deletes and renames are rare
   *  and reach closed files), otherwise only the loaded documents (.ci symbol
   *  edits). */
  function scheduleRefresh(full: boolean): void {
    refreshFull ||= full;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      const doFull = refreshFull;
      refreshFull = false;
      void (doFull ? runAll() : runLoaded());
    }, REFRESH_DELAY_MS);
  }

  const indexedSub = indexer.onIndexed(async (changedFile) => {
    if (changedFile) {
      if (!indexingReady) return;
      if (!changedFile.toLowerCase().endsWith(".ci")) {
        // labels.DBF / locvar.DBF reindex: symbols changed globally. Other
        // paths (purged/renamed non-Cicode files and folders) are ignored.
        if (GLOBAL_SYMBOL_FILE_RE.test(changedFile)) scheduleRefresh(true);
        return;
      }

      if (!indexer.getIgnoreSpans(changedFile)) {
        // Purged (deleted or renamed away): its diagnostics are stale.
        if (forgetPath(changedFile)) scheduleRefresh(true);
        return;
      }

      if (updateSymbolSig(changedFile)) scheduleRefresh(false);
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === changedFile,
      );
      if (doc) {
        if (isCicodeDocument(doc)) run(doc);
      } else {
        // Reindexed while not loaded (e.g. renamed, or restored after a
        // shadowing definition was removed); load it to refresh its entry.
        vscode.workspace.openTextDocument(vscode.Uri.file(changedFile)).then(
          (d) => run(d),
          () => {
            // skip unreadable files
          },
        );
      }
    } else {
      indexingReady = true;
      await runAll();
    }
  });

  // The indexer purges/reindexes on the same events (its listeners run
  // first); this clears entries for every file under a deleted or renamed
  // folder, and renamed files get fresh entries once reindexed (onIndexed).
  const deleteSub = vscode.workspace.onDidDeleteFiles((e) => {
    let hadSymbols = false;
    for (const file of e.files) {
      hadSymbols = forgetPath(file.fsPath) || hadSymbols;
    }
    if (hadSymbols && indexingReady) scheduleRefresh(true);
  });

  const renameSub = vscode.workspace.onDidRenameFiles((e) => {
    let hadSymbols = false;
    for (const { oldUri } of e.files) {
      hadSymbols = forgetPath(oldUri.fsPath) || hadSymbols;
    }
    if (hadSymbols && indexingReady) scheduleRefresh(true);
  });

  // cicode.signatureOverrides changes already trigger a full rebuild in
  // extension.ts (buildAll -> onIndexed -> runAll), so skip them here.
  const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (
      e.affectsConfiguration("cicode") &&
      !e.affectsConfiguration("cicode.signatureOverrides") &&
      indexingReady
    )
      runAll();
  });

  return {
    dispose: () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      runAllGen++;
      refreshGen++;
      coll.dispose();
      indexedSub.dispose();
      deleteSub.dispose();
      renameSub.dispose();
      cfgSub.dispose();
    },
    set: coll.set.bind(coll),
    delete: coll.delete.bind(coll),
    clear: coll.clear.bind(coll),
    forEach: coll.forEach.bind(coll),
    get: coll.get.bind(coll),
    has: coll.has.bind(coll),
    name: coll.name,
  } as vscode.DiagnosticCollection;
}
