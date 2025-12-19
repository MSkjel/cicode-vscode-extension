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
      // Use the indexer's function ranges for accurate symbol detection
      // This handles edge cases like comments after FUNCTION keyword
      const funcs = indexer.getFunctionRanges(document.uri.fsPath);
      const syms: vscode.SymbolInformation[] = [];

      for (const f of funcs) {
        syms.push(
          new vscode.SymbolInformation(
            f.name,
            vscode.SymbolKind.Function,
            f.returnType || "",
            f.location,
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
