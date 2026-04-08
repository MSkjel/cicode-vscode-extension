import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import {
  buildIgnoreSpans,
  inSpan,
  cleanParamName,
  argLooksNamed,
} from "../../shared/textUtils";
import {
  findMatchingParen,
  sliceTopLevelArgSpans,
} from "../../shared/parseHelpers";
import { CALL_RE } from "../../shared/constants";

export function makeInlay(
  indexer: Indexer,
): vscode.InlayHintsProvider & vscode.Disposable {
  const _onDidChange = new vscode.EventEmitter<void>();
  const sub = indexer.onIndexed(() => _onDidChange.fire());

  return {
    onDidChangeInlayHints: _onDidChange.event,
    dispose() {
      sub.dispose();
      _onDidChange.dispose();
    },
    provideInlayHints(doc, _range) {
      const out: vscode.InlayHint[] = [];
      const full = doc.getText();
      const ignore = buildIgnoreSpans(full);
      CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;

      while ((m = CALL_RE.exec(full))) {
        const name = m[1];
        const openAbs = m.index + m[0].lastIndexOf("(");
        if (inSpan(openAbs, ignore)) continue;

        const entry = indexer.getFunction(name);
        if (!entry || !entry.params || !entry.params.length) continue;

        const closeAbs = findMatchingParen(full, openAbs, ignore);
        if (closeAbs === -1) continue;

        const argSpans = sliceTopLevelArgSpans(
          full,
          openAbs + 1,
          closeAbs,
          ignore,
        );
        const max = Math.min(argSpans.length, entry.params.length);

        for (let i = 0; i < max; i++) {
          const { start, end } = argSpans[i];
          const piece = full.slice(start, end);
          if (argLooksNamed(piece)) continue;

          const pos = doc.positionAt(start);
          out.push(
            new vscode.InlayHint(
              pos,
              `${cleanParamName(entry.params[i])}:`,
              vscode.InlayHintKind.Parameter,
            ),
          );
        }
      }
      return out;
    },
  };
}
