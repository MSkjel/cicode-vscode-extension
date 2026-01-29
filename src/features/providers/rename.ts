import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import type { ReferenceCache } from "../../core/referenceCache";

export function makeRename(
  indexer: Indexer,
  refCache: ReferenceCache,
): vscode.RenameProvider {
  return {
    prepareRename(doc, pos) {
      return doc.getWordRangeAtPosition(pos, /\w+/) || null;
    },
    async provideRenameEdits(doc, pos, newName) {
      const wordRange = doc.getWordRangeAtPosition(pos, /\w+/);
      if (!wordRange) return null;

      const word = doc.getText(wordRange);
      const edit = new vscode.WorkspaceEdit();

      // Try to use cached references for functions (much faster)
      if (refCache.isReady && indexer.hasFunction(word)) {
        const cached = refCache.getReferences(word);
        if (cached) {
          const locations = await refCache.toLocations(cached.refs);
          for (const loc of locations)
            edit.replace(loc.uri, loc.range, newName);
          return edit;
        }
      }

      // Fallback: use VS Code's reference provider
      const refs = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        doc.uri,
        pos,
      );
      for (const loc of refs || []) edit.replace(loc.uri, loc.range, newName);
      return edit;
    },
  };
}
