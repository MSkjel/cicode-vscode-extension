import * as vscode from "vscode";
import type { Rule } from "../rule";
import type { CheckContext } from "../context";
import { diag } from "../diag";
import { inSpan } from "../../../shared/textUtils";
import { TOKEN_RE, DECLARATION_LINE_RE } from "../../../shared/constants";
import {
  getFunctionBodyText,
  trackBlockDepth,
} from "../../../shared/parseHelpers";

/**
 * Warn when a variable declaration appears inside a control flow block
 * (IF/FOR/WHILE/SELECT). Cicode only allows declarations at function scope.
 *
 * Uses token-by-token scanning so that single-line blocks like
 * `IF (...) THEN ... END` and `END SELECT` are handled correctly.
 */
export const invalidDeclarationsRule: Rule = {
  id: "declarationsInBlocks",

  check({
    doc,
    text,
    ignoreNoHeaders,
    indexer,
    cfg,
  }: CheckContext): vscode.Diagnostic[] {
    if (!cfg.enabled || !cfg.warnDeclarationsInBlocks) return [];

    const diags: vscode.Diagnostic[] = [];

    for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
      const { body, bodyStartAbs } = getFunctionBodyText(f, text, doc);
      const blockState = { depth: 0, endLine: -1 };
      // Track which lines we've already flagged to avoid duplicate warnings
      // when multiple declaration tokens appear on the same line.
      const flaggedLines = new Set<number>();

      TOKEN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;

      while ((m = TOKEN_RE.exec(body))) {
        const absPos = bodyStartAbs + m.index;
        if (inSpan(absPos, ignoreNoHeaders)) continue;

        const word = m[1].toUpperCase();

        if (trackBlockDepth(word, absPos, doc, blockState) === "continue")
          continue;

        if (blockState.depth > 0 && word !== "END") {
          const line = doc.positionAt(absPos).line;
          if (!flaggedLines.has(line)) {
            const lineText = doc.lineAt(line).text;
            if (DECLARATION_LINE_RE.test(lineText)) {
              flaggedLines.add(line);
              const L = doc.lineAt(line);
              diags.push(
                diag(
                  new vscode.Range(L.range.start, L.range.end),
                  "Variable declarations are not allowed inside control flow blocks.",
                  vscode.DiagnosticSeverity.Warning,
                ),
              );
            }
          }
        }
      }
    }

    return diags;
  },
};
