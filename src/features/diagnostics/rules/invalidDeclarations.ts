import * as vscode from "vscode";
import type { Rule } from "../rule";
import type { CheckContext } from "../context";
import { diag } from "../diag";
import type { Indexer } from "../../../core/indexer/indexer";
import {
  ALL_TYPES,
  CICODE_TYPES,
  RESERVED_WORDS,
} from "../../../shared/constants";
import {
  SCOPE_WORDS,
  closeEnd,
  functionBody,
  isIdentifier,
  isToken,
  labelCertain,
  labelOf,
  lexTokens,
  shortExpr,
  tokenAt,
  tokensOf,
  usesStructuralLabel,
  walkStatements,
  word,
  type Token,
} from "./statements";

// Reserved words that end a local declaration list with E2041 when they
// stand where the name should be. FOR, END, FUNCTION and SELECT start
// other constructs (a statement, the function end, E2076, E2065); NOP, VAR,
// CICODE and CiVBA are reported by the controlFlow rule wherever they occur.
const NO_NAME_WORDS = new Set(
  [...RESERVED_WORDS].filter(
    (w) =>
      ![
        "FOR",
        "END",
        "FUNCTION",
        "SELECT",
        "NOP",
        "VAR",
        "CICODE",
        "CIVBA",
      ].includes(w) &&
      !CICODE_TYPES.has(w) &&
      !SCOPE_WORDS.has(w),
  ),
);

// The compiler's text for the codes this rule reports, put in front of the
// explanation.
const COMPILER_TEXT: Record<string, string> = {
  E2006: "Bad integer value",
  E2008: "Tag expected",
  E2011: "Close bracket expected",
  E2016: "Array size exceeded",
  E2017: "String expected",
  E2024: "Incompatible types",
  E2031: "FUNCTION expected",
  E2041: "Operand expected",
  E2052: "Cannot use an array inside function",
  E2057: "Label argument error",
  W1021: "Possible missing operand between tags",
};

// Largest number of elements of an array (E2016 beyond).
const MAX_ARRAY_ELEMENTS = 32767;

type Where = "local" | "param" | "file";

type Push = (
  a: number,
  b: number,
  message: string,
  code?: string,
  severity?: vscode.DiagnosticSeverity,
) => void;

/**
 * Checks variable declarations the way the compiler reads them:
 * - E2041: a declaration inside an IF/WHILE/FOR/SELECT block, with a
 *   scope keyword inside a function, or with a reserved word as the name
 * - E2052: an array inside a function
 * - E2071/E2072: PUBLIC/PRIVATE variables
 * - file-scope initializers: one literal per element, of the declared type
 *   (E2006, E2017, E2024, E2031), and array sizes (E2006, E2011, E2016)
 * - E2031: anything at file scope that is no declaration (a statement, a
 *   stray END or `;`, a scope keyword after the type)
 * - names that are labels, which the compiler replaces by the label's text
 * - E2008: a reserved word as a parameter name
 */
