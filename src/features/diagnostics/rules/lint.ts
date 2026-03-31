import * as vscode from "vscode";
import type { Rule } from "../rule";
import type { CheckContext } from "../context";
import { hint, info } from "../diag";
import { inSpan, TYPE_RE, isCommentLine } from "../../../shared/textUtils";
import {
  getFunctionBodyText,
  trackBlockDepth,
} from "../../../shared/parseHelpers";
import {
  BLOCK_OPENERS,
  BLOCK_START_KEYWORDS,
  STRUCTURAL_KEYWORDS,
  STATEMENT_BOUNDARY_KEYWORDS,
  TOKEN_RE,
  DECLARATION_LINE_RE,
} from "../../../shared/constants";

const KEYWORD_CASE_RE = new RegExp(
  `\\b(${[
    ...BLOCK_START_KEYWORDS,
    ...STRUCTURAL_KEYWORDS,
    ...STATEMENT_BOUNDARY_KEYWORDS,
    "RETURN",
    "GLOBAL",
    "MODULE",
  ]
    .map((k) => k.toLowerCase())
    .join("|")})\\b`,
);
const NUM_RE = /\b(\d+(?:\.\d+)?)\b/g;
const ARRAY_INDEX_RE = /\[\s*\d+\s*\]/;

/** Warn when lines exceed the configured maximum length. */
export const lineLengthRule: Rule = {
  id: "lineLength",

  check({ doc, cfg }: CheckContext): vscode.Diagnostic[] {
    if (!cfg.enabled || cfg.maxLineLength <= 0) return [];

    const diags: vscode.Diagnostic[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const L = doc.lineAt(i);
      const s = L.text;
      if (isCommentLine(s)) continue;
      if (s.length > cfg.maxLineLength) {
        diags.push(
          hint(
            new vscode.Range(L.range.start, L.range.end),
            `Line exceeds ${cfg.maxLineLength} chars (${s.length}).`,
          ),
        );
      }
    }
    return diags;
  },
};

/** Warn when a line mixes tabs and spaces in its leading whitespace. */
export const mixedIndentRule: Rule = {
  id: "mixedIndent",

  check({ doc, cfg }: CheckContext): vscode.Diagnostic[] {
    if (!cfg.enabled || !cfg.warnMixedIndent) return [];

    const diags: vscode.Diagnostic[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const L = doc.lineAt(i);
      const leading = L.text.match(/^\s*/)?.[0] || "";
      if (/^(?=.*\t)(?=.* )/.test(leading)) {
        diags.push(
          hint(
            new vscode.Range(
              new vscode.Position(i, 0),
              new vscode.Position(i, leading.length),
            ),
            "Mixed indentation (tabs and spaces).",
          ),
        );
      }
    }
    return diags;
  },
};

/** Suggest trailing semicolons on variable declaration lines. */
export const missingSemicolonRule: Rule = {
  id: "missingSemicolon",

  check({ doc, cfg }: CheckContext): vscode.Diagnostic[] {
    if (!cfg.enabled || !cfg.warnMissingSemicolons) return [];

    const diags: vscode.Diagnostic[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const L = doc.lineAt(i);
      const s = L.text;
      if (isCommentLine(s)) continue;

      if (/^\s*((?:GLOBAL|MODULE)\s+)?(\w+)\s+\w+(\s*,\s*\w+)*\s*$/i.test(s)) {
        const typeWord =
          /^\s*(?:(?:GLOBAL|MODULE)\s+)?(\w+)/i.exec(s)?.[1] || "";
        if (TYPE_RE.test(typeWord) && !/;\s*(\/\/|!|$)/.test(s)) {
          diags.push(
            info(
              new vscode.Range(L.range.start, L.range.end),
              "Consider ending declarations with a semicolon.",
            ),
          );
        }
      }
    }
    return diags;
  },
};

/** Suggest using UPPERCASE for Cicode keywords. */
export const keywordCaseRule: Rule = {
  id: "keywordCase",

  check({ doc, cfg, ignoreNoHeaders }: CheckContext): vscode.Diagnostic[] {
    if (!cfg.enabled || !cfg.warnKeywordCase) return [];

    const diags: vscode.Diagnostic[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const s = doc.lineAt(i).text;
      const m = s.match(KEYWORD_CASE_RE);
      if (m && m[0] !== m[0].toUpperCase()) {
        const idx = m.index || 0;
        if (inSpan(doc.offsetAt(new vscode.Position(i, idx)), ignoreNoHeaders))
          continue;
        diags.push(
          hint(
            new vscode.Range(
              new vscode.Position(i, idx),
              new vscode.Position(i, idx + m[0].length),
            ),
            `Prefer UPPERCASE keyword '${m[0].toUpperCase()}'.`,
          ),
        );
      }
    }
    return diags;
  },
};

