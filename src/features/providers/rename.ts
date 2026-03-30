import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import type { ReferenceCache } from "../../core/referenceCache";
import { getSymbolAtPosition } from "../../shared/textUtils";

function addDefinition(
  indexer: Indexer,
  edit: vscode.WorkspaceEdit,
  word: string,
  newName: string,
): void {
  const entry = indexer.getFunction(word);
  if (!entry?.location) return;
  const start = entry.location.range.start;
  edit.replace(
    entry.location.uri,
    new vscode.Range(start, start.translate(0, word.length)),
    newName,
  );
}

export function makeRename(
  indexer: Indexer,
  refCache: ReferenceCache,
): vscode.RenameProvider {
  return {
    prepareRename(doc, pos) {
      return doc.getWordRangeAtPosition(pos, /\w+/) || null;
    },
    async provideRenameEdits(doc, pos, newName) {
      const word = getSymbolAtPosition(doc, pos);
      if (!word) return null;
      const edit = new vscode.WorkspaceEdit();

      // Try to use cached references for functions (much faster)
      if (refCache.isReady && indexer.hasFunction(word)) {
        const cached = refCache.getReferences(word);
        if (cached) {
          const locations = await refCache.toLocations(cached.refs);
          for (const loc of locations)
            edit.replace(loc.uri, loc.range, newName);
          addDefinition(indexer, edit, word, newName);
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
      addDefinition(indexer, edit, word, newName);
      return edit;
    },
  };
}
