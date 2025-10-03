import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import { makeSymbols } from "./symbols";
import { makeNavProviders } from "./navigation";
import { makeCompletion } from "./completion";
import { makeDiagnostics } from "./diagnostics";
import { makeRename } from "./rename";
import { makeFolding } from "./folding";
import { makeInlay } from "./inlay";
import { makeSemanticTokens } from "./semanticTokens";
import { makeFormatter } from "./formatter";

export function registerProviders(
  context: vscode.ExtensionContext,
  indexer: Indexer,
  cfg: () => vscode.WorkspaceConfiguration,
): vscode.Disposable[] {
  const lang = { language: "cicode" } as const;
  const disposables: vscode.Disposable[] = [];

  disposables.push(
    vscode.languages.registerDocumentSymbolProvider(lang, makeSymbols(indexer)),
  );
  disposables.push(
    vscode.languages.registerWorkspaceSymbolProvider(
      makeSymbols(indexer, true),
    ),
  );
  disposables.push(...makeNavProviders(indexer));
  disposables.push(
    vscode.languages.registerCompletionItemProvider(
      lang,
      makeCompletion(indexer),
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split(
        "",
      ),
    ),
  );
  disposables.push(makeDiagnostics(indexer, cfg));
  disposables.push(
    vscode.languages.registerRenameProvider("cicode", makeRename(indexer)),
  );
  disposables.push(
    vscode.languages.registerFoldingRangeProvider(
      "cicode",
      makeFolding(indexer),
    ),
  );
  disposables.push(
    vscode.languages.registerInlayHintsProvider("cicode", makeInlay(indexer)),
  );

  // FIX: create semantic tokens provider ONCE and reuse its legend
  const sem = makeSemanticTokens(indexer);
  disposables.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      lang,
      sem.provider,
      sem.legend,
    ),
  );

  disposables.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      "cicode",
      makeFormatter(cfg),
    ),
  );
  return disposables;
}