export const invalidDeclarationsRule: Rule = {
  id: "declarationsInBlocks",

  check({
    doc,
    text,
    indexer,
    cfg,
    diagnosticsEnabled,
  }: CheckContext): vscode.Diagnostic[] {
    if (!diagnosticsEnabled) return [];

    const diags: vscode.Diagnostic[] = [];
    const file = doc.uri.fsPath;
    const T = tokensOf(text);
    const push: Push = (
      a,
      b,
      message,
      code,
      severity = vscode.DiagnosticSeverity.Error,
    ) =>
      diags.push(
        diag(
          new vscode.Range(
            doc.positionAt(T[a].start),
            doc.positionAt(T[b].end),
          ),
          code && COMPILER_TEXT[code]
            ? `${COMPILER_TEXT[code]}: ${/^[A-Z][a-z ]/.test(message) ? message[0].toLowerCase() + message.slice(1) : message}`
            : message,
          severity,
          code,
        ),
      );

    /** Reports a declared name that is a label. */
    const labelName = (tok: number, where: Where) => {
      const name = text.slice(T[tok].start, T[tok].end);
      const lab = labelOf(indexer, name);
      if (!lab) return;
      // A label outside the Include project and this file's project may not
      // be in its include tree.
      const sev = labelCertain(indexer, lab, file)
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning;
      const what = where === "param" ? "parameter" : "variable";
      const shown = `'${name}' is a label (${shortExpr(lab.expr)})`;
      if (lab.needsArgs) {
        push(
          tok,
          tok,
          `${shown} that takes arguments, and the compiler expands it here. Rename the ${what}.`,
          "E2057",
          sev,
        );
      } else if (lab.isName) {
        push(
          tok,
          tok,
          `${shown}: the compiler replaces the name, so this declares '${lab.expr.trim()}'. Rename the ${what}.`,
          undefined,
          vscode.DiagnosticSeverity.Warning,
        );
      } else if (where === "local") {
        // Compiles: the declaration becomes an expression statement.
        push(
          tok,
          tok,
          `${shown}: the compiler replaces the name, so this declares nothing. Rename the variable.`,
          "W1021",
          vscode.DiagnosticSeverity.Warning,
        );
      } else {
        push(
          tok,
          tok,
          `${shown}: the compiler replaces the name. Rename the ${what}.`,
          where === "param" ? "E2008" : "E2031",
          sev,
        );
      }
    };

    const functions = indexer.getFunctionRanges(file);

    for (const f of functions) {
      const body = functionBody(text, f);
      walkStatements(body.stmts, (s) => {
        if (s.kind !== "decl") return;
        if (s.scopeTok! >= 0) {
          const w = word(T[s.scopeTok!]);
          push(
            s.scopeTok!,
            s.scopeTok!,
            `${w} variables cannot be declared inside a function; declare it at file scope.`,
            "E2041",
          );
          return;
        }
        if (s.depth > 0) {
          if (cfg.warnDeclarationsInBlocks) {
            push(
              s.start,
              s.end - 1,
              "variables cannot be declared inside IF, WHILE, FOR or SELECT blocks; declare them at the top level of the function.",
              "E2041",
            );
          }
          return;
        }
        const after = T[s.typeTok! + 1];
        if (
          !s.names!.length &&
          after &&
          (NO_NAME_WORDS.has(word(after)) ||
            CICODE_TYPES.has(word(after)) ||
            // A scope keyword not starting a declaration of its own.
            (SCOPE_WORDS.has(word(after)) &&
              !CICODE_TYPES.has(word(T[s.typeTok! + 2]))))
        ) {
          push(
            s.typeTok! + 1,
            s.typeTok! + 1,
            `'${text.slice(after.start, after.end)}' is a reserved word and cannot be a variable name.`,
            "E2041",
          );
        }
        for (const n of s.names!) {
          if (n.dims.length) {
            const name = text.slice(T[n.tok].start, T[n.tok].end);
            const last = closeEnd(T, n.dims[n.dims.length - 1], body.end) - 1;
            push(
              n.dims[0],
              Math.max(n.dims[0], last),
              `declare '${name}' as a MODULE or GLOBAL variable instead.`,
              "E2052",
            );
          }
          labelName(n.tok, "local");
        }
      });
    }

    for (const v of indexer.getVariablesInFile(file)) {
      if (!v.isParam || !v.location) continue;
      const tok = tokenAt(T, doc.offsetAt(v.location.range.start));
      if (!T[tok]) continue;
      if (RESERVED_WORDS.has(T[tok].text) && T[tok].kind === "w") {
        push(
          tok,
          tok,
          `'${v.name}' is a reserved word and cannot be a parameter name.`,
          "E2008",
        );
      } else {
        labelName(tok, "param");
      }
    }

    // File scope: the tokens outside the functions. Function ranges don't
    // follow labels that hold block keywords.
    const items = [...functions].sort((a, b) => a.itemStart - b.itemStart);
    const strays = !usesStructuralLabel(indexer, text, T, 0, T.length);
    let from = 0;
    for (let k = 0; k <= items.length; k++) {
      const to = k < items.length ? tokenAt(T, items[k].itemStart) : T.length;
      // A function range that ends at a field named End (`Tag.End`) ends
      // too early: the tokens after it still belong to the function.
      const early =
        from > 0 && T[from - 1].kind === "w" && T[from - 1].text[0] === ".";
      checkFileScope(
        {
          T,
          src: text,
          to,
          indexer,
          file,
          push,
          labelName,
          strays: strays && !early,
        },
        from,
      );
      if (k < items.length) from = tokenAt(T, items[k].endOffset);
    }

    return diags;
  },
};

