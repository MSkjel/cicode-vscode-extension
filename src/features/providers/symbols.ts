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
    type CachedSym = { lower: string; sym: vscode.SymbolInformation };
    let cache: CachedSym[] | null = null;
    indexer.onIndexed(() => {
      cache = null;
    });

    function buildCache(): CachedSym[] {
      const result: CachedSym[] = [];
      for (const [, f] of indexer.getAllFunctions()) {
        result.push({
          lower: f.name.toLowerCase(),
          sym: new vscode.SymbolInformation(
            f.name,
            vscode.SymbolKind.Function,
            "",
            f.location ??
              new vscode.Location(
                vscode.Uri.file(""),
                new vscode.Position(0, 0),
              ),
          ),
        });
      }
      for (const v of indexer.getAllVariableEntries()) {
        if (!v.location) continue;
        const detail =
          v.scopeType === "global"
            ? "Global"
            : v.scopeType === "module"
              ? "Module"
              : `Local (${v.scopeId})`;
        result.push({
          lower: v.name.toLowerCase(),
          sym: new vscode.SymbolInformation(
            v.name,
            vscode.SymbolKind.Variable,
            detail,
            v.location,
          ),
        });
      }
      return result;
    }

    const provider: vscode.WorkspaceSymbolProvider<vscode.SymbolInformation> = {
      provideWorkspaceSymbols(query: string, _token: vscode.CancellationToken) {
        const q = (query || "").toLowerCase();
        if (!cache) cache = buildCache();
        const out = q
          ? cache.filter((c) => c.lower.includes(q)).map((c) => c.sym)
          : cache.map((c) => c.sym);
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
        if (v.scopeType !== "local" && v.location) {
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
