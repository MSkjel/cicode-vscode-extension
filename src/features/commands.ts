import * as vscode from "vscode";
import type { Indexer } from "../core/indexer/indexer";
import { rebuildBuiltins } from "../core/builtins/builtins";

export function registerCommands(
  context: vscode.ExtensionContext,
  indexer: Indexer,
  cfg: () => vscode.WorkspaceConfiguration,
): vscode.Disposable[] {
  const cmds: vscode.Disposable[] = [];

  cmds.push(
    vscode.commands.registerCommand("cicode.rebuildBuiltins", async () => {
      await rebuildBuiltins(context, cfg);
      await indexer.buildAll();
      vscode.window.showInformationMessage("Cicode: rebuilt builtin cache.");
    }),
  );

  cmds.push(
    vscode.commands.registerCommand("cicode.reindexAll", async () => {
      await indexer.buildAll();
      vscode.window.showInformationMessage("Cicode: full reindex complete.");
    }),
  );

  cmds.push(
    vscode.commands.registerCommand(
      "cicode.openHelpForSymbol",
      async (symbol?: string) => {
        const editor = vscode.window.activeTextEditor;
        if (!symbol && !editor) return;
        const name =
          symbol ||
          editor!.document.getText(
            editor!.document.getWordRangeAtPosition(
              editor!.selection.active,
              /\w+/,
            ),
          );
        const f = indexer.getAllFunctions().get(name.toLowerCase());
        const helpPath = (f as any)?.helpPath as string | undefined;
        if (helpPath) vscode.env.openExternal(vscode.Uri.file(helpPath));
        else
          vscode.window.showInformationMessage(`No help page for '${name}'.`);
      },
    ),
  );

  context.subscriptions.push(...cmds);
  return cmds;
}
