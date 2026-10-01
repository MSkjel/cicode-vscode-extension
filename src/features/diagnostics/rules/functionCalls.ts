import * as path from "path";
import * as vscode from "vscode";
import type { Rule } from "../rule";
import {
  entryInCompile,
  inCompile,
  inSameFolder,
  sourceInCompile,
  type CheckContext,
} from "../context";
import { diag, fileLabel } from "../diag";
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
import { reachedFunctions, unitsKnown } from "./statements";

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
  /** What other compile units of the file reach instead. */
  alternatives: FunctionInfo[];
  /** A PRIVATE definition in another file, when nothing else resolves. */
  privateIn?: string;
  /** Where the file is compiled by several roots: roots of known units
   *  that reach no definition (E2031 when compiling them). */
  missingIn: string[];
  /** Likewise, what each known unit reaches, by root. */
  byRoot: Array<{ root: string; fn: FunctionInfo }>;
}

/**
 * The function a call in `file` reaches among the projects compiled with
 * it: a function-like label first (labels are expanded before names are
 * looked up), then the file's own function, then a PUBLIC one, then a
 * built-in. PRIVATE functions of other files are invisible, even when they
 * share a built-in's name.
 */
function resolve(indexer: Indexer, name: string, file: string): Resolved {
  const per = indexer.getFunctionsByUnit(name, file);
  const [fn, ...alternatives] = reachedFunctions(indexer, name, file, per);
  if (!fn) {
    const priv = indexer
      .getFunctionDefinitions(name, file)
      .find((d) => d.isPrivate && d.file !== file);
    return {
      sure: false,
      alternatives: [],
      privateIn: priv?.file ?? undefined,
      missingIn: [],
      byRoot: [],
    };
  }
  const known =
    per.length > 1
      ? per.filter((p) => indexer.projects.unitKnown(file, p.unit))
      : [];
  return {
    fn,
    sure: entryInCompile(indexer, file, fn),
    alternatives,
    missingIn: known.filter((p) => !p.fn).map((p) => p.unit.root),
    byRoot: known.flatMap((p) =>
      p.fn ? [{ root: p.unit.root, fn: p.fn }] : [],
    ),
  };
}

// Function-like labels by the upper-case name their text starts with, per
// visible function set (getAllFunctions, rebuilt on any change).
const labelHeads = new WeakMap<
  ReadonlyMap<string, FunctionInfo>,
  Map<string, string[]>
>();

/** True when a function is defined under `name` through a label: a header
 *  named like a function-like label that expands to `name(...)`. */
function definedThroughLabel(
  indexer: Indexer,
  name: string,
  file: string,
): boolean {
  const all = indexer.getAllFunctions(file);
  let heads = labelHeads.get(all);
  if (!heads) {
    heads = new Map();
    for (const fn of all.values()) {
      if (fn.origin !== "label" || !fn.expr) continue;
      const head = /^\s*([^\s(]+)/.exec(fn.expr)?.[1];
      if (head === undefined) continue;
      const k = upperAscii(head);
      heads.set(k, [...(heads.get(k) ?? []), fn.name]);
    }
    labelHeads.set(all, heads);
  }
  return (heads.get(upperAscii(name)) ?? []).some(
    (m) => indexer.getFunctionDefinitions(m, file).length > 0,
  );
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
 * The text is expanded in `file`, where its callee is looked up.
 */
function emptyArgUse(
  indexer: Indexer,
  fn: FunctionInfo,
  index: number,
  file: string,
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
  const callee = indexer.getFunctionFor(T[j - 1].text, file);
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
export function argSlots(
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
 * - E2031 / E2022 / W1004 / E2057 as a Warning "when compiling R": a file
 *   several roots compile, failing under some of them only
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
      const { fn, sure, alternatives, privateIn, missingIn, byRoot } = resolve(
        indexer,
        name,
        file,
      );

      // A constant label is expanded first: NAME() is the bare constant, and
      // anything between the parentheses, even blanks, is a label argument
      // error.
      const label = indexer.getLabel(name, file);
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
      if (fn?.origin !== "label" && indexer.getVariables(name, file).length) {
        const f = enclosing(fns, start);
        const v = indexer.resolveVariableInScope(
          name,
          file,
          f ? indexer.localScopeId(file, f.name) : null,
          nameRange.start,
        );
        if (v && /\.ci$/i.test(v.file) && inCompile(indexer, file, v.file)) {
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
        if (definedThroughLabel(indexer, name, file)) continue;
        // E2031, certain once every project compiled with the file is
        // known; an include row that names no project, or a project not
        // indexed (yet), may hide the definition.
        const severity = unitsKnown(indexer, file) ? ERROR : WARNING;
        diags.push(
          privateIn
            ? diag(
                nameRange,
                `Function '${name}' is PRIVATE to ${inSameFolder(file, privateIn) ? path.basename(privateIn) : fileLabel(indexer, privateIn)} and cannot be called from this file (FUNCTION expected).`,
                severity,
                "E2031",
              )
            : diag(
                nameRange,
                `Unknown function '${name}' (FUNCTION expected).`,
                severity,
                "E2031",
              ),
        );
        continue;
      }
      // Defined where some roots compile the file, not where others do.
      if (missingIn.length && !definedThroughLabel(indexer, name, file)) {
        diags.push(
          diag(
            nameRange,
            `Unknown function '${name}' when compiling ${missingIn.join(" or ")} (FUNCTION expected).`,
            WARNING,
            "E2031",
          ),
        );
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
          // An entry without an origin may be a library function no
          // project holds.
          severity = fn.origin === "cicode" && sure ? ERROR : WARNING;
        }
        diags.push(diag(callRange, message, severity, code));
      } else {
        // The count fits what some roots define, not what others do.
        const bad = byRoot.filter((r) => !fits(r.fn, count(r.fn)));
        if (bad.length && bad.length < byRoot.length) {
          const f = bad[0].fn;
          const roots = bad.filter((r) => r.fn === f).map((r) => r.root);
          const n = count(f);
          diags.push(
            diag(
              callRange,
              f.origin === "label"
                ? `Label argument error: '${f.name}' takes ${expected(f)} argument${expected(f) === "1" ? "" : "s"} when compiling ${roots.join(" or ")}, got ${n}.`
                : `Incorrect number of arguments for function '${f.name}' when compiling ${roots.join(" or ")}: expected ${expected(f)}, got ${n}.`,
              WARNING,
              f.origin === "label"
                ? "E2057"
                : f.origin === "cicode" && n < boundsOf(f).min
                  ? "W1004"
                  : "E2022",
            ),
          );
        }
      }

      // A label passes an empty argument on into its text, which fails only
      // where the text uses it.
      if (isLabel && labelArgs && !arityWrong) {
        for (let i = 0; i < slots.length; i++) {
          const use = slots[i].filled
            ? undefined
            : emptyArgUse(indexer, fn, i, file);
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
