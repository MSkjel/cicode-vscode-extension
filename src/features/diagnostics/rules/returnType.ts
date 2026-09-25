import * as vscode from "vscode";
import type { Rule } from "../rule";
import type { CheckContext } from "../context";
import { diag } from "../diag";
import { KEYWORDS, lex, type Token } from "../../../core/indexer/lexer";
import { CICODE_TYPES, INCLUDE_BOOL_LABELS } from "../../../shared/constants";
import type { Indexer } from "../../../core/indexer/indexer";
import { usesStructuralLabel } from "./statements";

// Operators that continue an expression after an operand.
const BINARY_OPS = new Set([
  "+",
  "-",
  "*",
  "/",
  "=",
  "<>",
  "<",
  ">",
  "<=",
  ">=",
  ":",
  "AND",
  "OR",
  "MOD",
  "BITAND",
  "BITOR",
  "BITXOR",
]);

const LITERAL_RE = /^\s*(?:-?\s*\d[\w.]*|"(?:[^"^]|\^.)*")\s*$/s;

const isOp = (t: Token | undefined, s: string) =>
  t !== undefined && t.kind === "p" && t.text === s;

const isKeyword = (t: Token | undefined) =>
  t !== undefined && t.kind === "w" && KEYWORDS.has(t.text);

const isBinaryOp = (t: Token | undefined) =>
  t !== undefined && t.kind !== "s" && t.kind !== "n" && BINARY_OPS.has(t.text);

/** Index of the token closing the bracket at `i` (`(` or `[`), or -1. */
function closing(tokens: readonly Token[], i: number, end: number): number {
  const open = tokens[i].text;
  const close = open === "(" ? ")" : "]";
  let depth = 0;
  for (let k = i; k < end; k++) {
    if (isOp(tokens[k], open)) depth++;
    else if (isOp(tokens[k], close) && --depth === 0) return k;
  }
  return -1;
}

