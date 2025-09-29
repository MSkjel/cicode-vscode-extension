const vscode = require('vscode');
function makeSemanticTokens(indexer) {
  const legend = new vscode.SemanticTokensLegend(['function', 'variable', 'builtin'], ['global', 'local', 'parameter', 'module']);
  return {
    legend,
    provideDocumentSemanticTokens(doc) {
      const builder = new vscode.SemanticTokensBuilder(legend);
      const text = doc.getText();
      // mark function headers
      const re = /^(?!.*\/\/).*?(\w+)?\s*function\s+(\w+)\s*\(/gim; let m;
      while ((m = re.exec(text))) {
        const name = m[2]; const off = m.index + m[0].indexOf(name); const pos = doc.positionAt(off);
        builder.push(new vscode.Range(pos, pos.translate(0, name.length)), 'function', []);
      }
      // builtins in calls
      const call = /\b([A-Za-z_]\w*)\s*\(/g; while ((m = call.exec(text))) {
        const name = m[1];
        if (indexer.getAllFunctions().get(name.toLowerCase())?.helpPath) {
          const off = m.index; const pos = doc.positionAt(off);
          builder.push(new vscode.Range(pos, pos.translate(0, name.length)), 'builtin', []);
        }
      }
      return builder.build();
    }
  };
}
module.exports = { makeSemanticTokens };
