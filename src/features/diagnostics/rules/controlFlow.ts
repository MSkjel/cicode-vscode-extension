import * as vscode from "vscode";
import type { Rule } from "../rule";
import { entryInCompile, inCompile, type CheckContext } from "../context";
import { diag } from "../diag";
import type { Indexer } from "../../../core/indexer/indexer";
import type { FunctionRange } from "../../../core/indexer/types";
import { CICODE_TYPES } from "../../../shared/constants";
import type { FunctionInfo } from "../../../shared/types";
import { isNameChar } from "../../../shared/textUtils";
import {
  SCOPE_WORDS,
  closeEnd,
  formatEnd,
  functionBody,
  hasTypeLabels,
  isIdentifier,
  isToken,
  labelOf,
  lexErrorsOf,
  lexTokens,
  operandEnd,
  reachedFunctions,
  tokenAt,
  tokensOf,
  typeLabel,
  usesStructuralLabel,
  walkStatements,
  word,
  type FunctionBody,
  type Stmt,
  type Token,
} from "./statements";

const ERROR = vscode.DiagnosticSeverity.Error;
const WARNING = vscode.DiagnosticSeverity.Warning;

/** Value type of an expression, as far as it matters for conditions. */
type ValueType = "NUM" | "STRING" | "OBJECT" | "TIMESTAMP" | "QUALITY";

// Binding level of each binary operator (lower binds tighter).
const OP_LEVEL: Record<string, number> = {
  "*": 0,
  "/": 0,
  MOD: 0,
  ":": 1,
  "+": 2,
  "-": 2,
  "<": 3,
  "<=": 3,
  ">": 3,
  ">=": 3,
  "=": 4,
  "<>": 4,
  AND: 5,
  OR: 6,
  BITAND: 7,
  BITOR: 7,
  BITXOR: 7,
};

// Punctuation the parser accepts in code; `~` and `#` pictures only as a
// format after ':', and `^` is reported on its own (E2020).
const PUNCTUATION = new Set([
  "(",
  ")",
  ",",
  ";",
  "[",
  "]",
  "+",
  "-",
  "*",
  "/",
  ":",
  ".",
  "=",
  "<",
  ">",
  "<=",
  ">=",
  "<>",
]);

const LEX_MESSAGES: Record<string, string> = {
  E2054:
    "Close quotation mark expected: the string runs to the end of the file.",
  E2056:
    "Close comment delimiter expected: the comment runs to the end of the file.",
  E2058:
    "Invalid number: integer literals are limited to 32 bits (4294967295, 0xFFFFFFFF).",
};

