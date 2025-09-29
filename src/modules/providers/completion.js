const vscode = require('vscode');
function makeCompletion(indexer) {
  return {
    provideCompletionItems(document, position) {
      const items = []; // functions
      for (const [key, f] of indexer.getAllFunctions()) {
        const display = f.name || key; const signature = `${f.returnType} ${display}(${(f.params || []).join(', ')})`;
        const it = new vscode.CompletionItem(display, vscode.CompletionItemKind.Function); it.insertText = display; it.detail = signature; if (f.doc) it.documentation = new vscode.MarkdownString(f.doc); items.push(it);
      }
      // variables by scope
      const file = document.uri.fsPath; const current = indexer.findEnclosingFunction(document, position); const seen = new Set();
      const push = (v) => { const k = `${v.name}|${v.scopeType}|${v.scopeId}`; if (seen.has(k)) return; seen.add(k); const detail = (v.scopeType === 'global' ? `Global ${v.type}` : v.scopeType === 'module' ? `Module ${v.type}` : `Local ${v.type}`); const it = new vscode.CompletionItem(v.name, vscode.CompletionItemKind.Variable); it.detail = detail; items.push(it); };
      if (current) { for (const [, arr] of indexer.variableCache) for (const v of arr) if (v.scopeType === 'local' && v.scopeId === indexer.localScopeId(file, current.name)) push(v); }
      for (const [, arr] of indexer.variableCache) for (const v of arr) if (v.scopeType === 'module' && v.scopeId === file) push(v);
      for (const [, arr] of indexer.variableCache) for (const v of arr) if (v.scopeType === 'global') push(v);
      return items;
    }
  };
}
module.exports = { makeCompletion };
