import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";

export function makeCompletion(
  indexer: Indexer,
): vscode.CompletionItemProvider {
  return {
    provideCompletionItems(document, position) {
      const items: vscode.CompletionItem[] = [];

      for (const [, f] of indexer.getAllFunctions()) {
        const display = f.name;
        const signature = `${f.returnType} ${display}(${(f.params || []).join(", ")})`;
        const it = new vscode.CompletionItem(
          display,
          vscode.CompletionItemKind.Function,
        );
        it.insertText = display;
        it.detail = signature;
        if (f.doc) it.documentation = new vscode.MarkdownString(f.doc);
        it.sortText = `0_${display}`;
        items.push(it);
      }

      const file = document.uri.fsPath;
      const current = (indexer as any).findEnclosingFunction(
        document,
        position,
      );
      const seen = new Set<string>();
      const push = (v: any) => {
        const k = `${v.name}|${v.scopeType}|${v.scopeId}`;
        if (seen.has(k)) return;
        seen.add(k);
        const detail =
          v.scopeType === "global"
            ? `Global ${v.type}`
            : v.scopeType === "module"
              ? `Module ${v.type}`
              : `Local ${v.type}`;
        const it = new vscode.CompletionItem(
          v.name,
          vscode.CompletionItemKind.Variable,
        );
        it.detail = detail;
        it.sortText = `1_${v.name}`;
        items.push(it);
      };

      if (current) {
        for (const v of indexer.getVariablesByPredicate(
          (x) =>
            x.scopeType === "local" &&
            x.scopeId === (indexer as any).localScopeId(file, current.name),
        ))
          push(v);
      }
      for (const v of indexer.getVariablesByPredicate(
        (x) => x.scopeType === "module" && x.scopeId === file,
      ))
        push(v);
      for (const v of indexer.getVariablesByPredicate(
        (x) => x.scopeType === "global",
      ))
        push(v);

      return items;
    },
  };
}
