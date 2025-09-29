const vscode = require('vscode');
function makeRename(indexer) {
  return {
    prepareRename(doc, pos) { return doc.getWordRangeAtPosition(pos, /\w+/) || null; },
    async provideRenameEdits(doc, pos, newName) {
      const wordRange = doc.getWordRangeAtPosition(pos, /\w+/); if (!wordRange) return null;
      const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', doc.uri, pos);
      const edit = new vscode.WorkspaceEdit(); for (const loc of refs || []) edit.replace(loc.uri, loc.range, newName); return edit;
    }
  };
}
module.exports = { makeRename };
