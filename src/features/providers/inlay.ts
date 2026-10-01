import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import {
  buildIgnoreSpans,
  inSpan,
  cleanParamName,
} from "../../shared/textUtils";
import {
  findMatchingParen,
  sliceTopLevelArgSpans,
} from "../../shared/parseHelpers";
import { CALL_RE, RESERVED_WORDS } from "../../shared/constants";
import { resolveNameAt } from "./nameAt";

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
    provideInlayHints(doc, range, token) {
      const out: vscode.InlayHint[] = [];
      if (token.isCancellationRequested) return out;
      const full = doc.getText();
      // Spans must come from the live text: the indexer's cached spans lag
      // the document by the reindex debounce, and every offset below
      // indexes `full`.
      const ignore = buildIgnoreSpans(full);

      // Restrict scanning to the requested range, expanded to whole lines.
      // Extend the scan start back to the enclosing function so multi-line
      // calls whose opening paren is above the range still produce hints.
      const reqStartAbs = doc.offsetAt(
        new vscode.Position(range.start.line, 0),
      );
      const endAbs = doc.offsetAt(
        doc.lineAt(Math.min(range.end.line, doc.lineCount - 1)).range.end,
      );
      const encl = indexer.findEnclosingFunction(doc, range.start);
      const startAbs = encl
        ? Math.min(reqStartAbs, doc.offsetAt(encl.headerPos))
        : reqStartAbs;
      const slice = full.slice(startAbs, endAbs);

      CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;

      while ((m = CALL_RE.exec(slice))) {
        if (token.isCancellationRequested) return out;
        const name = m[1];
        // A keyword before '(' is never a call (IF(a), NOT(b), RETURN(1)),
        // even when a function has the keyword's name.
        if (RESERVED_WORDS.has(name.toUpperCase())) continue;
        const openAbs = startAbs + m.index + m[0].lastIndexOf("(");
        if (inSpan(startAbs + m.index, ignore) || inSpan(openAbs, ignore))
          continue;
        // The field of a `Tag.Field` reference is not a call
        if (full[startAbs + m.index - 1] === ".") continue;

        // Not a call where a label constant or a variable has the name
        const r = resolveNameAt(
          indexer,
          doc,
          doc.positionAt(startAbs + m.index),
          name,
        );
        if (r?.kind !== "function") continue;
        const entry = r.fn;
        if (!entry.params || !entry.params.length) continue;

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
          const { start } = argSpans[i];
          // Only emit hints inside the requested range; the scan window may
          // extend above it to catch calls opened before the range.
          if (start < reqStartAbs || start > endAbs) continue;

          // A VARARG built-in's "..." takes the remaining arguments
          const label = cleanParamName(entry.params[i]);
          if (!label || label === "...") break;

          const pos = doc.positionAt(start);
          out.push(
            new vscode.InlayHint(
              pos,
              `${label}:`,
              vscode.InlayHintKind.Parameter,
            ),
          );
        }
      }
      return out;
    },
  };
}
