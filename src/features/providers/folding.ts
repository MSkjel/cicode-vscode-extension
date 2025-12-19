import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";

export function makeFolding(indexer: Indexer): vscode.FoldingRangeProvider {
  return {
    provideFoldingRanges(doc): vscode.FoldingRange[] {
      return indexer.getFunctionRanges(doc.uri.fsPath).map((f) => ({
        start: f.bodyRange.start.line,
        end: f.bodyRange.end.line,
        kind: vscode.FoldingRangeKind.Region,
      }));
    },
  };
}