function valueType(type: string | undefined): ValueType | undefined {
  const t = (type ?? "").replace(/\[.*/, "").trim().toUpperCase();
  if (t === "INT" || t === "REAL" || t === "LONG") return "NUM";
  if (
    t === "STRING" ||
    t === "OBJECT" ||
    t === "TIMESTAMP" ||
    t === "QUALITY"
  ) {
    return t;
  }
  return undefined;
}

/** End of the Super Genie substitution starting at `at`, which the lexer
 *  tests at every token start: a run of name characters and '?' holding
 *  exactly two '?' (`?abc?`, `Pump?n?`; in `?a?b?` it is `a?b?`). */
function genieEnd(text: string, at: number): number | undefined {
  let e = at;
  let marks = 0;
  while (e < text.length && (text[e] === "?" || isNameChar(text[e]))) {
    if (text[e++] === "?") marks++;
  }
  return marks === 2 ? e : undefined;
}

/**
 * Checks statements and tokens the way the compiler reads them:
 * - E2054, E2056, E2058: string or `|` not closed, comment not closed,
 *   integer over 32 bits (anywhere in the file)
 * - in functions: `|...|` and characters no construct accepts (E2041), `^`
 *   (E2020 as an operator, E2041 elsewhere), `?name?` Super Genie
 *   substitutions (E2061; a single `?` is E2041), NOP, VAR and CICODE
 *   (E2041), CiVBA (E2074), a negative integer below -2147483648 (E2006)
 * - E2032: IF without THEN; E2033: WHILE or FOR without DO (FOR has no STEP)
 * - E2065: SELECT without CASE; E2034: SELECT closed by a plain END, CASE
 *   after CASE ELSE, a block cut off by ELSE or CASE; E2024: IS without a
 *   comparison operator; E2041: ELSE or CASE outside a block, or at the
 *   start of one (a block takes a statement before ELSE or CASE ends it)
 * - a function without END: E2076 at the next FUNCTION, E2041 when that is
 *   inside a block, E2034 at the end of the file
 * - E2027: an IF or WHILE condition that is not numeric
 * - FOR loop variable: a local, parameter or module variable of this file,
 *   declared before the loop (E2001), of type INT or REAL (E2027)
 * - END IF, END WHILE and END FOR, which are no block closers: END closes
 *   the block and the keyword after it starts a new statement
 * Labels are not expanded, so a function that uses a label holding block
 * keywords gets no structure diagnostics.
 */
export const controlFlowRule: Rule = {
  id: "controlFlow",

  check({
    text,
    doc,
    indexer,
    diagnosticsEnabled,
  }: CheckContext): vscode.Diagnostic[] {
    if (!diagnosticsEnabled) return [];

    const diags: vscode.Diagnostic[] = [];
    const file = doc.uri.fsPath;
    const T = tokensOf(text);
    let typeLabels: boolean | undefined;

    const lexErrors = lexErrorsOf(text);
    // Literals already reported as over 32 bits (E2058).
    const tooBig = new Set(
      lexErrors.filter((e) => e.code === "E2058").map((e) => e.start),
    );
    // A string or comment left open runs to the end of the file, so the
    // functions it cuts off have no END either.
    const openToEof = lexErrors.some((e) => e.code !== "E2058");
    for (const e of lexErrors) {
      diags.push(
        diag(
          new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)),
          e.code === "E2054" && text[e.start] === "|"
            ? "Close quotation mark expected: the '|' token runs to the end of the file."
            : LEX_MESSAGES[e.code],
          ERROR,
          e.code,
        ),
      );
    }

    const ranges = indexer.getFunctionRanges(file);
    for (const f of ranges) {
      const body = functionBody(text, f);
      const scopeId = indexer.localScopeId(file, f.name);
      const src = (t: Token) => text.slice(t.start, t.end);
      const range = (a: number, b = a) =>
        new vscode.Range(doc.positionAt(T[a].start), doc.positionAt(T[b].end));
      const push = (
        a: number,
        b: number,
        message: string,
        code?: string,
        severity = ERROR,
      ) => diags.push(diag(range(a, b), message, severity, code));

      const reported = checkTokens(f, body);
      if (usesStructuralLabel(indexer, file, text, T, body.start, body.end)) {
        continue;
      }

      // `END IF`, `END WHILE`, `END FOR` written as one closer on one line.
      const afterEnd = (s: Stmt) =>
        s.start > body.start &&
        isToken(T[s.start - 1], "END") &&
        doc.positionAt(T[s.start - 1].start).line ===
          doc.positionAt(T[s.start].start).line;

      const walkFrom = diags.length;
      const types = new ConditionTypes(T, text, indexer, file, scopeId, doc);
      // ELSE and CASE tokens already reported as cutting a block off.
      const cut = new Set<number>();

      walkStatements(body.stmts, (s) => {
        const kw = word(T[s.start]);
        switch (s.kind) {
          case "if":
          case "while": {
            const opener = s.kind === "if" ? "THEN" : "DO";
            const [a, b] = s.cond!;
            if (a === b && a < body.end && !reported.has(a)) {
              push(a, a, `Operand expected: ${kw} needs a condition.`, "E2041");
            }
            if (s.opener < 0) {
              push(
                s.start,
                s.start,
                afterEnd(s)
                  ? `${opener} expected: END ${kw} does not close the ${kw}; END alone closes it, so this ${kw} starts a new ${kw} statement.`
                  : `${opener} expected: ${kw} needs ${opener} after its condition.`,
                s.kind === "if" ? "E2032" : "E2033",
              );
            } else {
              const t = b > a ? types.of(a, b) : undefined;
              if (t && t !== "NUM") {
                push(
                  a,
                  b - 1,
                  `Invalid BOOLEAN value: the ${kw} condition must be numeric, not ${t}.`,
                  "E2027",
                );
              }
            }
            break;
          }
          case "for":
            checkFor(s);
            break;
          case "select":
            if (s.opener < 0) {
              push(
                s.start,
                s.start,
                "CASE expected: SELECT must be followed by CASE.",
                "E2065",
              );
            }
            for (const i of s.issues ?? [])
              push(i.tok, i.tok, i.message, i.code);
            if (s.opener >= 0 && s.close >= 0 && !s.endSelect) {
              push(
                s.close,
                s.close,
                "END expected: a SELECT CASE is closed by END SELECT, not a plain END.",
                "E2034",
              );
            }
            break;
          case "stray": {
            // A token no statement starts with.
            const w = word(T[s.start]);
            // `?` is a Super Genie mark (E2061); a reserved word after a
            // type is the invalidDeclarations rule's.
            if (
              cut.has(s.start) ||
              reported.has(s.start) ||
              isToken(T[s.start], "?") ||
              CICODE_TYPES.has(word(T[s.start - 1]))
            ) {
              break;
            }
            push(
              s.start,
              s.start,
              s.blockStart
                ? `Operand expected: a block cannot start with ${w}; put a statement or ';' before it.`
                : w === "ELSE" || w === "CASE"
                  ? `Operand expected: ${w} outside ${w === "ELSE" ? "an IF" : "a SELECT CASE"} block.`
                  : `Operand expected: no statement starts with '${src(T[s.start])}'.`,
              "E2041",
            );
            break;
          }
        }
        // A block cut off by ELSE or CASE (a second ELSE, an IF inside a
        // CASE clause missing its END).
        const block =
          s.kind === "if" ||
          s.kind === "while" ||
          s.kind === "select" ||
          (s.kind === "for" && s.forTo! >= 0);
        if (block && s.close < 0 && s.end < body.end) {
          const at = word(T[s.end]);
          if ((at === "ELSE" || at === "CASE") && !cut.has(s.end)) {
            cut.add(s.end);
            push(
              s.end,
              s.end,
              `END expected: the ${kw} block needs its END before this ${at}.`,
              "E2034",
            );
          }
        }
      });

      // An error above often leaves the function without its END; the
      // compiler reports that one only.
      if (!f.closed && !openToEof && diags.length === walkFrom) {
        missingEnd(f, body);
      }

      function checkFor(s: Stmt): void {
        const endFor = afterEnd(s);
        if (s.forVar! < 0) {
          if (endFor) {
            push(
              s.start,
              s.start,
              "END FOR does not close the FOR loop: END alone closes it, and the compiler ignores this FOR.",
              undefined,
              WARNING,
            );
          }
          return;
        }
        const vt = T[s.forVar!];
        const name = src(vt);
        const problem = loopVarProblem(name, vt);
        if (problem) {
          push(
            s.forVar!,
            s.forVar!,
            endFor
              ? `${problem.message} (END FOR does not close the FOR loop: END alone closes it, so this FOR starts a new FOR statement.)`
              : problem.message,
            problem.code,
          );
          return;
        }
        if (s.forTo! < 0) {
          // `FOR i = 5;` compiles as an assignment.
          if (endFor) {
            push(
              s.start,
              s.start,
              "END FOR does not close the FOR loop: END alone closes it, so this FOR starts a new FOR statement.",
              undefined,
              WARNING,
            );
          }
          return;
        }
        const after = s.forBoundEnd!;
        if (s.opener === after || after >= body.end) return;
        const step = word(T[after]) === "STEP";
        push(
          after,
          after,
          step
            ? "DO expected: Cicode FOR loops have no STEP; the variable always counts up by 1."
            : "DO expected: FOR needs DO after the TO value.",
          "E2033",
        );
      }

      function loopVarProblem(
        name: string,
        vt: Token,
      ): { message: string; code: string } | undefined {
        if (labelOf(indexer, name, file)) return undefined;
        const v = indexer.resolveVariableInScope(
          name,
          file,
          scopeId,
          doc.positionAt(vt.start),
        );
        const written = v?.type.replace(/\[.*/, "").trim().toUpperCase() ?? "";
        // The type may be a label that expands to one.
        const type = typeLabel(indexer, written, file) ?? written;
        if (!v || v.scopeType === "global" || !CICODE_TYPES.has(type)) {
          // Variables declared through a label type are not indexed.
          typeLabels ??= hasTypeLabels(indexer, file);
          if (!v && typeLabels) return undefined;
          return {
            message: `Tag not found: FOR loop variable '${name}' must be a local, parameter or module variable of this file, declared before the loop${v?.scopeType === "global" ? " (not GLOBAL)" : ""}.`,
            code: "E2001",
          };
        }
        if (type !== "INT" && type !== "REAL") {
          return {
            message: `Invalid BOOLEAN value: FOR loop variable '${name}' must be INT or REAL, not ${type}.`,
            code: "E2027",
          };
        }
        return undefined;
      }
    }

    return diags;

    /** Tokens of function `f` (header and body) that no construct accepts;
     *  returns the ones reported. */
    function checkTokens(f: FunctionRange, body: FunctionBody): Set<number> {
      const reported = new Set<number>();
      const from = tokenAt(T, f.itemStart);
      let inGenie = -1;
      for (let k = from; k < body.end; k++) {
        const t = T[k];
        const prev = k > from ? T[k - 1] : undefined;
        let code: string | undefined;
        let message = "";
        let end = t.end;
        if (t.start < inGenie) {
          reported.add(k);
          continue;
        }
        const genie =
          t.kind === "w" || t.kind === "n" || t.text === "?"
            ? genieEnd(text, t.start)
            : undefined;
        if (genie !== undefined && t.text[0] !== ".") {
          code = "E2061";
          message =
            "Super Genie must be on a Page: '?name?' substitutions only work in graphics, not in Cicode files.";
          end = inGenie = genie;
        } else if (t.kind === "s") {
          if (t.text[0] === "|") {
            code = "E2041";
            message =
              "Operand expected: '|...|' is not valid in Cicode; strings use double quotes.";
          }
        } else if (t.kind === "p") {
          if (t.text === "^") {
            // An operator slot follows an operand; anywhere else the
            // parser wants an operand.
            const afterOperand = k !== body.start && endsOperand(prev);
            code = afterOperand ? "E2020" : "E2041";
            message = `${afterOperand ? "Syntax error" : "Operand expected"}: '^' is not a Cicode operator (it escapes characters only inside strings).`;
          } else if (
            t.text === "*" &&
            isToken(T[k + 1], "/") &&
            T[k + 1].start === t.end
          ) {
            // `*/` outside a comment: block comments do not nest.
            code = "E2041";
            message =
              "Operand expected: '*/' outside a comment (block comments do not nest).";
            reported.add(k + 1);
          } else if (t.text === "?") {
            code = "E2041";
            message =
              "Operand expected: a single '?' is not valid ('?name?' marks a Super Genie substitution).";
          } else if (
            !PUNCTUATION.has(t.text) &&
            !((t.text === "~" || t.text[0] === "#") && isToken(prev, ":"))
          ) {
            code = "E2041";
            message =
              t.text[0] === "#"
                ? "Operand expected: a '#' format picture is only valid after ':'."
                : `Operand expected: '${t.text}' is not a Cicode operator or punctuation.`;
          }
        } else if (
          t.kind === "n" &&
          (intValue(t.text) ?? 0) > 2147483648 &&
          !tooBig.has(t.start) &&
          isToken(prev, "-") &&
          (k - 1 === body.start || !endsOperand(T[k - 2]))
        ) {
          code = "E2006";
          message = "Bad integer value: the smallest integer is -2147483648.";
        } else if (k >= body.start && t.kind === "w") {
          const w = t.text;
          if (
            (w === "NOP" || w === "VAR" || w === "CICODE" || w === "CIVBA") &&
            !labelOf(indexer, text.slice(t.start, t.end), file)
          ) {
            if (w === "CIVBA") {
              code = "E2074";
              message =
                "CiVBA code not allowed here: CiVBA only selects the language of an expression field.";
            } else {
              code = "E2041";
              message = `Operand expected: ${w} is reserved and has no meaning in Cicode functions${w === "VAR" ? "" : " (it is for expression fields)"}.`;
            }
          }
        }
        if (code) {
          reported.add(k);
          const last = reported.has(k + 1) ? T[k + 1] : t;
          diags.push(
            diag(
              new vscode.Range(
                doc.positionAt(t.start),
                doc.positionAt(Math.max(last.end, end)),
              ),
              message,
              ERROR,
              code,
            ),
          );
        }
      }
      return reported;
    }

    /** Function `f` has no END: the compiler notices at the next FUNCTION
     *  (E2076, or E2041 inside a block) or at the end of the file (E2034). */
    function missingEnd(f: FunctionRange, body: FunctionBody): void {
      const last = body.stmts[body.stmts.length - 1];
      const parsedTo = last ? last.end : body.start;
      if (parsedTo < body.end) return;
      let k = body.end;
      while (
        k < T.length &&
        (CICODE_TYPES.has(word(T[k])) || SCOPE_WORDS.has(word(T[k])))
      ) {
        k++;
      }
      const inBlock =
        !!last &&
        last.close < 0 &&
        (last.kind === "if" ||
          last.kind === "while" ||
          last.kind === "select" ||
          (last.kind === "for" && last.forTo! >= 0));
      if (k < T.length && isToken(T[k], "FUNCTION")) {
        const at = new vscode.Range(
          doc.positionAt(T[k].start),
          doc.positionAt(T[k].end),
        );
        diags.push(
          inBlock
            ? diag(
                at,
                `Operand expected: FUNCTION inside a block of '${f.name}'; an END is missing before it.`,
                ERROR,
                "E2041",
              )
            : diag(
                at,
                `Unexpected FUNCTION declaration found, are you missing an END? '${f.name}' has no END.`,
                ERROR,
                "E2076",
              ),
        );
      } else if (k >= T.length) {
        const name = new vscode.Range(
          doc.positionAt(f.nameOffset),
          doc.positionAt(f.nameOffset + f.name.length),
        );
        diags.push(
          diag(
            name,
            `END expected: '${f.name}' is not closed before the end of the file.`,
            ERROR,
            "E2034",
          ),
        );
      }
    }
  },
};