/** Warn on magic numbers (hardcoded literals other than 0, 1, -1). */
export const magicNumbersRule: Rule = {
  id: "magicNumbers",

  check({ doc, ignoreNoHeaders, cfg }: CheckContext): vscode.Diagnostic[] {
    if (!cfg.enabled || !cfg.warnMagicNumbers) return [];

    const diags: vscode.Diagnostic[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const L = doc.lineAt(i);
      const s = L.text;
      if (isCommentLine(s)) continue;

      const isDeclarationLine = DECLARATION_LINE_RE.test(s);
      if (isDeclarationLine) continue;

      NUM_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = NUM_RE.exec(s))) {
        const num = parseFloat(m[1]);
        const absPos = doc.offsetAt(new vscode.Position(i, m.index));
        const isArrayIndex = ARRAY_INDEX_RE.test(
          s.slice(Math.max(0, m.index - 2), m.index + m[1].length + 2),
        );

        if (
          num !== 0 &&
          num !== 1 &&
          num !== -1 &&
          !isArrayIndex &&
          !inSpan(absPos, ignoreNoHeaders)
        ) {
          diags.push(
            hint(
              new vscode.Range(
                new vscode.Position(i, m.index),
                new vscode.Position(i, m.index + m[1].length),
              ),
              `Consider using a named constant instead of magic number '${m[1]}'.`,
            ),
          );
        }
      }
    }
    return diags;
  },
};

/**
 * Warns when function calls are nested deeper than cfg.maxCallNestingDepth.
 * Uses a stack to distinguish function-call parens from grouping parens.
 * Disabled when maxCallNestingDepth is 0.
 */
export const callNestingRule: Rule = {
  id: "callNesting",

  check({
    text,
    ignoreNoHeaders,
    doc,
    cfg,
  }: CheckContext): vscode.Diagnostic[] {
    if (!cfg.enabled || !cfg.maxCallNestingDepth) return [];

    const diags: vscode.Diagnostic[] = [];
    // Stack entries: true = function-call paren, false = grouping paren
    const stack: boolean[] = [];
    let callDepth = 0;
    let lastFiredDepth = 0; // avoid re-firing on every char inside the deep call

    for (let i = 0; i < text.length; i++) {
      if (inSpan(i, ignoreNoHeaders)) continue;

      const ch = text[i];

      if (ch === "(") {
        let j = i - 1;
        while (j >= 0 && (text[j] === " " || text[j] === "\t")) j--;
        const isCallParen = j >= 0 && /[A-Za-z0-9_]/.test(text[j]);

        stack.push(isCallParen);
        if (isCallParen) {
          callDepth++;
          if (
            callDepth > cfg.maxCallNestingDepth &&
            callDepth > lastFiredDepth
          ) {
            lastFiredDepth = callDepth;
            const pos = doc.positionAt(i);
            diags.push(
              hint(
                new vscode.Range(pos, pos.translate(0, 1)),
                `Function call nested ${callDepth} levels deep (max ${cfg.maxCallNestingDepth}).`,
              ),
            );
          }
        }
      } else if (ch === ")") {
        if (stack.length > 0) {
          const wasCall = stack.pop()!;
          if (wasCall) {
            callDepth--;
            if (callDepth <= cfg.maxCallNestingDepth) {
              lastFiredDepth = 0; // reset so we can fire again if depth spikes again
            }
          }
        }
      }
    }

    return diags;
  },
};

/**
 * Warns when control flow blocks are nested deeper than
 * cfg.maxBlockNestingDepth inside a function body. Disabled when 0.
 */
export const blockNestingRule: Rule = {
  id: "blockNesting",

  check({
    text,
    ignoreNoHeaders,
    indexer,
    doc,
    cfg,
  }: CheckContext): vscode.Diagnostic[] {
    if (!cfg.enabled || !cfg.maxBlockNestingDepth) return [];

    const diags: vscode.Diagnostic[] = [];

    for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
      const { body, bodyStartAbs } = getFunctionBodyText(f, text, doc);
      const blockState = { depth: 0, endLine: -1 };

      TOKEN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;

      while ((m = TOKEN_RE.exec(body))) {
        const absPos = bodyStartAbs + m.index;
        if (inSpan(absPos, ignoreNoHeaders)) continue;

        const word = m[1].toUpperCase();

        if (trackBlockDepth(word, absPos, doc, blockState) === "continue")
          continue;

        if (
          word !== "END" &&
          BLOCK_OPENERS.has(word) &&
          blockState.depth > cfg.maxBlockNestingDepth
        ) {
          const pos = doc.positionAt(absPos);
          diags.push(
            hint(
              new vscode.Range(pos, pos.translate(0, m[1].length)),
              `Block nested ${blockState.depth} levels deep (max ${cfg.maxBlockNestingDepth}).`,
            ),
          );
        }
      }
    }

    return diags;
  },
};
