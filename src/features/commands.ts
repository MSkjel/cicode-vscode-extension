import * as vscode from "vscode";
import * as net from "net";
import * as path from "path";
import type { Indexer } from "../core/indexer/indexer";
import {
  rebuildBuiltins,
  resolveContentPath,
  getPortalProduct,
  getFunc0Path,
} from "../core/builtins/builtins";
import { insertDocSkeletonAtCursor } from "./docSkeleton";
import { nameAt } from "./providers/nameAt";
import { isNameChar } from "../shared/textUtils";

// Local AVEVA help server ("Product Help Viewer Service", 2023 R2+). It serves
// the Author-it documentation portal per product; topics are opened via the
// #showid/<id> hash route (the same one the portal's own cross-links use).
// The root is configurable through cicode.helpServerUrl.
const DEFAULT_HELP_SERVER_URL = "https://localhost:28808";
const DEFAULT_PORTAL_PRODUCT = "Plant SCADA";

/** Can a TCP connection be opened to the URL's host and port in time? */
function isReachable(url: URL, timeoutMs = 1500): Promise<boolean> {
  const port = Number(url.port) || (url.protocol === "http:" ? 80 : 443);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

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
      const func0 = getFunc0Path();
      vscode.window.showInformationMessage(
        func0
          ? `Cicode: rebuilt builtin cache (compiler functions from ${func0}).`
          : "Cicode: rebuilt builtin cache. FUNC0.DBF was not found, so the shipped function list is used; check cicode.avevaPath.",
      );
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

        let name = symbol;
        if (!name) {
          name = nameAt(editor!.document, editor!.selection.active)?.name;
          if (!name) {
            vscode.window.showInformationMessage(
              "Cicode: place the cursor on a symbol to open its help.",
            );
            return;
          }
        }

        // A workspace copy of a documented library function (Include's
        // PageGoto, ...) hides the builtin entry that carries the help link.
        const found = editor
          ? indexer.getFunctionFor(name, editor.document.uri.fsPath)
          : indexer.getFunction(name);
        const f =
          found?.helpId || found?.helpPath
            ? found
            : (indexer.getBuiltinFunction(name) ?? found);

        // Preferred (2023 R2+): deep-link into the local AVEVA help server.
        // HelpDocumentationViewer serves the Author-it portal and resolves the
        // topic id via the same #showid route its own cross-references use.
        if (f?.helpId) {
          const root = (
            cfg().get<string>("cicode.helpServerUrl") || DEFAULT_HELP_SERVER_URL
          )
            .trim()
            .replace(/\/+$/, "");
          let rootUrl: URL;
          try {
            rootUrl = new URL(root);
          } catch {
            vscode.window.showWarningMessage(
              `Cicode: invalid cicode.helpServerUrl '${root}'.`,
            );
            return;
          }
          const product = getPortalProduct() || DEFAULT_PORTAL_PRODUCT;
          const url = `${root}/${encodeURIComponent(product)}/#showid/${encodeURIComponent(f.helpId)}`;

          // Don't send the user to a dead browser tab when the help service
          // isn't running (common on engineering machines).
          if (!(await isReachable(rootUrl))) {
            const openAnyway = "Open Anyway";
            const pick = await vscode.window.showWarningMessage(
              `Cicode: AVEVA help server not reachable at ${root}. Check that the "Product Help Viewer Service" is running, or set cicode.helpServerUrl.`,
              openAnyway,
            );
            if (pick !== openAnyway) return;
          }
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

      await ed.edit((eb) => {
        for (const sel of ed.selections) {
          const pos = sel.active;
          if (!sel.isEmpty) continue;

          const lineText = doc.lineAt(pos.line).text;
          const nextCh =
            pos.character < lineText.length ? lineText[pos.character] : "";
          const prevCh = pos.character > 0 ? lineText[pos.character - 1] : "";
          if (isStopper(nextCh) || prevCh === " ") continue;
          if (isNameChar(nextCh)) continue;

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
  return cmds;
}
