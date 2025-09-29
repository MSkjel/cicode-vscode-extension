const vscode = require('vscode');

function makeSymbols(indexer, workspace = false) {
  return workspace ? {
    async provideWorkspaceSymbols(query) {
      const q = (query || '').toLowerCase(); const out = [];
      for (const [key, f] of indexer.getAllFunctions()) if (!q || key.includes(q)) out.push(new vscode.SymbolInformation(f.name, vscode.SymbolKind.Function, '', f.location || new vscode.Location(vscode.Uri.file(''), new vscode.Position(0, 0))));
      for (const [key, arr] of indexer.variableCache) { if (q && !key.includes(q)) continue; for (const v of arr) { const detail = v.scopeType === 'global' ? 'Global' : v.scopeType === 'module' ? 'Module' : `Local (${v.scopeId})`; out.push(new vscode.SymbolInformation(v.name, vscode.SymbolKind.Variable, detail, v.location)); } }
      return out;
    }
  } : {
    provideDocumentSymbols(document) {
      const text = document.getText(); const regex = /^(?!.*\/\/).*?(\w+)?\s*function\s+(\w+)\s*\(/gim; let m; const syms = [];
      while ((m = regex.exec(text))) { const name = m[2]; const off = m.index; const before = text.substr(0, off); const line = before.split(/\r?\n/).length - 1; const col = off - before.lastIndexOf('\n') - 1; syms.push(new vscode.SymbolInformation(name, vscode.SymbolKind.Function, '', new vscode.Location(document.uri, new vscode.Position(line, col)))); }
      for (const v of indexer.getVariablesInFile(document.uri.fsPath)) if (v.scopeType !== 'local') syms.push(new vscode.SymbolInformation(`${v.name}: ${v.type}`, vscode.SymbolKind.Variable, v.scopeType === 'global' ? 'Global' : 'Module', v.location));
      return syms;
    }
  };
}

module.exports = { makeSymbols };
