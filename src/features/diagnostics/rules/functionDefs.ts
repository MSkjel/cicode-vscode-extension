import * as vscode from "vscode";
import type { Rule } from "../rule";
import {
  compileOrder,
  entryInCompile,
  isIncludeFile,
  projectName,
  sourceInCompile,
  type CheckContext,
} from "../context";
import { diag, fileLabel } from "../diag";
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

const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A definition in `other` can clash with one in `file`: always, unless
 *  `file` is in an overlay (a folder inside another project's folder),
 *  which no compile reads; its own files still clash with each other.
 *  With `other` "", whether `file` clashes with other projects at all. */
function compiledWith(indexer: Indexer, file: string, other: string): boolean {
  const g = indexer.projects;
  const p = g.projectOf(file);
  return !p.overlayOf || (!!other && g.projectOf(other).key === p.key);
}

/**
 * Roots of the compile units of `file` that compile `other` too, by which
 * of two definitions of one name the compiler reaches second there, and so
 * reports: the one `here` in `file` or the one `there` in `other`. Both
 * are empty when no unit compiles the two together.
 */
function secondOf(
  indexer: Indexer,
  file: string,
  other: string,
): { here: string[]; there: string[] } {
  const here: string[] = [];
  const there: string[] = [];
  for (const o of compileOrder(indexer, file, other)) {
    (o.before ? there : here).push(o.root);
  }
  return { here, there };
}

/** " when compiling R" when only some compiles of `file` hold a clash: its
 *  project is compiled by several roots, which differ in whether they
 *  compile the other definition or in their order. */
function whenCompiling(
  indexer: Indexer,
  file: string,
  roots: string[],
): string {
  return roots.length < indexer.projects.unitsOf(file).length
    ? ` when compiling ${roots.join(" or ")}`
    : "";
}

/** A file whose diagnostics are not shown with `file`'s: a project read
 *  from outside the workspace, or Include (library code) for another
 *  project. A compiler error there is reported at `file` instead. */
function libraryCode(indexer: Indexer, file: string, other: string): boolean {
  return (
    indexer.isExternal(other) ||
    (isIncludeFile(indexer, other) && !isIncludeFile(indexer, file))
  );
}

/** The library whose shipped Cicode function `name` stands in for its
 *  project, compiled with `file` but not indexed (an indexed one has its
 *  own definitions); undefined for a file of that project. */
function shippedLibrary(
  indexer: Indexer,
  file: string,
  name: string,
): string | undefined {
  const b = indexer.getBuiltinFunction(name);
  if (b?.origin !== "cicode" || b.file || !b.library) return undefined;
  if (!indexer.projects.hasLibrary(file, b.library)) return undefined;
  const lib = indexer.projects.libraryProject(file, b.library);
  if (lib?.key === indexer.projects.projectOf(file).key) return undefined;
  return indexer
    .getFunctionCandidatesFor(name, file)
    .some((c) => c.origin === "cicode" && !c.file)
    ? b.library
    : undefined;
}

/** Function-like label of `file`'s compile that the compiler would expand
 *  in a header named `name`. */
function labelMacro(
  indexer: Indexer,
  name: string,
  file: string,
): FunctionInfo | undefined {
  const fn = indexer.getFunctionFor(name, file);
  return fn?.origin === "label" ? fn : undefined;
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

/** Another definition the compiler reports a function or GLOBAL with
 *  (E2021). */
interface Clash {
  /** Where the other definition is. */
  where: string;
  /** It is compiled after this one, in library code: the compiler reports
   *  it there. */
  after: boolean;
  /** whenCompiling of the units holding the clash. */
  when: string;
}

/**
 * Another definition of the function `name` defined in `file` that a unit
 * compiles with it (E2021): one compiled before it, or one compiled after
 * it in library code, whose diagnostics are not shown. A definition clashes
 * with a PUBLIC one compiled before it; another file's PRIVATE one is
 * invisible to it.
 */
function functionClash(
  indexer: Indexer,
  file: string,
  name: string,
  isPrivate: boolean,
): Clash | undefined {
  let after: Clash | undefined;
  for (const g of indexer.getFunctionDefinitions(name, file)) {
    if (!g.file || samePath(g.file, file)) continue;
    const { here, there } = secondOf(indexer, file, g.file);
    if (here.length && !g.isPrivate) {
      return {
        where: fileLabel(indexer, g.file),
        after: false,
        when: whenCompiling(indexer, file, here),
      };
    }
    if (there.length && !isPrivate && libraryCode(indexer, file, g.file)) {
      after ??= {
        where: fileLabel(indexer, g.file),
        after: true,
        when: whenCompiling(indexer, file, there),
      };
    }
  }
  if (after || !compiledWith(indexer, file, "")) return after;

  // A documented function that is Cicode in an AVEVA library project
  // compiled with the file but not indexed: Include compiles first, another
  // library where its units put it.
  const lib = shippedLibrary(indexer, file, name);
  if (!lib) return undefined;
  const where = `the ${lib} project`;
  const libKey = indexer.projects.libraryProject(file, lib)?.key;
  if (!libKey) return { where, after: false, when: "" };
  const own = indexer.projects.projectOf(file).key;
  const here: string[] = [];
  const there: string[] = [];
  for (const u of indexer.projects.unitsOf(file)) {
    const at = u.projects.indexOf(libKey);
    if (at >= 0) (at < u.projects.indexOf(own) ? here : there).push(u.root);
  }
  if (here.length) {
    return { where, after: false, when: whenCompiling(indexer, file, here) };
  }
  if (there.length && !isPrivate) {
    return { where, after: true, when: whenCompiling(indexer, file, there) };
  }
  return undefined;
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

      // The name the compiler defines: a label in the header is expanded
      // first.
      let name = f.name;
      let say = (rest: string) => `Function '${f.name}' ${rest}`;
      let labelSure = true;
      let sig = "";
      let renamed = false;
      const macro = labelMacro(indexer, f.name, file);
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
        renamed = true;
      } else {
        // A constant label followed by anything in parentheses, even blanks.
        const label = indexer.getLabel(f.name, file);
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
      if (renamed) {
        say = (rest: string) =>
          `The label ${sig} renames this function to '${name}', which ${rest}`;
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
              clash.after
                ? `is defined again in ${clash.where}, compiled after it${clash.when}; the compiler reports that one.`
                : `is already defined in ${clash.where}${clash.when}.`,
            ),
            labelSure ? ERROR : WARNING,
            "E2021",
          ),
        );
      }

      // Variables are registered before functions: a GLOBAL compiled with
      // it, or a file-level variable declared above the function in its
      // file.
      const vars = indexer.getVariables(name, file);
      const globals = vars.filter(
        (v) =>
          v.scopeType === "global" &&
          !v.isParam &&
          isCiFile(v.file) &&
          compiledWith(indexer, file, v.file),
      );
      const global = globals.find((v) => samePath(v.file, file)) ?? globals[0];
      if (global) {
        const here = samePath(global.file, file);
        const when = here
          ? ""
          : whenCompiling(
              indexer,
              file,
              compileOrder(indexer, file, global.file).map((o) => o.root),
            );
        diags.push(
          diag(
            range,
            say(
              `has the same name as the GLOBAL variable declared in ${here ? "this file" : fileLabel(indexer, global.file)}${when}.`,
            ),
            labelSure ? ERROR : WARNING,
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

    // Another GLOBAL compiled before it, or after it in library code.
    let clash: vscode.Diagnostic | undefined;
    for (const o of indexer.getVariables(v.name, file)) {
      if (
        o.scopeType !== "global" ||
        samePath(o.file, file) ||
        !isCiFile(o.file)
      ) {
        continue;
      }
      const { here, there } = secondOf(indexer, file, o.file);
      if (here.length) {
        clash = diag(
          nameRange(v),
          `GLOBAL variable '${v.name}' is already defined in ${fileLabel(indexer, o.file)}${whenCompiling(indexer, file, here)}.`,
          ERROR,
          "E2021",
        );
        break;
      }
      if (there.length && libraryCode(indexer, file, o.file)) {
        clash ??= diag(
          nameRange(v),
          `GLOBAL variable '${v.name}' is defined again in ${fileLabel(indexer, o.file)}, compiled after it${whenCompiling(indexer, file, there)}; the compiler reports that one.`,
          ERROR,
          "E2021",
        );
      }
    }
    if (clash) {
      diags.push(clash);
      continue;
    }

    // The compiler reports a GLOBAL named like a function at the function
    // (PUBLIC or PRIVATE), in any order; for library code the fix is here.
    const builtin = indexer.getBuiltinFunction(v.name);
    const libFn = indexer
      .getFunctionDefinitions(v.name, file)
      .find((g) => !!g.file && libraryCode(indexer, file, g.file));
    const lib = !compiledWith(indexer, file, "")
      ? undefined
      : libFn?.file
        ? projectName(indexer, libFn.file)
        : shippedLibrary(indexer, file, v.name);
    if (lib) {
      const when = libFn?.file
        ? whenCompiling(
            indexer,
            file,
            compileOrder(indexer, file, libFn.file).map((o) => o.root),
          )
        : "";
      diags.push(
        diag(
          nameRange(v),
          `GLOBAL variable '${v.name}' has the same name as a function of the ${lib} project${when}.`,
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