interface FileScope {
  readonly T: readonly Token[];
  /** Document text. */
  readonly src: string;
  /** End of the file-scope token run. */
  readonly to: number;
  readonly indexer: Indexer;
  readonly file: string;
  readonly push: Push;
  readonly labelName: (tok: number, where: Where) => void;
  /** Report tokens that are no declaration (E2031). */
  readonly strays: boolean;
}

/** The file-scope tokens from `from` to `fs.to`: declarations, each
 *  optionally followed by `;`. Anything else is E2031. */
function checkFileScope(fs: FileScope, from: number): void {
  const { T, to, push, indexer, src } = fs;
  let k = from;
  while (k < to) {
    const t = T[k];
    const w = word(t);
    const typeTok = SCOPE_WORDS.has(w) ? k + 1 : k;
    if (
      typeTok < to &&
      CICODE_TYPES.has(word(T[typeTok])) &&
      isIdentifier(T[typeTok + 1])
    ) {
      if (w === "PUBLIC")
        push(k, k, "PUBLIC variable is not allowed, use GLOBAL.", "E2071");
      if (w === "PRIVATE")
        push(k, k, "PRIVATE variable is not allowed, use MODULE.", "E2072");
      k = checkFileDecl(fs, typeTok);
      if (k < to && isToken(T[k], ";")) k++;
      continue;
    }
    if (!fs.strays) {
      k++;
      continue;
    }
    // A scope keyword must come first.
    if (CICODE_TYPES.has(w) && SCOPE_WORDS.has(word(T[k + 1]))) {
      push(
        k + 1,
        k + 1,
        `the scope keyword goes before the type: ${word(T[k + 1])} ${w}.`,
        "E2031",
      );
      return;
    }
    // `[scope] type` and a reserved word where the name belongs.
    const name = T[typeTok + 1];
    if (
      CICODE_TYPES.has(word(T[typeTok])) &&
      name?.kind === "w" &&
      RESERVED_WORDS.has(name.text) &&
      name.text !== "FUNCTION" &&
      !SCOPE_WORDS.has(name.text) &&
      !labelOf(indexer, src.slice(name.start, name.end))
    ) {
      push(
        typeTok + 1,
        typeTok + 1,
        `'${src.slice(name.start, name.end)}' is a reserved word and cannot be a variable name.`,
        "E2031",
      );
      return;
    }
    // Scope and type words (invalid types, VOID return types) are the
    // invalidTypes rule's, a FUNCTION here is a header the indexer did not
    // take, and a label may expand to anything.
    if (
      SCOPE_WORDS.has(w) ||
      ALL_TYPES.has(w) ||
      w === "FUNCTION" ||
      (t.kind === "w" && labelOf(indexer, src.slice(t.start, t.end)))
    ) {
      return;
    }
    push(
      k,
      k,
      "only variable declarations and functions can stand outside a function.",
      "E2031",
    );
    return;
  }
}

