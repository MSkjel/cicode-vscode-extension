import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import { ReferenceCache } from "../../core/referenceCache";
import { makeSymbols } from "./symbols";
import { makeNavProviders } from "./navigation";
import { makeCompletion } from "./completion";
import { makeDiagnostics } from "./diagnostics";
import { makeRename } from "./rename";
import { makeFolding } from "./folding";
import { makeInlay } from "./inlay";
import { makeSemanticTokens } from "./semanticTokens";
import { makeFormatter } from "./formatter";
import { makeCodeLens } from "./codeLens";

export function registerProviders(
  context: vscode.ExtensionContext,
  indexer: Indexer,
  cfg: () => vscode.WorkspaceConfiguration,
): vscode.Disposable[] {
  const lang = { language: "cicode" } as const;
  const disposables: vscode.Disposable[] = [];

  try {
    const refCache = new ReferenceCache(indexer, cfg);
    disposables.push(refCache);

    // Use holder pattern to avoid leaking disposed registrations in array
    const docSymHolder = {
      current: vscode.languages.registerDocumentSymbolProvider(
        lang,
        makeSymbols(indexer),
      ),
      dispose(): void {
        this.current.dispose();
      },
    };
    disposables.push(docSymHolder);

    const onceIndexed = indexer.onIndexed((file) => {
      if (file === undefined) {
        // Full rebuild complete — re-register so VS Code re-requests symbols
        // for already-open documents
        docSymHolder.current.dispose();
        docSymHolder.current = vscode.languages.registerDocumentSymbolProvider(
          lang,
          makeSymbols(indexer),
        );
        onceIndexed.dispose();
      }
    });
    disposables.push(onceIndexed);
    disposables.push(
      vscode.languages.registerWorkspaceSymbolProvider(
        makeSymbols(indexer, true),
      ),
    );
    disposables.push(...makeNavProviders(indexer, refCache));
    disposables.push(
      vscode.languages.registerCompletionItemProvider(
        lang,
        makeCompletion(indexer),
        ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_".split(""),
      ),
    );
    disposables.push(makeDiagnostics(indexer, cfg));
    disposables.push(
      vscode.languages.registerRenameProvider(
        "cicode",
        makeRename(indexer, refCache),
      ),
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
    disposables.push(sem); // Dispose cache invalidation subscription
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

    const codeLensProvider = makeCodeLens(indexer, refCache, cfg);
    disposables.push(codeLensProvider);
    disposables.push(
      vscode.languages.registerCodeLensProvider(lang, codeLensProvider),
    );
  } catch (err) {
    // Cleanup any successful registrations on error
    console.error("Cicode: Failed to register providers:", err);
    for (const d of disposables) {
      try {
        d.dispose();
      } catch {
        // Ignore disposal errors
      }
    }
    throw err;
  }

  return disposables;
}
