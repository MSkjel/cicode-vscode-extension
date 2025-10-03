import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";

export function makeSymbols(
  indexer: Indexer,
  workspace: true,
): vscode.WorkspaceSymbolProvider<vscode.SymbolInformation>;
export function makeSymbols(
  indexer: Indexer,
  workspace?: false,
): vscode.DocumentSymbolProvider;

export function makeSymbols(indexer: Indexer, workspace = false) {
  if (workspace) {
    const provider: vscode.WorkspaceSymbolProvider<vscode.SymbolInformation> = {
      async provideWorkspaceSymbols(
        query: string,
        _token: vscode.CancellationToken,
      ) {
        const q = (query || "").toLowerCase();
        const out: vscode.SymbolInformation[] = [];

        for (const [, f] of indexer.getAllFunctions()) {
          const key = f.name.toLowerCase();
          if (!q || key.includes(q)) {
            out.push(
              new vscode.SymbolInformation(
                f.name,
                vscode.SymbolKind.Function,
                "",
                f.location ||
                  new vscode.Location(
                    vscode.Uri.file(""),
                    new vscode.Position(0, 0),
                  ),
              ),
            );
          }
        }

        for (const v of indexer.getAllVariableEntries()) {
          const key = v.name.toLowerCase();
          if (q && !key.includes(q)) continue;
          const detail =
            v.scopeType === "global"
              ? "Global"
              : v.scopeType === "module"
                ? "Module"
                : `Local (${v.scopeId})`;
          out.push(
            new vscode.SymbolInformation(
              v.name,
              vscode.SymbolKind.Variable,
              detail,
              v.location,
            ),
          );
        }
        return out;
      },
    };
    return provider;
  }

  const provider: vscode.DocumentSymbolProvider = {
    provideDocumentSymbols(
      document: vscode.TextDocument,
      _token: vscode.CancellationToken,
    ) {
      const text = document.getText();
      const regex = /(^|\n)\s*(?:\w+\s+)*function\s+(\w+)\s*\(/gim;
      let m: RegExpExecArray | null;
      const syms: vscode.SymbolInformation[] = [];

      while ((m = regex.exec(text))) {
        const name = m[2];
        const off = m.index;
        const before = text.substring(0, off);
        const line = before.split(/\r?\n/).length - 1;
        const col = off - (before.lastIndexOf("\n") + 1);
        syms.push(
          new vscode.SymbolInformation(
            name,
            vscode.SymbolKind.Function,
            "",
            new vscode.Location(document.uri, new vscode.Position(line, col)),
          ),
        );
      }

      for (const v of indexer.getVariablesInFile(document.uri.fsPath)) {
        if (v.scopeType !== "local") {
          syms.push(
            new vscode.SymbolInformation(
              `${v.name}: ${v.type}`,
              vscode.SymbolKind.Variable,
              v.scopeType === "global" ? "Global" : "Module",
              v.location,
            ),
          );
        }
      }
      return syms;
    },
  };

  return provider;
}
