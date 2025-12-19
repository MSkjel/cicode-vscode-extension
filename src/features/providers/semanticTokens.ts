import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";

export function makeSemanticTokens(indexer: Indexer) {
  const legend = new vscode.SemanticTokensLegend(
    ["function", "variable", "builtin"],
    ["global", "local", "parameter", "module"],
  );

  const provider: vscode.DocumentSemanticTokensProvider = {
    provideDocumentSemanticTokens(doc: vscode.TextDocument) {
      const builder = new vscode.SemanticTokensBuilder(legend);
      const text = doc.getText();

      // Use indexer data for function definitions (handles edge cases like comments after FUNCTION)
      for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
        builder.push(f.location.range, "function", []);
      }

      // Highlight builtin function calls
      const callRe = /\b([A-Za-z_]\w*)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(text))) {
        const name = m[1];
        if (indexer.getAllFunctions().get(name.toLowerCase())?.helpPath) {
          const pos = doc.positionAt(m.index);
          builder.push(
            new vscode.Range(pos, pos.translate(0, name.length)),
            "builtin",
            [],
          );
        }
      }

      return builder.build();
    },
  };

  return { provider, legend };
}
