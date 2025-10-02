import type * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";

export function makeFolding(indexer: Indexer): vscode.FoldingRangeProvider {
  return {
    provideFoldingRanges(doc) {
      return (indexer.getFunctionRanges(doc.uri.fsPath) || []).map(
        (f: any) => ({
          start: f.bodyRange.start.line,
          end: f.bodyRange.end.line,
          kind: 2 as any,
        }),
      );
    },
  } as vscode.FoldingRangeProvider;
}
