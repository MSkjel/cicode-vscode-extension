import * as path from "path";
import * as vscode from "vscode";
import type { Rule } from "../rule";
import {
  compilesBefore,
  displayPath,
  entryInCompile,
  inCompile,
  inSameFolder,
  isIncludeFile,
  sourceInCompile,
  type CheckContext,
} from "../context";
import { diag } from "../diag";
import { nameKey, upperAscii } from "../../../shared/textUtils";
import { getOptionalParamFlags } from "../../../shared/utils";
import { splitParamsTopLevel } from "../../../shared/parseHelpers";
import { CICODE_TYPES } from "../../../shared/constants";
import {
  isIdentifier,
  isToken,
  lex,
  type Token,
} from "../../../core/indexer/lexer";
import type { FunctionInfo, VariableEntry } from "../../../shared/types";
import type { Indexer } from "../../../core/indexer/indexer";
import type { FunctionRange } from "../../../core/indexer/types";

const ERROR = vscode.DiagnosticSeverity.Error;
const WARNING = vscode.DiagnosticSeverity.Warning;

const SCOPE_WORDS = new Set(["PUBLIC", "PRIVATE", "GLOBAL", "MODULE"]);

const isCiFile = (file: string) => /\.ci$/i.test(file);

const folderName = (file: string) =>
  path.basename(path.dirname(file)).toLowerCase();

/**
 * Which of two definitions of one name in different files the compiler
 * reaches second, and so reports: the one "here" in `file`, the one "there"
 * in `other`, or "unknown" for unrelated folders, where neither the order nor
 * whether both are compiled together is known.
 */
function secondOf(file: string, other: string): "here" | "there" | "unknown" {
  if (inSameFolder(file, other)) {
    return compilesBefore(other, file) ? "here" : "there";
  }
  const here = isIncludeFile(file);
  const there = isIncludeFile(other);
  if (there && !here) return "here";
  if (here && !there) return "there";
  return "unknown";
}

/** Function-like label that the compiler would expand in a header named `name`. */
function labelMacro(indexer: Indexer, name: string): FunctionInfo | undefined {
  const top = indexer.getFunction(name);
  if (top?.origin === "label") return top;
  const b = indexer.getBuiltinFunction(name);
  return b?.origin === "label" ? b : undefined;
}

/** What the compiler makes of a header named like a function-like label;
 *  `sure` is false where the result may still compile. */
type Expansion =
  | { kind: "argError"; why: string }
  | { kind: "renamed"; name: string }
  | { kind: "unreachable" }
  | { kind: "broken"; sure: boolean; code?: string };

/** Arguments a header passes to a label: none without parentheses or with
 *  `()`, else one per top-level comma plus one (blank ones count). */
function headerArgs(f: FunctionRange): number {
  if (!f.hasParens || !f.paramsRaw.length) return 0;
  let depth = 0;
  let n = 1;
  for (const t of lex(f.paramsRaw).tokens) {
    if (isToken(t, "(")) depth++;
    else if (isToken(t, ")")) depth--;
    else if (depth === 0 && isToken(t, ",")) n++;
  }
  return n;
}

/**
 * The header is expanded like a call, its parameters being the label's
 * arguments. The text's first token becomes the name: a name renames the
 * function, anything else (a `$n`, a number, a keyword, a parameter) leaves
 * a function no call reaches. A call whose arguments are parameters the
 * header supplies renames it too; any other argument breaks the header (a
 * literal or default-filled one gives E2015 first). Further text becomes
 * body code, which fails (E2041) where it holds a parameter the header
 * supplies, typed words included, and may compile otherwise.
 */