/** Index of the first token starting at or after `offset`. */
function firstTokenAt(tokens: readonly Token[], offset: number): number {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (tokens[mid].start < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type Operand = "call" | "literal" | "variable" | "computed" | "unknown";

/**
 * Kind of the operand at tokens[i] (labels decide by what they expand to;
 * a function-like label or a function named without parentheses is left
 * unknown), and the index after it.
 */
function operand(
  indexer: Indexer,
  tokens: readonly Token[],
  i: number,
  end: number,
): { kind: Operand; next: number } {
  const t = tokens[i];
  if (!t || i >= end) return { kind: "unknown", next: i };
  if (t.kind === "n") return { kind: "literal", next: i + 1 };
  if (t.kind === "s") {
    return {
      kind: t.text.startsWith('"') ? "literal" : "unknown",
      next: i + 1,
    };
  }
  if (isOp(t, "(")) {
    const j = closing(tokens, i, end);
    if (j === -1) return { kind: "unknown", next: end };
    const inner = operand(indexer, tokens, i + 1, j);
    const kind =
      inner.next === j
        ? inner.kind
        : isBinaryOp(tokens[inner.next])
          ? "computed"
          : "unknown";
    return { kind, next: j + 1 };
  }
  if (t.kind !== "w" || KEYWORDS.has(t.text)) {
    return { kind: "unknown", next: i + 1 };
  }

  const fn = indexer.getFunction(t.text);
  if (isOp(tokens[i + 1], "(")) {
    const j = closing(tokens, i + 1, end);
    const labelled =
      fn?.origin === "label" ||
      indexer.getBuiltinFunction(t.text)?.origin === "label" ||
      indexer.getLabel(t.text) !== undefined;
    return {
      kind: labelled || j === -1 ? "unknown" : "call",
      next: j === -1 ? end : j + 1,
    };
  }
  const label = indexer.getLabel(t.text);
  if (label) {
    return {
      kind: LITERAL_RE.test(label.expr) ? "literal" : "unknown",
      next: i + 1,
    };
  }
  if (INCLUDE_BOOL_LABELS.has(t.text)) return { kind: "literal", next: i + 1 };
  if (fn && !indexer.getVariables(t.text).length) {
    return { kind: "unknown", next: i + 1 };
  }
  return { kind: "variable", next: i + 1 };
}

/**
 * Whether the statement at tokens[i], right after RETURN in a void function,
 * leaves a value (W1023). RETURN takes no value there, so the tokens form the
 * next statement: an assignment or a plain call leaves nothing. Otherwise the
 * first operand decides: a literal or a variable does, a call doesn't (so
 * `-Call()` and `(Call()) + 1` don't either, while `Call() + 1` does).
 */
function leavesValue(
  indexer: Indexer,
  tokens: readonly Token[],
  i: number,
  end: number,
): boolean {
  const t = tokens[i];
  if (!t || i >= end || isOp(t, ";")) return false;

  if (t.kind === "w" && !KEYWORDS.has(t.text)) {
    const first = operand(indexer, tokens, i, end);
    if (first.kind === "call") return isBinaryOp(tokens[first.next]);
    if (first.kind === "literal") return true;
    if (first.kind !== "variable") return false;
    let k = i + 1;
    if (isOp(tokens[k], "[")) {
      const j = closing(tokens, k, end);
      if (j === -1) return false;
      k = j + 1;
    }
    return !isOp(tokens[k], "=");
  }

  let k = i;
  while (
    isOp(tokens[k], "-") ||
    (tokens[k]?.kind === "w" && tokens[k].text === "NOT")
  ) {
    k++;
  }
  const first = operand(indexer, tokens, k, end);
  if (first.kind === "literal" || first.kind === "variable") return true;
  return first.kind === "computed" && k === i;
}

/** Return type the compiler sees: the written type, or a label in front of
 *  FUNCTION that expands to one. Undefined when the type isn't a Cicode type
 *  (the header is an error then). */
function returnTypeOf(
  indexer: Indexer,
  tokens: readonly Token[],
  written: string,
  keywordAt: number,
): string | undefined {
  const type = written.toUpperCase();
  if (type !== "VOID") return CICODE_TYPES.has(type) ? type : undefined;
  const prev = tokens[firstTokenAt(tokens, keywordAt) - 1];
  if (prev?.kind === "w" && !KEYWORDS.has(prev.text)) {
    const expr = indexer.getLabel(prev.text)?.expr.trim().toUpperCase();
    if (expr && CICODE_TYPES.has(expr)) return expr;
  }
  return "VOID";
}

/** True when a label used in tokens [start, end) supplies a RETURN. */
function labelReturns(
  indexer: Indexer,
  text: string,
  tokens: readonly Token[],
  start: number,
  end: number,
): boolean {
  for (let k = start; k < end; k++) {
    const t = tokens[k];
    if (t.kind !== "w" || KEYWORDS.has(t.text)) continue;
    const name = text.slice(t.start, t.end);
    const fn = indexer.getFunction(name);
    const expr =
      fn?.origin === "label" ? fn.expr : indexer.getLabel(name)?.expr;
    if (expr && lex(expr).tokens.some((x) => x.text === "RETURN")) {
      return true;
    }
  }
  return false;
}

/**
 * Validates RETURN statements:
 * - W1023: RETURN followed by a value in a void function
 * - E2041: RETURN without a value in a typed function
 * - E2037: typed function without any RETURN of a value
 */
export const returnTypeRule: Rule = {
  id: "returnType",

  check({
    text,
    indexer,
    doc,
    diagnosticsEnabled,
  }: CheckContext): vscode.Diagnostic[] {
    if (!diagnosticsEnabled) return [];

    const diags: vscode.Diagnostic[] = [];
    const fns = indexer.getFunctionRanges(doc.uri.fsPath);
    if (!fns.length) return diags;
    const { tokens } = lex(text);

    for (const f of fns) {
      const returnType = returnTypeOf(
        indexer,
        tokens,
        f.returnType,
        f.headerIndex,
      );
      if (!returnType) continue;
      const first = firstTokenAt(tokens, f.startOffset);
      const end = firstTokenAt(tokens, f.endOffset);

      let returnsValue = false;
      let bareReturn = false;
      for (let i = first; i < end; i++) {
        const t = tokens[i];
        if (t.kind !== "w" || t.text !== "RETURN") continue;
        const range = new vscode.Range(
          doc.positionAt(t.start),
          doc.positionAt(t.end),
        );
        const next = tokens[i + 1];

        if (returnType === "VOID") {
          if (leavesValue(indexer, tokens, i + 1, end)) {
            diags.push(
              diag(
                range,
                "Void functions are not supposed to return values.",
                vscode.DiagnosticSeverity.Warning,
                "W1023",
              ),
            );
          }
          continue;
        }

        // The value may follow on another line; a keyword or ';' means none.
        if (
          i + 1 >= end ||
          isOp(next, ";") ||
          (isKeyword(next) && next.text !== "NOT")
        ) {
          bareReturn = true;
          diags.push(
            diag(
              range,
              `Operand expected: RETURN needs a value in this ${returnType} function.`,
              vscode.DiagnosticSeverity.Error,
              "E2041",
            ),
          );
        } else {
          returnsValue = true;
        }
      }

      // Reported at the function's END, as the compiler does. A label may
      // supply the RETURN, or open or close a block and so move the END.
      if (
        returnType !== "VOID" &&
        !returnsValue &&
        !bareReturn &&
        f.closed &&
        // `INT end;`: the END meant as a name closes the function early and
        // the compiler reports what follows it (E2031) instead.
        !(
          tokens[end - 2]?.kind === "w" &&
          CICODE_TYPES.has(tokens[end - 2].text)
        ) &&
        !usesStructuralLabel(indexer, text, tokens, first, end) &&
        !labelReturns(indexer, text, tokens, first, end)
      ) {
        diags.push(
          diag(
            new vscode.Range(
              doc.positionAt(f.endOffset - 3),
              doc.positionAt(f.endOffset),
            ),
            `Function '${f.name}' must return a value.`,
            vscode.DiagnosticSeverity.Error,
            "E2037",
          ),
        );
      }
    }

    return diags;
  },
};
