import * as vscode from "vscode";
import { cfg } from "./config";
import { initBuiltins, rebuildBuiltins } from "./core/builtins/builtins";
import { Indexer } from "./core/indexer/indexer";
import { registerProviders } from "./features/providers";
import { registerCommands } from "./features/commands";
import { makeStatusBar } from "./features/statusBar";
import { makeSideBar } from "./features/sideBar";

let indexer: Indexer | undefined;

export async function activate(context: vscode.ExtensionContext) {
  try {
    console.log("Cicode extension active!");
    await initBuiltins(context, cfg);

    indexer = new Indexer(context, cfg);
    context.subscriptions.push({ dispose: () => indexer?.dispose() });

    const disposables: vscode.Disposable[] = [];
    disposables.push(...registerProviders(context, indexer, cfg));
    disposables.push(...registerCommands(context, indexer, cfg));
    disposables.push(makeStatusBar(indexer));
    disposables.push(...makeSideBar());
    context.subscriptions.push(...disposables);

    // Build index in the background — providers handle the "not yet ready" state
    indexer.buildAll().catch((err) => {
      console.error("Cicode: Failed to build index:", err);
    });
  } catch (err) {
    console.error("Cicode extension activation failed:", err);
    vscode.window.showErrorMessage(
      `Cicode extension failed to activate: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

export function deactivate() {
  // Cleanup handled by context.subscriptions
}
