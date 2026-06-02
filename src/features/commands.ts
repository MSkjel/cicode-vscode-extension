import * as vscode from "vscode";
import * as path from "path";
import type { Indexer } from "../core/indexer/indexer";
import { rebuildBuiltins, resolveContentPath } from "../core/builtins/builtins";
import { insertDocSkeletonAtCursor } from "./docSkeleton";

// Local AVEVA help server (HelpDocumentationViewer, 2023 R2+). It serves the
// Author-it documentation portal per product; topics are opened via the
// #showid/<id> hash route (the same one the portal's own cross-links use).
const HELP_SERVER_BASE = "https://localhost:28808/Plant%20SCADA";

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

        // Preferred (2023 R2+): deep-link into the local AVEVA help server.
        // HelpDocumentationViewer serves the Author-it portal and resolves the
        // topic id via the same #showid route its own cross-references use.
        if (f?.helpId) {
          const url = `${HELP_SERVER_BASE}/#showid/${encodeURIComponent(f.helpId)}`;
          await vscode.env.openExternal(vscode.Uri.parse(url));
          return;
        }

        // Fallback: open a local Flare help file (2020 / file-based installs).
        const helpFile = f?.helpPath;
        const contentPath = helpFile ? resolveContentPath(cfg) : null;
        if (helpFile && contentPath) {
          const fullPath = path.join(contentPath, helpFile);
          await vscode.env.openExternal(vscode.Uri.file(fullPath));
          return;
        }

        vscode.window.showInformationMessage(
          helpFile
            ? "Could not find AVEVA help files. Check cicode.avevaPath setting."
            : `No help page for '${name}'.`,
        );
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

  cmds.push(
    vscode.commands.registerCommand("cicode.addSpaceIfNeeded", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;

      const doc = ed.document;
      const isStopper = (ch: string) =>
        ch === " " ||
        ch === ";" ||
        ch === "," ||
        ch === ")" ||
        ch === "]" ||
        ch === "}" ||
        ch === "\t";
      const isIdent = (ch: string) => /[A-Za-z0-9_]/.test(ch);

      await ed.edit((eb) => {
        for (const sel of ed.selections) {
          const pos = sel.active;
          if (!sel.isEmpty) continue;

          const lineText = doc.lineAt(pos.line).text;
          const nextCh =
            pos.character < lineText.length ? lineText[pos.character] : "";
          const prevCh = pos.character > 0 ? lineText[pos.character - 1] : "";
          if (isStopper(nextCh) || prevCh === " ") continue;
          if (isIdent(nextCh)) continue;

          eb.insert(pos, " ");
        }
      });
    }),
  );

  cmds.push(
    vscode.commands.registerCommand("cicode.createNewFile", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        return;
      }

      while (true) {
        const fileName = await vscode.window.showInputBox({
          prompt: "Enter new Cicode filename",
        });

        // Return if ESC pressed
        if (fileName === undefined) {
          return;
        }

        // Prompt again if given file name is empty
        if (fileName.trim() === "") {
          vscode.window.showErrorMessage("Empty filename is not allowed");
          continue;
        }

        const fileUri = vscode.Uri.joinPath(folder.uri, fileName);
        try {
          await vscode.workspace.fs.stat(fileUri);
          vscode.window.showErrorMessage(
            `File "${fileName}" already exists. Please input another name.`,
          );
        } catch {
          await vscode.workspace.fs.writeFile(fileUri, new Uint8Array());
          await vscode.window.showTextDocument(fileUri);
          return;
        }
      }
    }),
  );
  context.subscriptions.push(...cmds);
  return cmds;
}