/** Value of an integer literal (decimal, 0x, 0o or 0b); undefined for reals. */
function intValue(s: string): number | undefined {
  const m = /^0*([bBoOxX])(\w*)$/.exec(s);
  if (m) {
    const radix = { b: 2, o: 8, x: 16 }[m[1].toLowerCase() as "b" | "o" | "x"];
    return m[2] ? parseInt(m[2], radix) : 0;
  }
  return /^\d+$/.test(s) ? Number(s) : undefined;
}

/** True when `t` can end an operand, so an operator may follow. */
function endsOperand(t: Token | undefined): boolean {
  return (
    t !== undefined &&
    (t.kind === "n" ||
      t.kind === "s" ||
      (t.kind === "p" && t.text[0] === "#") ||
      isToken(t, ")") ||
      isToken(t, "]") ||
      isIdentifier(t))
  );
}

/** Infers the value type of a condition from literals, declared variables,
 *  function return types and operators; undefined when not certain (tag
 *  references, labels with complex text, definitions that may not be
 *  compiled with this file, ...). */
class ConditionTypes {
  constructor(
    private readonly T: readonly Token[],
    private readonly text: string,
    private readonly indexer: Indexer,
    private readonly file: string,
    private readonly scopeId: string,
    private readonly doc: vscode.TextDocument,
  ) {}