function expandHeader(
  macro: FunctionInfo,
  f: FunctionRange,
  given: number,
): Expansion {
  const min = macro.minArgs ?? 0;
  const max = macro.maxArgs ?? macro.params.length;
  if (given < min || (max >= 0 && given > max)) {
    const want =
      min === max ? `${min}` : max < 0 ? `${min} or more` : `${min}-${max}`;
    return {
      kind: "argError",
      why: f.hasParens
        ? `it takes ${want}, the header passes ${given}`
        : "used without parentheses",
    };
  }
  const expr = (macro.expr ?? "").trim();
  if (/^\$\d+$/.test(expr)) return { kind: "unreachable" };

  const params = macro.params.map((p) => upperAscii(p.split("=")[0].trim()));
  const supplied = params.slice(0, given);
  const T = lex(expr).tokens;
  const head = T[0];
  if (!head) return { kind: "broken", sure: true };
  const bodyCode = (from: number): Expansion =>
    T.slice(from).some((t) => t.kind === "w" && supplied.includes(t.text))
      ? { kind: "broken", sure: true, code: "E2041" }
      : { kind: "broken", sure: false };
  const isParam = head.kind === "w" && params.includes(head.text);
  if (!isIdentifier(head) || isParam) {
    return T.length === 1 ? { kind: "unreachable" } : bodyCode(1);
  }
  const name = expr.slice(head.start, head.end);
  if (T.length === 1) return { kind: "renamed", name };
  if (!isToken(T[1], "(")) return bodyCode(1);

  const args: Token[][] = [[]];
  let depth = 0;
  let k = 2;
  for (; k < T.length; k++) {
    const t = T[k];
    if (isToken(t, "(")) depth++;
    else if (isToken(t, ")") && --depth < 0) break;
    if (depth === 0 && isToken(t, ",")) args.push([]);
    else args[args.length - 1].push(t);
  }
  if (k === T.length) return { kind: "broken", sure: true };
  if (args.length > 1 || args[0].length) {
    const used = new Set<string>();
    for (const a of args) {
      const p = a.length === 1 && isIdentifier(a[0]) ? a[0].text : undefined;
      if (!p || !supplied.includes(p)) {
        return { kind: "broken", sure: true, code: "E2015" };
      }
      if (used.has(p)) return { kind: "broken", sure: true, code: "E2021" };
      used.add(p);
    }
  }
  return k === T.length - 1 ? { kind: "renamed", name } : bodyCode(k + 1);
}

/**
 * Another definition of the function `name` defined in `file` (E2021): where
 * it is, and whether both are certainly in one compile. A PRIVATE function
 * only clashes with a PUBLIC one compiled before it.
 */
function functionClash(
  indexer: Indexer,
  file: string,
  name: string,
  isPrivate: boolean,
): { where: string; sure: boolean } | undefined {
  const defs = indexer.getFunctionDefinitions(name);
  let maybe: { where: string; sure: boolean } | undefined;
  for (const g of defs) {
    if (!g.file || g.file === file || g.isPrivate) continue;
    const second = secondOf(file, g.file);
    if (second === "here") return { where: displayPath(g.file), sure: true };
    // Unrelated folders: both are in one compile only when one project
    // includes the other.
    if (second === "unknown" && !isPrivate) {
      maybe ??= { where: displayPath(g.file), sure: false };
    }
  }
  if (maybe) return maybe;

  // A documented function that is Cicode in an AVEVA library project the
  // workspace doesn't hold (otherwise its definition is compared above).
  const b = indexer.getBuiltinFunction(name);
  const lib =
    b?.origin === "cicode" && !b.file ? b.library?.toLowerCase() : undefined;
  if (
    !lib ||
    folderName(file) === lib ||
    defs.some((g) => g.file && folderName(g.file) === lib)
  ) {
    return undefined;
  }
  if (lib === "include") return { where: "the Include project", sure: true };
  return isPrivate
    ? undefined
    : { where: `the ${b!.library} project`, sure: false };
}

/** A scope keyword after the return type, or a second one: E2031. */
function misplacedScope(text: string, f: FunctionRange): Token | undefined {
  const { tokens } = lex(text.slice(f.itemStart, f.headerIndex));
  let seen = false;
  for (const t of tokens) {
    if (t.kind !== "w") continue;
    if (SCOPE_WORDS.has(t.text)) {
      if (seen) return t;
      seen = true;
    } else if (CICODE_TYPES.has(t.text)) {
      seen = true;
    }
  }
  return undefined;
}

function nameRange(v: VariableEntry): vscode.Range {
  const p = v.location!.range.start;
  return new vscode.Range(p, p.translate(0, v.name.length));
}

/**
 * Checks definitions:
 * - E2031 / E2069 / E2070: misplaced scope keyword, MODULE or GLOBAL function
 * - E2021: a name defined twice. Functions share one namespace across the
 *   compile, where a PRIVATE function only clashes with a PUBLIC one compiled
 *   before it; a GLOBAL variable, or a file-level variable declared above it,
 *   also clashes with a function; variables clash within their scope
 * - a function named like a label, which the compiler expands in the header
 *   (E2057 for arguments the label doesn't take)
 * - W1006: function named like a built-in of the compiler's table
 * - W1003: parameter with a default before one without
 */
