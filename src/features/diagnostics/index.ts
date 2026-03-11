import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import { buildIgnoreSpans } from "../../shared/textUtils";
import { getLintConfig } from "../../shared/diagnosticHelpers";
import { isCicodeDocument } from "../../shared/utils";
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

      const ctx: CheckContext = {
        doc,
        text,
        ignore: buildIgnoreSpans(text),
        ignoreNoHeaders: buildIgnoreSpans(text, {
          includeFunctionHeaders: false,
        }),
        indexer,
        cfg: lintCfg,
        ignoredFuncs: lintCfg.ignoredFunctions,
        diagnosticsEnabled: cfg().get("cicode.diagnostics.enable", true),
      };

      const diags = ALL_RULES.flatMap((rule) => rule.check(ctx));
      coll.set(doc.uri, diags);
    } catch (err) {
      console.error("cicode diagnostics failed", err);
    }
  }

  indexer.onIndexed(async (changedFile) => {
    indexingReady = true;
    if (changedFile) {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === changedFile,
      );
      if (doc && isCicodeDocument(doc)) run(doc);
    } else {
      const files = await vscode.workspace.findFiles("**/*.ci");
      for (const file of files) {
        try {
          const doc = await vscode.workspace.openTextDocument(file);
          await run(doc);
        } catch {
          // skip unreadable files
        }
      }
    }
  });

  const subs: vscode.Disposable[] = [
    vscode.workspace.onDidOpenTextDocument(run),
    vscode.workspace.onDidSaveTextDocument(run),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) run(editor.document);
    }),
  ];

  return {
    dispose: () => {
      coll.dispose();
      subs.forEach((s) => s.dispose());
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