  /** Type of the expression in tokens [a, b). */
  of(a: number, b: number): ValueType | undefined {
    const T = this.T;
    // Operands (with a trailing format, `x:###`) and the operators between.
    const parts: Array<{ a: number; b: number; format: boolean }> = [];
    const ops: string[] = [];
    let i = a;
    for (;;) {
      const e = operandEnd(T, i, b);
      if (e < 0) return undefined;
      let j = e;
      while (j < b && isToken(T[j], ":")) j = formatEnd(T, j + 1, b);
      parts.push({ a: i, b: e, format: j > e });
      i = j;
      if (i >= b) break;
      const op = T[i];
      if (op.kind === "s" || op.kind === "n" || !(op.text in OP_LEVEL)) {
        return undefined;
      }
      ops.push(op.text);
      i++;
    }
    const formats = parts.some((p) => p.format);
    if (!ops.length && !formats) return this.operand(parts[0].a, parts[0].b);
    const top = Math.max(
      formats ? OP_LEVEL[":"] : 0,
      ...ops.map((o) => OP_LEVEL[o]),
    );
    if (top >= 3) return "NUM";
    if (top === 1) return "STRING";
    if (top === 0) return "NUM";
    // + and - at the top: + joins strings, - needs numbers.
    if (ops.includes("-")) return "NUM";
    const types: Array<ValueType | undefined> = [];
    let seg: typeof parts = [];
    const flush = () => {
      types.push(
        seg.some((p) => p.format)
          ? "STRING"
          : seg.length > 1
            ? "NUM"
            : this.operand(seg[0].a, seg[0].b),
      );
      seg = [];
    };
    parts.forEach((p, k) => {
      seg.push(p);
      if (k === parts.length - 1 || ops[k] === "+") flush();
    });
    // A string joined to a number is E2024 instead; a tag may be either.
    if (types.every((t) => t === "STRING")) return "STRING";
    return types.every((t) => t === "NUM") ? "NUM" : undefined;
  }

