import * as path from "path";
import * as vscode from "vscode";
import type { Rule } from "../rule";
import {
  entryInCompile,
  inCompile,
  sourceInCompile,
  type CheckContext,
} from "../context";
import { diag } from "../diag";
import { inSpan, isCommentStart, upperAscii } from "../../../shared/textUtils";
import {
  advancePastIgnored,
  findMatchingParen,
} from "../../../shared/parseHelpers";
import { CALL_RE, RESERVED_WORDS } from "../../../shared/constants";
import { computeParamBounds } from "../../../shared/utils";
import type { FunctionInfo } from "../../../shared/types";
import { isIdentifier, isToken, lex } from "../../../core/indexer/lexer";
import type { Indexer } from "../../../core/indexer/indexer";
import type { FunctionRange } from "../../../core/indexer/types";

const ERROR = vscode.DiagnosticSeverity.Error;
const WARNING = vscode.DiagnosticSeverity.Warning;

// FUNC0 FLAGS 2-4: deprecated built-ins (FLAGS 1, obsolete, is E2101).
const DEPRECATED: Record<number, [code: string, text: string]> = {
  2: [
    "W1008",
    "is deprecated; the legacy function will be removed in a future release",
  ],
  3: ["W1009", "is deprecated and can only be called on the server"],
  4: [
    "W1010",
    "is deprecated and does not support online changes made to the system",
  ],
};

interface Resolved {
  fn?: FunctionInfo;
  /** `fn` is certainly in the file's compile. */
  sure: boolean;
  /** The other candidates, when `fn` may not be in the file's compile. */
  alternatives: FunctionInfo[];
  /** A PRIVATE definition in another file, when nothing else resolves. */
  privateIn?: string;
}

/**
 * The function a call in `file` reaches: a function-like label first (labels
 * are expanded before names are looked up), then the file's own function,
 * then a PUBLIC one, then a built-in. PRIVATE functions of other files are
 * invisible, even when they share a built-in's name.
 */
function resolve(indexer: Indexer, name: string, file: string): Resolved {
  const candidates: FunctionInfo[] = [];
  const top = indexer.getFunction(name);
  if (top?.origin === "label") candidates.push(top);
  const builtin = indexer.getBuiltinFunction(name);
  if (builtin?.origin === "label" && builtin !== top) candidates.push(builtin);

  const defs = indexer.getFunctionDefinitions(name);
  const own = defs.find((d) => d.file === file);
  if (own) candidates.push(own);
  // PUBLIC definitions of other folders belong to projects that may not be
  // included; one in the compile goes first.
  const pub = defs.filter((d) => !d.isPrivate && d !== own);
  const inTree = (d: FunctionInfo) =>
    d.file && inCompile(file, d.file) ? 0 : 1;
  candidates.push(...pub.sort((a, b) => inTree(a) - inTree(b)));
  if (builtin && builtin.origin !== "label") candidates.push(builtin);

  const fn = candidates[0];
  if (!fn) {
    return {
      sure: false,
      alternatives: [],
      privateIn: defs[0]?.file ?? undefined,
    };
  }
  const sure = entryInCompile(indexer, file, fn);
  return { fn, sure, alternatives: sure ? [] : candidates.slice(1) };
}

/** True when a function is defined under `name` through a label: a header
 *  named like a function-like label that expands to `name(...)`. */
