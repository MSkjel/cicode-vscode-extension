import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import { buildIgnoreSpans, isCommentStart } from "../../shared/textUtils";
import { scanBlocks } from "./formatter";

export function makeFolding(indexer: Indexer): vscode.FoldingRangeProvider {
  return {
    provideFoldingRanges(doc): vscode.FoldingRange[] {
      // Functions: from the end of the header through END.
      const out: vscode.FoldingRange[] = indexer
        .getFunctionRanges(doc.uri.fsPath)
        .map(
          (f) =>
            new vscode.FoldingRange(
              f.bodyRange.start.line,
              f.bodyRange.end.line,
              vscode.FoldingRangeKind.Region,
            ),
        );

      const text = doc.getText();
      const spans = buildIgnoreSpans(text, { includeFunctionHeaders: false });
      const add = (
        start: number,
        end: number,
        kind?: vscode.FoldingRangeKind,
      ) => {
        if (end > start) out.push(new vscode.FoldingRange(start, end, kind));
      };

      // IF, WHILE, FOR and SELECT CASE blocks, one range per clause (ELSE,
      // CASE), each ending above the line that closes it so END stays visible.
      for (const b of scanBlocks(text, spans).blocks) {
        if (b.kind === "FUNCTION") continue;
        const bounds = [b.openLine, ...b.splitLines];
        if (b.closeLine !== -1) bounds.push(b.closeLine);
        for (let k = 0; k + 1 < bounds.length; k++) {
          add(bounds[k], bounds[k + 1] - 1);
        }
        if (b.kind === "SELECT" && b.closeLine !== -1) {
          add(b.openLine, b.closeLine - 1);
        }
      }

      // Comments: a /* */ block over several lines, or consecutive lines
      // that hold only a `//` or `!` comment.
      let runStart = -1;
      let runEnd = -1;
      let si = 0;
      for (let line = 0; line < doc.lineCount; line++) {
        const t = doc.lineAt(line);
        const lineStart = doc.offsetAt(t.range.start);
        const first = lineStart + t.firstNonWhitespaceCharacterIndex;
        while (si < spans.length && spans[si][1] <= first) si++;
        const span =
          !t.isEmptyOrWhitespace && si < spans.length && spans[si][0] === first
            ? spans[si]
            : null;
        const isComment = span !== null && isCommentStart(text, span[0]);
        const block = isComment && text[span![0] + 1] === "*";
        const blockEnd = block ? doc.positionAt(span![1]).line : line;
        const lineComment =
          isComment && !block && span![1] >= lineStart + t.text.length;
        if (lineComment) {
          if (runStart === -1) runStart = line;
          runEnd = line;
          continue;
        }
        if (runStart !== -1)
          add(runStart, runEnd, vscode.FoldingRangeKind.Comment);
        runStart = -1;
        if (block && blockEnd > line) {
          add(line, blockEnd, vscode.FoldingRangeKind.Comment);
          line = blockEnd;
        }
      }
      if (runStart !== -1)
        add(runStart, runEnd, vscode.FoldingRangeKind.Comment);
      return out;
    },
  };
}
