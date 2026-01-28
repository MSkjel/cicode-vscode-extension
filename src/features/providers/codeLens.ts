import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import type { ReferenceCache } from "../../core/referenceCache";

export function makeCodeLens(
  indexer: Indexer,
  refCache: ReferenceCache,
  cfg: () => vscode.WorkspaceConfiguration,
): vscode.CodeLensProvider {
  const _onDidChange = new vscode.EventEmitter<void>();

  refCache.onCacheUpdated(() => _onDidChange.fire());

  return {
    onDidChangeCodeLenses: _onDidChange.event,

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
      if (!refCache.isReady) return [];
      if (!cfg().get<boolean>("cicode.codeLens.enable", true)) return [];

      const lenses: vscode.CodeLens[] = [];
      const funcRanges = indexer.getFunctionRanges(document.uri.fsPath);

      for (const f of funcRanges) {
        const key = f.name.toLowerCase();
        const total = refCache.getReferenceCount(key);
        // Exclude the definition site itself from the displayed count
        const funcInfo = indexer.getFunction(key);
        const hasDef = funcInfo?.file != null ? 1 : 0;
        const refCount = Math.max(0, total - hasDef);

        // Anchor to the function name line (not the FUNCTION keyword),
        // so the lens sits just above e.g. Alarm_Filter(STRING sTagName)
        const nameLine = f.location.range.start.line;
        const anchor = new vscode.Position(nameLine, 0);
        const lens = new vscode.CodeLens(
          new vscode.Range(anchor, anchor),
          {
            title: refCount === 1 ? "1 reference" : `${refCount} references`,
            command: "editor.action.findReferences",
            arguments: [document.uri, f.location.range.start],
          },
        );
        lenses.push(lens);
      }

      return lenses;
    },
  };
}
