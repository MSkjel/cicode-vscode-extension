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
      // Return DocumentSymbol (not SymbolInformation) so that sticky scroll
      // and the outline view get proper full-scope ranges.
      const funcs = indexer.getFunctionRanges(document.uri.fsPath);
      const syms: vscode.DocumentSymbol[] = [];

      for (const f of funcs) {
        // Full range: from FUNCTION keyword through END
        const fullRange = new vscode.Range(f.headerPos, f.bodyRange.end);
        // Selection range: the function name itself
        const selRange = f.location.range;

        syms.push(
          new vscode.DocumentSymbol(
            f.name,
            f.returnType || "",
            vscode.SymbolKind.Function,
            fullRange,
            selRange,
          ),
        );
      }

      for (const v of indexer.getVariablesInFile(document.uri.fsPath)) {
        if (v.scopeType !== "local") {
          syms.push(
            new vscode.DocumentSymbol(
              `${v.name}: ${v.type}`,
              v.scopeType === "global" ? "Global" : "Module",
              vscode.SymbolKind.Variable,
              v.location.range,
              v.location.range,
            ),
          );
        }
      }
      return syms;
    },
  };

  return provider;
}
