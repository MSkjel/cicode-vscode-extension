import * as vscode from "vscode";
import type { Rule } from "../rule";
import type { CheckContext } from "../context";
import { diag } from "../diag";
import { inSpan } from "../../../shared/textUtils";
import { BLOCK_START_KEYWORDS } from "../../../shared/constants";

/**
 * Searches forward from `startPos` for `keyword` respecting
 * parenthesis depth and stopping at statement boundaries.
 */
const THEN_RE = /^THEN\b/i;
const DO_RE = /^DO\b/i;

function findKeywordAfter(
  text: string,
  ignoreNoHeaders: Array<[number, number]>,
  startPos: number,
  keywordRe: RegExp,
  maxRange: number,
): boolean {
  let searchPos = startPos;
  let parenDepth = 0;
  const maxSearch = Math.min(startPos + maxRange, text.length);

  while (searchPos < maxSearch) {
    if (inSpan(searchPos, ignoreNoHeaders)) {
      searchPos++;
      continue;
    }

    const ch = text[searchPos];

    if (ch === "(") {
      parenDepth++;
      searchPos++;
      continue;
    } else if (ch === ")") {
      parenDepth--;
      searchPos++;
      continue;
    }

    if (parenDepth === 0) {
      const prevChar = searchPos > 0 ? text[searchPos - 1] : " ";
      if (!/[A-Za-z0-9_]/.test(prevChar)) {
        const slice = text.slice(searchPos, searchPos + 10);
        if (keywordRe.test(slice)) return true;

        const wordMatch = /^([A-Za-z]+)\b/.exec(
          text.slice(searchPos, searchPos + 10),
        );
        if (wordMatch) {
          const w = wordMatch[1].toUpperCase();
          if (w === "END" || BLOCK_START_KEYWORDS.has(w)) return false;
        }
      }
    }

    searchPos++;
  }

  return false;
}

/**
 * Checks that:
 * - E2032: every IF has a matching THEN
 * - E2033: every WHILE has a matching DO
 */
export const controlFlowRule: Rule = {
  id: "controlFlow",

  check({
    text,
    ignore,
    ignoreNoHeaders,
    doc,
    diagnosticsEnabled,
  }: CheckContext): vscode.Diagnostic[] {
    if (!diagnosticsEnabled) return [];

    const diags: vscode.Diagnostic[] = [];

    const ifRe = /\bIF\b/gi;
    let m: RegExpExecArray | null;

    while ((m = ifRe.exec(text))) {
      if (inSpan(m.index, ignoreNoHeaders)) continue;
      if (inSpan(m.index, ignore)) continue;

      if (
        !findKeywordAfter(text, ignoreNoHeaders, m.index + 2, THEN_RE, 10000)
      ) {
        const pos = doc.positionAt(m.index);
        diags.push(
          diag(
            new vscode.Range(pos, pos.translate(0, 2)),
            "IF statement requires THEN keyword.",
            vscode.DiagnosticSeverity.Error,
            "E2032",
          ),
        );
      }
    }

    const whileRe = /\bWHILE\b/gi;
    while ((m = whileRe.exec(text))) {
      if (inSpan(m.index, ignoreNoHeaders)) continue;
      if (inSpan(m.index, ignore)) continue;

      if (!findKeywordAfter(text, ignoreNoHeaders, m.index + 5, DO_RE, 10000)) {
        const pos = doc.positionAt(m.index);
        diags.push(
          diag(
            new vscode.Range(pos, pos.translate(0, 5)),
            "WHILE statement requires DO keyword.",
            vscode.DiagnosticSeverity.Error,
            "E2033",
          ),
        );
      }
    }

    return diags;
  },
};
