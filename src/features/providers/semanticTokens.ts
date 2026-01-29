import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";

export function makeSemanticTokens(indexer: Indexer): {
  provider: vscode.DocumentSemanticTokensProvider;
  legend: vscode.SemanticTokensLegend;
  dispose: () => void;
} {
  const legend = new vscode.SemanticTokensLegend(
    ["function", "variable", "builtin"],
    ["global", "local", "parameter", "module"],
  );

  // Cache builtin names for O(1) lookup instead of Map.get + property access per match
  let builtinNames: Set<string> | null = null;

  function getBuiltinNames(): Set<string> {
    if (builtinNames) return builtinNames;
    builtinNames = new Set();
    for (const [key, f] of indexer.getAllFunctions()) {
      if (f.helpPath) builtinNames.add(key);
    }
    return builtinNames;
  }

  const subscription = indexer.onIndexed(() => {
    builtinNames = null;
  });

  const provider: vscode.DocumentSemanticTokensProvider = {
    provideDocumentSemanticTokens(doc: vscode.TextDocument) {
      const builder = new vscode.SemanticTokensBuilder(legend);
      const text = doc.getText();

      // Use indexer data for function definitions (handles edge cases like comments after FUNCTION)
      for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
        builder.push(f.location.range, "function", []);
      }

      // Highlight builtin function calls
      const builtins = getBuiltinNames();
      const callRe = /\b([A-Za-z_]\w*)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(text))) {
        const name = m[1];
        if (builtins.has(name.toLowerCase())) {
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

  return {
    provider,
    legend,
    dispose(): void {
      subscription.dispose();
    },
  };
}
