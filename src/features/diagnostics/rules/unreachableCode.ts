import * as vscode from "vscode";
import type { Rule } from "../rule";
import type { CheckContext } from "../context";
import { diag } from "../diag";
import { inSpan } from "../../../shared/textUtils";
import { getFunctionBodyText } from "../../../shared/parseHelpers";
import {
  BLOCK_OPENERS,
  STRUCTURAL_KEYWORDS,
  TOKEN_RE,
} from "../../../shared/constants";

/**
 * Returns the position in `body` just after the RETURN statement starting at
 * `pos`. Handles semicolon-terminated, newline-terminated, and multi-line
 */
function skipReturnStatement(body: string, pos: number): number {
  let parenDepth = 0;
  let i = pos;

  while (i < body.length) {
    const ch = body[i];

    if (ch === "(") {
      parenDepth++;
    } else if (ch === ")") {
      parenDepth--;
    } else if (ch === ";" && parenDepth === 0) {
      return i + 1;
    } else if ((ch === "\n" || ch === "\r") && parenDepth === 0) {
      // Look backward for the last non-whitespace chars to detect continuations.
      let k = i - 1;
      while (k >= pos && (body[k] === " " || body[k] === "\t")) k--;

      // Symbol operators: + - * / ,
      if (k >= pos && /[+\-*\/,]/.test(body[k])) {
        i++;
        continue;
      }

      // Word operators
      if (k >= pos && /[A-Za-z]/.test(body[k])) {
        let wordEnd = k + 1;
        let wordStart = k;
        while (wordStart > pos && /[A-Za-z]/.test(body[wordStart - 1]))
          wordStart--;
        const lastWord = body.slice(wordStart, wordEnd).toUpperCase();
        if (lastWord === "OR" || lastWord === "AND" || lastWord === "NOT") {
          i++;
          continue;
        }
      }

      return ch === "\r" && body[i + 1] === "\n" ? i + 2 : i + 1;
    }

    i++;
  }

  return i;
}

export const unreachableCodeRule: Rule = {
  id: "unreachableCode",

  check({
    text,
    ignoreNoHeaders,
    indexer,
    doc,
    diagnosticsEnabled,
  }: CheckContext): vscode.Diagnostic[] {
    if (!diagnosticsEnabled) return [];

    const diags: vscode.Diagnostic[] = [];

    for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
      const { body, bodyStartAbs } = getFunctionBodyText(f, text, doc);

      let depth = 0;
      let returnSeenAtDepthZero = false;

      TOKEN_RE.lastIndex = 0;
      const tokenRe = TOKEN_RE;
      let m: RegExpExecArray | null;

      while ((m = tokenRe.exec(body))) {
        const absPos = bodyStartAbs + m.index;
        if (inSpan(absPos, ignoreNoHeaders)) continue;

        const word = m[1].toUpperCase();

        if (word === "END") {
          if (depth === 0) break;
          depth--;
        } else if (BLOCK_OPENERS.has(word)) {
          if (returnSeenAtDepthZero && depth === 0) {
            const pos = doc.positionAt(absPos);
            diags.push(
              diag(
                new vscode.Range(pos, pos.translate(0, m[1].length)),
                "Unreachable code after RETURN.",
                vscode.DiagnosticSeverity.Warning,
              ),
            );
            break;
          }
          depth++;
        } else if (word === "RETURN") {
          if (depth === 0) {
            returnSeenAtDepthZero = true;
            tokenRe.lastIndex = skipReturnStatement(
              body,
              m.index + m[0].length,
            );
          }
        } else if (!STRUCTURAL_KEYWORDS.has(word)) {
          if (returnSeenAtDepthZero && depth === 0) {
            const pos = doc.positionAt(absPos);
            diags.push(
              diag(
                new vscode.Range(pos, pos.translate(0, m[1].length)),
                "Unreachable code after RETURN.",
                vscode.DiagnosticSeverity.Warning,
              ),
            );
            break;
          }
        }
      }
    }

    return diags;
  },
};
