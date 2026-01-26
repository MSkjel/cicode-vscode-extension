import * as vscode from "vscode";
import { cfg } from "./config";
import { initBuiltins, rebuildBuiltins } from "./core/builtins/builtins";
import { Indexer } from "./core/indexer/indexer";
import { registerProviders } from "./features/providers";
import { registerCommands } from "./features/commands";
import { makeStatusBar } from "./features/statusBar";
import { makeSideBar } from "./features/sideBar";

let indexer: Indexer;

export async function activate(context: vscode.ExtensionContext) {
  console.log("Cicode extension active!");
  await initBuiltins(context, cfg);

  indexer = new Indexer(context, cfg);
  await indexer.buildAll();

  const disposables: vscode.Disposable[] = [];
  disposables.push(...registerProviders(context, indexer, cfg));
  disposables.push(...registerCommands(context, indexer, cfg));
  disposables.push(makeStatusBar(indexer));
  disposables.push(...makeSideBar());
  context.subscriptions.push(...disposables);
}

export function deactivate() {}
