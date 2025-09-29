const vscode = require('vscode');
function makeStatusBar(indexer) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = 'Cicode: indexing…'; item.command = 'cicode.reindexAll'; item.show();
  const refresh = () => { const f = indexer.getAllFunctions().size; let v = 0; for (const [, arr] of indexer.variableCache) v += arr.length; item.text = `Cicode: ${f} funcs | ${v} vars`; };
  indexer.onIndexed(refresh); refresh();
  return item;
}
module.exports = { makeStatusBar };
