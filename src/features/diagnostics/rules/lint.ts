import * as vscode from "vscode";
import type { Rule } from "../rule";
import type { CheckContext } from "../context";
import { hint, info } from "../diag";
import { inSpan, isCommentLine } from "../../../shared/textUtils";
import {
  BLOCK_START_KEYWORDS,
  STRUCTURAL_KEYWORDS,
  STATEMENT_BOUNDARY_KEYWORDS,
  DECLARATION_LINE_RE,
  CICODE_TYPES,
  NAME_PATTERN,
} from "../../../shared/constants";
import {
  functionBody,
  isIdentifier,
  isToken,
  tokensOf,
  walkStatements,
} from "./statements";

// Keywords the keyword-case rule looks at.
const CASE_KEYWORDS = new Set([
  ...BLOCK_START_KEYWORDS,
  ...STRUCTURAL_KEYWORDS,
  ...STATEMENT_BOUNDARY_KEYWORDS,
  "RETURN",
  "GLOBAL",
  "MODULE",
]);

// A line holding only `[GLOBAL|MODULE] type name {, name}`.
const BARE_DECLARATION_RE = new RegExp(
  `^\\s*(?:(?:GLOBAL|MODULE)\\s+)?(${NAME_PATTERN})\\s+${NAME_PATTERN}(?:\\s*,\\s*${NAME_PATTERN})*\\s*$`,
  "i",
);

/** Hint at lines longer than the configured maximum. */
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

/** Hint at leading whitespace that mixes tabs and spaces. */
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

/** Suggest a semicolon after a declaration (style: the compiler never needs one). */
export const missingSemicolonRule: Rule = {
  id: "missingSemicolon",

  check({ doc, cfg, ignore }: CheckContext): vscode.Diagnostic[] {
    if (!cfg.enabled || !cfg.warnMissingSemicolons) return [];

    const diags: vscode.Diagnostic[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const L = doc.lineAt(i);
      const m = BARE_DECLARATION_RE.exec(L.text);
      // Only the six types declare anything (`LONG x` is no declaration).
      if (!m || !CICODE_TYPES.has(m[1].toUpperCase())) continue;
      // Skip lines inside block comments/strings/function headers (e.g.
      // commented-out declarations or the last parameter line of a
      // multi-line header).
      const at = doc.offsetAt(
        new vscode.Position(i, L.firstNonWhitespaceCharacterIndex),
      );
      if (inSpan(at, ignore)) continue;
      diags.push(
        info(
          new vscode.Range(L.range.start, L.range.end),
          "Consider ending declarations with a semicolon.",
        ),
      );
    }
    return diags;
  },
};

/** Suggest UPPERCASE keywords (style: keywords are case-insensitive). */
export const keywordCaseRule: Rule = {
  id: "keywordCase",

  check({ doc, text, cfg }: CheckContext): vscode.Diagnostic[] {
    if (!cfg.enabled || !cfg.warnKeywordCase) return [];

    const diags: vscode.Diagnostic[] = [];
    for (const t of tokensOf(text)) {
      if (t.kind !== "w" || !CASE_KEYWORDS.has(t.text)) continue;
      if (text.slice(t.start, t.end) === t.text) continue;
      diags.push(
        hint(
          new vscode.Range(doc.positionAt(t.start), doc.positionAt(t.end)),
          `Prefer UPPERCASE keyword '${t.text}'.`,
        ),
      );
    }
    return diags;
  },
};

/** Hint at magic numbers (literals other than 0 and 1) in code, except in
 *  declarations, array indexes and format widths. */
export const magicNumbersRule: Rule = {
  id: "magicNumbers",

  check({ doc, text, cfg }: CheckContext): vscode.Diagnostic[] {
    if (!cfg.enabled || !cfg.warnMagicNumbers) return [];

    const diags: vscode.Diagnostic[] = [];
    const T = tokensOf(text);
    let line = -1;
    let declarationLine = false;
    for (let k = 0; k < T.length; k++) {
      const t = T[k];
      if (t.kind !== "n") continue;
      const pos = doc.positionAt(t.start);
      if (pos.line !== line) {
        line = pos.line;
        declarationLine = DECLARATION_LINE_RE.test(doc.lineAt(line).text);
      }
      if (declarationLine || isToken(T[k - 1], ":")) continue;
      if (isToken(T[k - 1], "[") && isToken(T[k + 1], "]")) continue;
      const value = Number(t.text);
      if (Number.isNaN(value) || value === 0 || value === 1) continue;
      diags.push(
        hint(
          new vscode.Range(pos, doc.positionAt(t.end)),
          `Consider using a named constant instead of magic number '${t.text}'.`,
        ),
      );
    }
    return diags;
  },
};

/**
 * Hints at function calls nested deeper than cfg.maxCallNestingDepth: a
 * '(' after a name opens a call, any other '(' groups. Disabled when
 * maxCallNestingDepth is 0.
 */
export const callNestingRule: Rule = {
  id: "callNesting",

  check({ text, doc, cfg }: CheckContext): vscode.Diagnostic[] {
    if (!cfg.enabled || !cfg.maxCallNestingDepth) return [];

    const diags: vscode.Diagnostic[] = [];
    const T = tokensOf(text);
    // Stack entries: true = function-call paren, false = grouping paren
    const stack: boolean[] = [];
    let callDepth = 0;
    let lastFiredDepth = 0; // fire once per excursion past the limit

    for (let k = 0; k < T.length; k++) {
      const t = T[k];
      if (isToken(t, "(")) {
        const isCall = k > 0 && isIdentifier(T[k - 1]);
        stack.push(isCall);
        if (!isCall) continue;
        callDepth++;
        if (callDepth > cfg.maxCallNestingDepth && callDepth > lastFiredDepth) {
          lastFiredDepth = callDepth;
          diags.push(
            hint(
              new vscode.Range(doc.positionAt(t.start), doc.positionAt(t.end)),
              `Function call nested ${callDepth} levels deep (max ${cfg.maxCallNestingDepth}).`,
            ),
          );
        }
      } else if (isToken(t, ")") && stack.length > 0) {
        if (stack.pop()) {
          callDepth--;
          if (callDepth <= cfg.maxCallNestingDepth) lastFiredDepth = 0;
        }
      }
    }

    return diags;
  },
};

/**
 * Hints at IF, WHILE, FOR and SELECT blocks nested deeper than
 * cfg.maxBlockNestingDepth inside a function body. Disabled when 0.
 */
export const blockNestingRule: Rule = {
  id: "blockNesting",

  check({ text, indexer, doc, cfg }: CheckContext): vscode.Diagnostic[] {
    if (!cfg.enabled || !cfg.maxBlockNestingDepth) return [];

    const diags: vscode.Diagnostic[] = [];

    for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
      const { tokens: T, stmts } = functionBody(text, f);
      walkStatements(stmts, (s) => {
        const block =
          s.kind === "if" ||
          s.kind === "while" ||
          s.kind === "select" ||
          (s.kind === "for" && (s.forTo ?? -1) >= 0);
        const level = s.depth + 1;
        if (!block || level <= cfg.maxBlockNestingDepth) return;
        const t = T[s.start];
        diags.push(
          hint(
            new vscode.Range(doc.positionAt(t.start), doc.positionAt(t.end)),
            `Block nested ${level} levels deep (max ${cfg.maxBlockNestingDepth}).`,
          ),
        );
      });
    }

    return diags;
  },
};