export const functionDefsRule: Rule = {
  id: "functionDefs",

  check({
    indexer,
    doc,
    text,
    diagnosticsEnabled,
  }: CheckContext): vscode.Diagnostic[] {
    if (!diagnosticsEnabled) return [];

    const diags: vscode.Diagnostic[] = [];
    const file = doc.uri.fsPath;
    const fns = indexer.getFunctionRanges(file);
    const seen = new Set<string>();

    for (const f of fns) {
      const range = f.location.range;
      const isPrivate = f.scope?.toUpperCase() === "PRIVATE";
      const params = splitParamsTopLevel(f.paramsRaw || "").filter(Boolean);

      const misplaced = misplacedScope(text, f);
      if (misplaced) {
        const at = f.itemStart + misplaced.start;
        diags.push(
          diag(
            new vscode.Range(
              doc.positionAt(at),
              doc.positionAt(at + misplaced.end - misplaced.start),
            ),
            "A function takes one scope keyword, written before the return type (FUNCTION expected).",
            ERROR,
            "E2031",
          ),
        );
      } else if (f.scope === "MODULE") {
        diags.push(
          diag(
            range,
            "MODULE function is not allowed, use PRIVATE.",
            ERROR,
            "E2069",
          ),
        );
      } else if (f.scope === "GLOBAL") {
        diags.push(
          diag(
            range,
            "GLOBAL function is not allowed, use PUBLIC.",
            ERROR,
            "E2070",
          ),
        );
      }

      // The name the compiler defines: a function-like label in the header
      // is expanded first.
      let name = f.name;
      let say = (rest: string) => `Function '${f.name}' ${rest}`;
      let labelSure = true;
      let sig = "";
      const macro = labelMacro(indexer, f.name);
      if (macro) {
        labelSure = entryInCompile(indexer, file, macro);
        sig = `${macro.name}(${macro.params.join(", ")})`;
        const x = expandHeader(macro, f, headerArgs(f));
        if (x.kind !== "renamed") {
          diags.push(
            x.kind === "argError"
              ? diag(
                  range,
                  `Label argument error: '${f.name}' is the label ${sig}, which the compiler expands in this header (${x.why}).`,
                  labelSure ? ERROR : WARNING,
                  "E2057",
                )
              : x.kind === "unreachable"
                ? diag(
                    range,
                    `'${f.name}' is the label ${sig}: every call to '${f.name}' expands the label, so this function is never called.`,
                    WARNING,
                  )
                : diag(
                    range,
                    `'${f.name}' is the label ${sig}; the compiler expands it in this header, which then ${x.sure ? "fails" : "may fail"} to compile. Rename the function.`,
                    labelSure && x.sure ? ERROR : WARNING,
                    x.code,
                  ),
          );
          continue;
        }
        name = x.name;
        say = (rest: string) =>
          `The label ${sig} renames this function to '${name}', which ${rest}`;
      } else {
        // A constant label followed by anything in parentheses, even blanks.
        const label = indexer.getLabel(f.name);
        if (label && f.hasParens && f.paramsRaw.length) {
          diags.push(
            diag(
              range,
              `Label argument error: '${f.name}' is a constant label and takes no arguments.`,
              sourceInCompile(indexer, file, label.file) ? ERROR : WARNING,
              "E2057",
            ),
          );
          continue;
        }
      }
      const reported = diags.length;
      const key = nameKey(name);

      if (seen.has(key)) {
        diags.push(
          diag(
            range,
            say("is already defined in this file."),
            labelSure ? ERROR : WARNING,
            "E2021",
          ),
        );
        continue;
      }
      seen.add(key);

      const clash = functionClash(indexer, file, name, isPrivate);
      if (clash) {
        diags.push(
          diag(
            range,
            say(
              `is ${clash.sure ? "already" : "also"} defined in ${clash.where}.`,
            ),
            clash.sure && labelSure ? ERROR : WARNING,
            "E2021",
          ),
        );
      }

      // Variables are registered before functions: a GLOBAL anywhere, or a
      // file-level variable declared above the function in its file.
      const vars = indexer.getVariables(name);
      const globals = vars.filter(
        (v) => v.scopeType === "global" && !v.isParam && isCiFile(v.file),
      );
      const global = globals.find((v) => inCompile(file, v.file)) ?? globals[0];
      if (global) {
        diags.push(
          diag(
            range,
            say(
              `has the same name as the GLOBAL variable declared in ${global.file === file ? "this file" : displayPath(global.file)}.`,
            ),
            inCompile(file, global.file) && labelSure ? ERROR : WARNING,
            "E2021",
          ),
        );
      } else {
        const moduleVar = vars.find(
          (v) =>
            v.scopeType === "module" &&
            v.file === file &&
            v.location &&
            doc.offsetAt(v.location.range.start) < f.nameOffset,
        );
        if (moduleVar) {
          diags.push(
            diag(
              range,
              say(
                "has the same name as the variable declared above it in this file.",
              ),
              labelSure ? ERROR : WARNING,
              "E2021",
            ),
          );
        }
      }

      if (indexer.getBuiltinFunction(name)?.origin === "builtin") {
        diags.push(
          diag(
            range,
            say(
              `has the same name as a built-in function and replaces it ${isPrivate ? "in this file" : "in every file"}.`,
            ),
            WARNING,
            "W1006",
          ),
        );
      }

      if (macro && diags.length === reported) {
        diags.push(
          diag(
            range,
            `The label ${sig} renames this function to '${name}'; calls to '${f.name}' reach it through the label.`,
            WARNING,
          ),
        );
      }

      let foundOptional = false;
      for (const isOpt of getOptionalParamFlags(params)) {
        if (isOpt) {
          foundOptional = true;
        } else if (foundOptional) {
          diags.push(
            diag(
              range,
              "Argument with default found before argument with no default.",
              WARNING,
              "W1003",
            ),
          );
          break;
        }
      }
    }

    diags.push(...checkVariables(indexer, doc, fns));
    return diags;
  },
};