function definedThroughLabel(indexer: Indexer, name: string): boolean {
  const key = upperAscii(name);
  for (const fn of indexer.getAllFunctions().values()) {
    if (fn.origin !== "label" || !fn.expr) continue;
    const head = /^\s*([^\s(]+)/.exec(fn.expr)?.[1];
    if (
      head !== undefined &&
      upperAscii(head) === key &&
      indexer.getFunctionDefinitions(fn.name).length
    ) {
      return true;
    }
  }
  return false;
}

/** Argument bounds; max is Infinity for a variadic function. */
function boundsOf(fn: FunctionInfo): { min: number; max: number } {
  if (fn.minArgs !== undefined && fn.maxArgs !== undefined) {
    return { min: fn.minArgs, max: fn.maxArgs < 0 ? Infinity : fn.maxArgs };
  }
  const { min, max } = computeParamBounds(fn.params || []);
  return { min, max };
}

function fits(fn: FunctionInfo, n: number): boolean {
  const { min, max } = boundsOf(fn);
  return n >= min && n <= max;
}

function expected(fn: FunctionInfo): string {
  const { min, max } = boundsOf(fn);
  if (max === Infinity) return `${min} or more`;
  return min === max ? `${min}` : `${min}-${max}`;
}

/**
 * What the compiler makes of the label `fn` getting an empty argument at
 * `index`. Nothing when its text doesn't use it. As a call's last argument
 * it is dropped, so the callee's argument count decides (E2022, or W1004
 * for a Cicode function); anywhere else it is an empty operand (E2041).
 */
function emptyArgUse(
  indexer: Indexer,
  fn: FunctionInfo,
  index: number,
): { code: string; error: boolean } | undefined {
  const raw = fn.params[index]?.split("=")[0].trim();
  if (!raw) return undefined;
  const param = upperAscii(raw);
  const T = lex(fn.expr ?? "").tokens;
  const k = T.findIndex((t) => t.kind === "w" && t.text === param);
  if (k === -1) return undefined;
  const operand = { code: "E2041", error: true };
  const whole = isToken(T[k - 1], ",") || isToken(T[k - 1], "(");
  if (!whole || !isToken(T[k + 1], ")")) return operand;

  // Back to the call's "(", counting its arguments.
  let depth = 0;
  let args = 1;
  let j = k - 1;
  for (; j >= 0; j--) {
    if (isToken(T[j], ")")) depth++;
    else if (isToken(T[j], "(") && depth-- === 0) break;
    else if (isToken(T[j], ",") && depth === 0) args++;
  }
  if (!isIdentifier(T[j - 1])) return operand;
  const callee = indexer.getFunction(T[j - 1].text);
  if (!callee || callee.origin === "label" || fits(callee, args - 1)) {
    return undefined;
  }
  if (callee.origin === "cicode") return { code: "W1004", error: false };
  return { code: "E2022", error: callee.origin === "builtin" };
}

/**
 * Top-level argument slots between the parentheses at `open` and `close`:
 * where each starts and whether it holds anything. A string is an argument,
 * a comment is blank.
 */
function argSlots(
  text: string,
  open: number,
  close: number,
  ignore: Array<[number, number]>,
): Array<{ at: number; filled: boolean }> {
  const slots = [{ at: open + 1, filled: false }];
  let depth = 0;
  for (let i = open + 1; i < close; ) {
    const past = advancePastIgnored(i, ignore);
    if (past !== i) {
      if (!isCommentStart(text, i)) slots[slots.length - 1].filled = true;
      i = past;
      continue;
    }
    const ch = text[i++];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      slots.push({ at: i, filled: false });
      continue;
    }
    if (!/\s/.test(ch)) slots[slots.length - 1].filled = true;
  }
  return slots;
}

/** Function whose body holds `offset` (functions in file order). */
function enclosing(
  fns: readonly FunctionRange[],
  offset: number,
): FunctionRange | undefined {
  return fns.find((f) => offset >= f.startOffset && offset < f.endOffset);
}

/**
 * Checks calls `name(...)`:
 * - E2031: unknown function, or a PRIVATE function of another file
 * - E2022 / W1004 / E2057: wrong number of arguments (by kind of callee)
 * - E2057: a constant label given arguments
 * - E2041: empty argument before a comma; a label's empty argument only
 *   where its text uses it (E2041, or E2022 as a call's last argument)
 * - E2101 / W1008-W1010: obsolete or deprecated built-in
 * - E2011 / E2041 / W1021: a variable in scope named like the function
 */
