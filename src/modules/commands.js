const vscode = require('vscode');

function registerCommands(context, indexer, cfg, { rebuildBuiltins }) {
  const cmds = [];
  cmds.push(vscode.commands.registerCommand('cicode.rebuildBuiltins', async () => {
    await rebuildBuiltins(context, cfg);
    await indexer.buildAll();
    vscode.window.showInformationMessage('Cicode: rebuilt builtin cache.');
  }));
  cmds.push(vscode.commands.registerCommand('cicode.reindexAll', async () => {
    await indexer.buildAll();
    vscode.window.showInformationMessage('Cicode: full reindex complete.');
  }));
  cmds.push(vscode.commands.registerCommand('cicode.openHelpForSymbol', async (symbol) => {
    const editor = vscode.window.activeTextEditor; if (!symbol && !editor) return;
    const name = symbol || editor.document.getText(editor.document.getWordRangeAtPosition(editor.selection.active, /\w+/));
    const f = indexer.getAllFunctions().get(name.toLowerCase());
    if (f?.helpPath) { const uri = vscode.Uri.file(f.helpPath); vscode.env.openExternal(uri); }
    else { vscode.window.showInformationMessage(`No help page for '${name}'.`); }
  }));
  return cmds;
}

module.exports = { registerCommands };
