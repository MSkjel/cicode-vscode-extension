import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import type { ReferenceCache } from "../../core/referenceCache";

export function makeCodeLens(
  indexer: Indexer,
  refCache: ReferenceCache,
  cfg: () => vscode.WorkspaceConfiguration,
): vscode.CodeLensProvider & vscode.Disposable {
  const _onDidChange = new vscode.EventEmitter<void>();
  const subscription = refCache.onCacheUpdated(() => _onDidChange.fire());

  return {
    onDidChangeCodeLenses: _onDidChange.event,

    dispose(): void {
      subscription.dispose();
      _onDidChange.dispose();
    },

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
      if (!cfg().get<boolean>("cicode.codeLens.enable", true)) return [];

      const lenses: vscode.CodeLens[] = [];
      const funcRanges = indexer.getFunctionRanges(document.uri.fsPath);

      for (const f of funcRanges) {
        const key = f.name.toLowerCase();
        const refCount = refCache.getReferenceCount(key);

        // Anchor to the function name line
        const nameLine = f.location.range.start.line;
        const anchor = new vscode.Position(nameLine, 0);
        const lens = new vscode.CodeLens(new vscode.Range(anchor, anchor), {
          title: refCount === 1 ? "1 reference" : `${refCount} references`,
          command: "editor.action.findReferences",
          arguments: [document.uri, f.location.range.start],
        });
        lenses.push(lens);
      }

      return lenses;
    },
  };
}
