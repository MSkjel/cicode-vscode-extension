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

      const re = /(^|\n)\s*(?:\w+\s+)*function\s+(\w+)\s*\(/gim;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const name = m[2];
        const off = m.index + m[0].indexOf(name);
        const pos = doc.positionAt(off);
        builder.push(
          new vscode.Range(pos, pos.translate(0, name.length)),
          "function",
          [],
        );
      }

      const call = /\b([A-Za-z_]\w*)\s*\(/g;
      while ((m = call.exec(text))) {
        const name = m[1];
        if (indexer.getAllFunctions().get(name.toLowerCase())?.helpPath) {
          const off = m.index;
          const pos = doc.positionAt(off);
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
