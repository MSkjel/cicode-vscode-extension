import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";

export function makeRename(_indexer: Indexer): vscode.RenameProvider {
  return {
    prepareRename(doc, pos) {
      return doc.getWordRangeAtPosition(pos, /\w+/) || null;
    },
    async provideRenameEdits(doc, pos, newName) {
      const wordRange = doc.getWordRangeAtPosition(pos, /\w+/);
      if (!wordRange) return null;
      const refs = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        doc.uri,
        pos,
      );
      const edit = new vscode.WorkspaceEdit();
      for (const loc of refs || []) edit.replace(loc.uri, loc.range, newName);
      return edit;
    },
  };
}
