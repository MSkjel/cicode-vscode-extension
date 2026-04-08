import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import { buildIgnoreSpans } from "../../shared/textUtils";
import { getLintConfig, findWorkspaceFiles } from "../../config";
import { isCicodeDocument, error } from "../../shared/utils";
import type { CheckContext } from "./context";
import { ALL_RULES } from "./rules/index";

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

  async function runAll(): Promise<void> {
    const files = await findWorkspaceFiles("**/*.ci", cfg);
    for (const file of files) {
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        await run(doc);
      } catch {
        // skip unreadable files
      }
    }
  }

  indexer.onIndexed(async (changedFile) => {
    if (changedFile) {
      if (!indexingReady) return;
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === changedFile,
      );
      if (doc && isCicodeDocument(doc)) run(doc);
    } else {
      indexingReady = true;
      await runAll();
    }
  });

  const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("cicode") && indexingReady) runAll();
  });

  return {
    dispose: () => {
      coll.dispose();
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
