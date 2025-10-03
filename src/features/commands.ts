import * as vscode from "vscode";
import type { Indexer } from "../core/indexer/indexer";
import { rebuildBuiltins } from "../core/builtins/builtins";
import { insertDocSkeletonAtCursor } from "./docSkeleton";

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

        if (!helpPath) {
          vscode.window.showInformationMessage(`No help page for '${name}'.`);
          return;
        }

        const uri = vscode.Uri.file(helpPath);
        await vscode.env.openExternal(uri);
      },
    ),
  );

  cmds.push(
    vscode.commands.registerCommand("cicode.insertDocSkeleton", async () => {
      const ok = await insertDocSkeletonAtCursor(indexer);
      if (ok)
        vscode.window.showInformationMessage("Cicode: Inserted doc skeleton.");
    }),
  );

  context.subscriptions.push(...cmds);
  return cmds;
}