/** One file-scope declaration from its type token; returns the token after it. */
function checkFileDecl(fs: FileScope, typeTok: number): number {
  const { T, to, push } = fs;
  const type = word(T[typeTok]);
  // Where a new item may start: a scope or type keyword, FUNCTION, `;`.
  const itemStart = (j: number) =>
    j >= to ||
    isToken(T[j], ";") ||
    SCOPE_WORDS.has(word(T[j])) ||
    CICODE_TYPES.has(word(T[j])) ||
    isToken(T[j], "FUNCTION");
  const skipItem = (j: number) => {
    while (!itemStart(j)) j++;
    return j;
  };

  let j = typeTok + 1;
  while (j < to && isIdentifier(T[j])) {
    fs.labelName(j, "file");
    const size = checkDims(fs, j + 1);
    j = size.next;
    if (isToken(T[j], "=")) {
      j++;
      if (type === "QUALITY" || type === "TIMESTAMP") {
        if (!itemStart(j)) {
          push(
            j,
            j,
            `${type} variables cannot have an initial value.`,
            "E2031",
          );
        }
        return skipItem(j);
      }
      // One literal per element; the comma after the last one ends the
      // declaration.
      for (let values = 1; ; values++) {
        if (itemStart(j)) return j;
        j = checkValue(fs, j, type);
        if (j < 0) return skipItem(-j - 1);
        if (!isToken(T[j], ",")) {
          if (itemStart(j)) return j;
          push(
            j,
            j,
            "A file-scope initial value must be a single literal.",
            "E2031",
          );
          return skipItem(j);
        }
        j++;
        if (values >= size.elements) {
          if (itemStart(j)) return j;
          push(
            j,
            j,
            isIdentifier(T[j])
              ? "The comma after the last initial value ends the declaration; declare this variable separately."
              : "More initial values than array elements.",
            "E2031",
          );
          return skipItem(j);
        }
      }
    }
    if (!isToken(T[j], ",")) return j;
    j++;
  }
  return j;
}

/** Array dimensions from `j`: reports sizes the compiler rejects and
 *  returns the element count (unbounded when a size is not known). */
function checkDims(
  fs: FileScope,
  j: number,
): { next: number; elements: number } {
  const { T, to, push, indexer } = fs;
  let elements = 1;
  let known = true;
  let count = 0;
  while (j < to && isToken(T[j], "[")) {
    const open = j;
    const close = closeEnd(T, j, to) - 1;
    if (++count === 5)
      push(open, open, "An array has at most 4 dimensions.", "E2031");
    const inner = T.slice(open + 1, close);
    const size = inner.length === 1 ? intValue(inner[0], indexer) : undefined;
    if (inner.length > 1) {
      push(
        open + 2,
        open + 2,
        "An array size is a single integer; write each dimension in its own brackets, e.g. [2][3].",
        "E2011",
      );
    } else if (inner.length === 1 && labelTokens(inner[0], indexer) > 1) {
      push(
        open + 1,
        open + 1,
        `An array size is a single integer ('${fs.src.slice(inner[0].start, inner[0].end)}' is ${shortExpr(indexer.getLabel(inner[0].text)!.expr)}).`,
        "E2011",
      );
    }
    if (size === 0)
      push(open + 1, open + 1, "An array size must be at least 1.", "E2006");
    if (size === undefined) known = false;
    else elements *= size;
    j = close + 1;
  }
  if (known && elements > MAX_ARRAY_ELEMENTS) {
    push(
      j - 1,
      j - 1,
      `An array holds at most ${MAX_ARRAY_ELEMENTS} elements.`,
      "E2016",
    );
  }
  return { next: j, elements: known ? elements : Number.MAX_SAFE_INTEGER };
}

/** Number of tokens a constant label expands to (0 for other tokens). */
function labelTokens(t: Token, indexer: Indexer): number {
  const e = t.kind === "w" ? indexer.getLabel(t.text)?.expr : undefined;
  return e === undefined ? 0 : lexTokens(e).length;
}

/** Value of an integer literal token, or of a label expanding to one. */
function intValue(t: Token, indexer: Indexer): number | undefined {
  if (t.kind === "w") {
    const e = indexer.getLabel(t.text)?.expr;
    const lt = e !== undefined ? lexTokens(e) : [];
    return lt.length === 1 && lt[0].kind === "n"
      ? intValue(lt[0], indexer)
      : undefined;
  }
  return t.kind === "n" && isIntLiteral(t.text)
    ? literalValue(t.text)
    : undefined;
}