export const functionCallsRule: Rule = {
  id: "functionCalls",

  check({
    doc,
    text,
    ignore,
    indexer,
    ignoredFuncs,
    diagnosticsEnabled,
  }: CheckContext): vscode.Diagnostic[] {
    if (!diagnosticsEnabled) return [];

    const diags: vscode.Diagnostic[] = [];
    const file = doc.uri.fsPath;
    const fns = indexer.getFunctionRanges(file);
    const re = new RegExp(CALL_RE.source, "g");
    let m: RegExpExecArray | null;

    while ((m = re.exec(text))) {
      const name = m[1];
      const start = m.index;
      const open = start + m[0].length - 1;
      if (RESERVED_WORDS.has(name.toUpperCase())) continue;
      if (inSpan(start, ignore) || inSpan(open, ignore)) continue;
      if (ignoredFuncs.some((r) => r.test(name))) continue;

      const nameRange = new vscode.Range(
        doc.positionAt(start),
        doc.positionAt(start + name.length),
      );
      const close = findMatchingParen(text, open, ignore);
      const callRange = new vscode.Range(
        nameRange.start,
        doc.positionAt(close === -1 ? open + 1 : close + 1),
      );
      const { fn, sure, alternatives, privateIn } = resolve(
        indexer,
        name,
        file,
      );

      // A constant label is expanded first: NAME() is the bare constant, and
      // anything between the parentheses, even blanks, is a label argument
      // error. Another project's label may not be in this file's compile.
      const label = indexer.getLabel(name);
      const labelSure = !!label && sourceInCompile(indexer, file, label.file);
      if (label && (labelSure || !fn)) {
        if (close !== -1 && close !== open + 1) {
          diags.push(
            diag(
              callRange,
              `Label argument error: '${label.name}' is a constant label and takes no arguments.`,
              labelSure ? ERROR : WARNING,
              "E2057",
            ),
          );
        }
        continue;
      }

      // A variable in scope hides a function of the same name (not a label,
      // which is expanded first): the compiler reads the variable followed by
      // a parenthesised expression.
      if (fn?.origin !== "label" && indexer.getVariables(name).length) {
        const f = enclosing(fns, start);
        const v = indexer.resolveVariableInScope(
          name,
          file,
          f ? indexer.localScopeId(file, f.name) : null,
          nameRange.start,
        );
        if (v && /\.ci$/i.test(v.file) && inCompile(file, v.file)) {
          if (close !== -1) {
            const slots = argSlots(text, open, close, ignore);
            const what = fn
              ? `'${name}' is a variable here, so this does not call the function '${fn.name}'`
              : `'${name}' is a variable, not a function`;
            diags.push(
              slots.length > 1
                ? diag(
                    callRange,
                    `Close bracket expected: ${what}.`,
                    ERROR,
                    "E2011",
                  )
                : slots[0].filled
                  ? diag(
                      callRange,
                      `Possible missing operand between tags: ${what}.`,
                      WARNING,
                      "W1021",
                    )
                  : diag(
                      callRange,
                      `Operand expected: ${what}.`,
                      ERROR,
                      "E2041",
                    ),
            );
          }
          continue;
        }
      }

      if (!fn) {
        if (definedThroughLabel(indexer, name)) continue;
        // The compiler reports E2031, but the workspace may not hold every
        // project the file's project includes, so it stays a warning.
        diags.push(
          privateIn
            ? diag(
                nameRange,
                `Function '${name}' is PRIVATE to ${path.basename(privateIn)} and cannot be called from this file (FUNCTION expected).`,
                WARNING,
                "E2031",
              )
            : diag(
                nameRange,
                `Unknown function '${name}' (FUNCTION expected).`,
                WARNING,
                "E2031",
              ),
        );
        continue;
      }
      if (close === -1) continue;

      const slots = argSlots(text, open, close, ignore);
      const isLabel = fn.origin === "label";
      // Where the comma after (or before) an empty slot is; the parentheses
      // for a lone blank one.
      const emptyAt = (i: number) => {
        const [s, e] =
          i < slots.length - 1
            ? [slots[i + 1].at - 1, slots[i + 1].at]
            : i > 0
              ? [slots[i].at - 1, slots[i].at]
              : [open, close + 1];
        return new vscode.Range(doc.positionAt(s), doc.positionAt(e));
      };
      const empty = slots.findIndex(
        (s, i) => !s.filled && i < slots.length - 1,
      );
      if (!isLabel && empty !== -1) {
        diags.push(
          diag(
            emptyAt(empty),
            "Operand expected: empty argument.",
            ERROR,
            "E2041",
          ),
        );
        continue;
      }
      // A trailing comma adds no argument to a function. A label takes every
      // slot, blank ones included; only `()` passes none.
      const filled = slots.filter((s) => s.filled).length;
      const labelArgs = close === open + 1 ? 0 : slots.length;
      const count = (f: FunctionInfo) =>
        f.origin === "label" ? labelArgs : filled;
      const provided = count(fn);

      let arityWrong = false;
      if (!fits(fn, provided) && !alternatives.some((a) => fits(a, count(a)))) {
        arityWrong = true;
        const tooFew = provided < boundsOf(fn).min;
        let code: string;
        let severity: vscode.DiagnosticSeverity;
        let message = `Incorrect number of arguments for function '${fn.name}': expected ${expected(fn)}, got ${provided}.`;
        if (fn.origin === "label") {
          code = "E2057";
          severity = sure ? ERROR : WARNING;
          message = `Label argument error: '${fn.name}' takes ${expected(fn)} argument${expected(fn) === "1" ? "" : "s"}, got ${provided}.`;
        } else if (fn.origin === "builtin") {
          code = "E2022";
          severity = ERROR;
        } else if (tooFew) {
          // A Cicode function called with too few arguments only warns (the
          // compiler's StrictArgumentCheck, on by default).
          code = "W1004";
          severity = WARNING;
        } else {
          code = "E2022";
          // A definition outside the file's project folder and Include may
          // not be in its compile; an entry without an origin may be a
          // library function the workspace doesn't hold.
          severity = fn.origin === "cicode" && sure ? ERROR : WARNING;
        }
        diags.push(diag(callRange, message, severity, code));
      }

      // A label passes an empty argument on into its text, which fails only
      // where the text uses it.
      if (isLabel && labelArgs && !arityWrong) {
        for (let i = 0; i < slots.length; i++) {
          const use = slots[i].filled ? undefined : emptyArgUse(indexer, fn, i);
          if (!use) continue;
          diags.push(
            diag(
              emptyAt(i),
              `Empty argument: the label '${fn.name}' passes it on into ${fn.expr?.trim()}.`,
              sure && use.error ? ERROR : WARNING,
              use.code,
            ),
          );
          break;
        }
      }

      // The argument count is checked first.
      if (fn.origin === "builtin" && fn.obsolete && !arityWrong) {
        if (fn.obsolete === 1) {
          diags.push(
            diag(
              nameRange,
              `Function '${fn.name}' is obsolete and cannot be used anymore.`,
              ERROR,
              "E2101",
            ),
          );
        } else if (DEPRECATED[fn.obsolete]) {
          const [code, what] = DEPRECATED[fn.obsolete];
          diags.push(
            diag(nameRange, `Function '${fn.name}' ${what}.`, WARNING, code),
          );
        }
      }
    }

    return diags;
  },
};