  /** Type of the single operand in tokens [a, b). */
  private operand(a: number, b: number): ValueType | undefined {
    const T = this.T;
    const t = T[a];
    if (isToken(t, "NOT")) return "NUM";
    if (isToken(t, "-") || isToken(t, "+")) {
      return this.operand(a + 1, b) === "NUM" ? "NUM" : undefined;
    }
    if (isToken(t, "(")) {
      return closeEnd(T, a, b) === b ? this.of(a + 1, b - 1) : undefined;
    }
    if (t.kind === "s")
      return b === a + 1 && t.text.startsWith('"') ? "STRING" : undefined;
    if (t.kind === "n") return "NUM";
    if (!isIdentifier(t)) return undefined;

    const name = this.text.slice(t.start, t.end);
    const lab = labelOf(this.indexer, name, this.file);
    if (lab) {
      if (b !== a + 1) return undefined;
      const lt = lexTokens(lab.expr);
      if (lt.length !== 1) return undefined;
      return lt[0].kind === "s"
        ? "STRING"
        : lt[0].kind === "n"
          ? "NUM"
          : undefined;
    }
    const next = T[a + 1];
    if (b === a + 1 || isToken(next, "[")) {
      if (b !== a + 1 && closeEnd(T, a + 1, b) !== b) return undefined;
      const v = this.indexer.resolveVariableInScope(
        name,
        this.file,
        this.scopeId,
        this.doc.positionAt(t.start),
      );
      if (!v || !inCompile(this.indexer, this.file, v.file)) return undefined;
      const type = this.typeOf(v.type);
      // Roots compiling the file's project may declare it differently.
      if (
        v.scopeType === "global" &&
        this.indexer
          .getVariables(name, this.file)
          .some((o) => o.scopeType === "global" && this.typeOf(o.type) !== type)
      ) {
        return undefined;
      }
      return type;
    }
    if (isToken(next, "(") && closeEnd(T, a + 1, b) === b) {
      const types = new Set(
        reachedFunctions(this.indexer, name, this.file).map((fn) =>
          this.returnTypeOf(fn),
        ),
      );
      return types.size === 1 ? [...types][0] : undefined;
    }
    return undefined;
  }

  /** Value type a call to `fn` returns; undefined for a label or a
   *  definition not compiled with the file. */
  private returnTypeOf(fn: FunctionInfo): ValueType | undefined {
    if (fn.origin === "builtin") return valueType(fn.returnType);
    if (fn.origin !== "cicode") return undefined;
    if (!entryInCompile(this.indexer, this.file, fn)) return undefined;
    return this.typeOf(fn.returnType);
  }

  /** Value type of a declared type, which may be a label that expands to one. */
  private typeOf(type: string): ValueType | undefined {
    const t = type.replace(/\[.*/, "").trim();
    return valueType(typeLabel(this.indexer, t, this.file) ?? t);
  }
}