function isIntLiteral(s: string): boolean {
  return /^0[xXbBoO]/.test(s) || !/[.eE]/.test(s);
}

function literalValue(s: string): number {
  const m = /^0([xXbBoO])(.*)$/.exec(s);
  if (!m) return Number(s);
  const radix = { x: 16, b: 2, o: 8 }[m[1].toLowerCase() as "x" | "b" | "o"];
  return m[2] ? parseInt(m[2], radix) : 0;
}

/**
 * Checks the initial value at `j` of a file-scope `type` variable: an
 * optional sign and one literal of the type (a label expands first).
 * Returns the token after the value, or `-(k + 1)` when the declaration
 * cannot be read on from token `k`.
 */
function checkValue(fs: FileScope, j: number, type: string): number {
  const { T, to, push, indexer, file, src } = fs;
  const start = j;
  let sign = "";
  if (isToken(T[j], "-") || isToken(T[j], "+")) sign = T[j++].text;
  if (j >= to) return j;
  const v = T[j];
  let lit: Token | undefined = v;
  let severity = vscode.DiagnosticSeverity.Error;
  let via = "";

  if (isIdentifier(v)) {
    const lab = labelOf(indexer, src.slice(v.start, v.end));
    if (lab?.needsArgs) return j + 1;
    if (lab) {
      let toks = lexTokens(lab.expr);
      via = ` ('${src.slice(v.start, v.end)}' is ${shortExpr(lab.expr)})`;
      if (!labelCertain(indexer, lab, file)) {
        severity = vscode.DiagnosticSeverity.Warning;
      }
      if (isToken(toks[0], "-") || isToken(toks[0], "+")) {
        if (sign) {
          push(
            start,
            j,
            `A file-scope initial value takes one sign${via}.`,
            "E2006",
            severity,
          );
          return j + 1;
        }
        sign = toks[0].text;
        toks = toks.slice(1);
      }
      if (toks.length > 1) {
        push(
          j,
          j,
          `A file-scope initial value must be a single literal${via}.`,
          "E2031",
          severity,
        );
        return j + 1;
      }
      lit = toks[0];
    } else if (
      !indexer.getVariables(v.text).length &&
      !indexer.getFunction(v.text)
    ) {
      // Could be a label of a project outside the workspace.
      severity = vscode.DiagnosticSeverity.Warning;
    }
  } else if (sign && (isToken(v, "-") || isToken(v, "+"))) {
    push(j, j, "A file-scope initial value takes one sign.", "E2006");
    return -(j + 1);
  }
  if (!lit) return j + 1;

  const isInt = lit.kind === "n" && isIntLiteral(lit.text);
  const report = (message: string, code: string) => {
    push(j, j, message + via, code, severity);
    // Skip a call or parenthesized value as a whole.
    return isToken(v, "(") || isToken(T[j + 1], "(") ? -(j + 1) : j + 1;
  };
  switch (type) {
    case "INT":
      if (!isInt)
        return report(
          "An INT variable's initial value must be an integer literal.",
          "E2006",
        );
      break;
    case "REAL":
      if (lit.kind !== "n")
        return report(
          "A REAL variable's initial value must be a number literal.",
          "E2006",
        );
      break;
    case "STRING":
      if (lit.kind !== "s" || sign)
        return report(
          "A STRING variable's initial value must be a string literal.",
          "E2017",
        );
      break;
    case "OBJECT":
      if (!isInt)
        return report(
          "An OBJECT variable can only be initialized to -1.",
          "E2006",
        );
      if (sign !== "-" || literalValue(lit.text) !== 1) {
        return report(
          "An OBJECT variable can only be initialized to -1.",
          "E2024",
        );
      }
      break;
  }
  return j + 1;
}