/** E2021 for variables: twice in one function (parameters included), twice
 *  at file level, a GLOBAL twice in the compile, or a GLOBAL after a MODULE
 *  of the same name in one file. A MODULE after a GLOBAL, or in another
 *  file, doesn't clash, nor does a local with an outer one. */
function checkVariables(
  indexer: Indexer,
  doc: vscode.TextDocument,
  fns: ReadonlyArray<{ name: string }>,
): vscode.Diagnostic[] {
  const diags: vscode.Diagnostic[] = [];
  const file = doc.uri.fsPath;
  // Two functions of one name share a local scope id; their locals would
  // look like duplicates.
  const count = new Map<string, number>();
  for (const f of fns) {
    const k = nameKey(f.name);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const skipScopes = new Set(
    fns
      .filter((f) => count.get(nameKey(f.name))! > 1)
      .map((f) => indexer.localScopeId(file, f.name)),
  );
  const at = (v: VariableEntry) => doc.offsetAt(v.location!.range.start);
  const vars = indexer
    .getVariablesInFile(file)
    .filter((v) => v.location && !skipScopes.has(v.scopeId))
    .sort((a, b) => at(a) - at(b));

  const seen = new Set<string>();
  for (const v of vars) {
    const key = `${v.scopeType === "global" ? "global" : v.scopeId}|${nameKey(v.name)}`;
    if (seen.has(key)) {
      const where = v.scopeType === "local" ? "this function" : "this file";
      diags.push(
        diag(
          nameRange(v),
          `'${v.name}' is already defined in ${where}.`,
          ERROR,
          "E2021",
        ),
      );
      continue;
    }
    seen.add(key);
    if (v.scopeType !== "global") continue;

    // A GLOBAL after a MODULE of the same name in this file finds the
    // MODULE one (in the other order the MODULE one hides the GLOBAL).
    if (seen.has(`${file}|${nameKey(v.name)}`)) {
      diags.push(
        diag(
          nameRange(v),
          `'${v.name}' is already defined in this file (as a MODULE variable).`,
          ERROR,
          "E2021",
        ),
      );
      continue;
    }

    let clash: vscode.Diagnostic | undefined;
    for (const o of indexer.getVariables(v.name)) {
      if (o.scopeType !== "global" || o.file === file || !isCiFile(o.file)) {
        continue;
      }
      const second = secondOf(file, o.file);
      if (second === "here") {
        clash = diag(
          nameRange(v),
          `GLOBAL variable '${v.name}' is already defined in ${displayPath(o.file)}.`,
          ERROR,
          "E2021",
        );
        break;
      }
      if (second === "unknown") {
        clash ??= diag(
          nameRange(v),
          `GLOBAL variable '${v.name}' is also defined in ${displayPath(o.file)}.`,
          WARNING,
          "E2021",
        );
      }
    }
    if (clash) {
      diags.push(clash);
      continue;
    }

    const builtin = indexer.getBuiltinFunction(v.name);
    const includeFunction =
      (builtin?.origin === "cicode" &&
        !builtin.file &&
        builtin.library?.toLowerCase() === "include") ||
      indexer
        .getFunctionDefinitions(v.name)
        .some((g) => g.file && isIncludeFile(g.file));
    if (includeFunction && !isIncludeFile(file)) {
      // The compiler reports it at the Include function (PUBLIC or PRIVATE),
      // which is library code; the fix is here.
      diags.push(
        diag(
          nameRange(v),
          `GLOBAL variable '${v.name}' has the same name as a function of the Include project.`,
          ERROR,
          "E2021",
        ),
      );
    } else if (builtin?.origin === "builtin") {
      // Calls to the built-in then read the variable (W1021, or E2024 where
      // the result is used), the Include project's calls too.
      diags.push(
        diag(
          nameRange(v),
          `GLOBAL variable '${v.name}' hides the built-in function '${builtin.name}' in every file.`,
          WARNING,
        ),
      );
    }
  }
  return diags;
}
