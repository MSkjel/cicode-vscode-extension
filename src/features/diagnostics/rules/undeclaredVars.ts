import * as vscode from "vscode";
import type { Rule } from "../rule";
import { inCompile, type CheckContext } from "../context";
import { diag } from "../diag";
import type { FunctionInfo } from "../../../shared/types";
import { ALL_TYPES, INCLUDE_BOOL_LABELS } from "../../../shared/constants";
import { upperAscii } from "../../../shared/textUtils";
import {
  argumentKind,
  functionBody,
  hasTypeLabels,
  isIdentifier,
  isToken,
  labelCertain,
  labelOf,
  nameArguments,
  tokensOf,
  typeLabel,
  walkStatements,
  word,
} from "./statements";

const ERROR = vscode.DiagnosticSeverity.Error;
const WARNING = vscode.DiagnosticSeverity.Warning;

/**
 * Checks the names a function body uses, the way the compiler resolves them
 * (labels first, then variables declared so far, then functions):
 * - a function-like label that needs arguments, without them: E2057
 * - a Cicode function without parentheses: E2019 (Open bracket expected),
 *   except as a callback, the whole argument of a built-in's FUNCTION
 *   parameter, which must name an INT Cicode function without parameters
 *   (E2024 otherwise, and for a function in a VARARG argument)
 * - a built-in without parentheses: E2022 when it needs arguments (one
 *   without required arguments is called), E2024 as a callback
 * - with cicode.diagnostics.warnUndeclaredVariables, any other name: the
 *   compiler reads it as a tag (W1007 Tag not defined when no variable tag
 *   has the name; tags are not indexed, hence off by default)
 */
export const undeclaredVarsRule: Rule = {
  id: "undeclaredVars",

  check({
    text,
    indexer,
    doc,
    diagnosticsEnabled,
    cfg,
  }: CheckContext): vscode.Diagnostic[] {
    if (!diagnosticsEnabled) return [];

    const diags: vscode.Diagnostic[] = [];
    const ignored = cfg.ignoredUndeclaredVariables;
    const file = doc.uri.fsPath;
    // Variables of this file declared under a label that renames them
    // (`INT Alias;` with label Alias = Name declares Name).
    const renamed = indexer
      .getVariablesInFile(file)
      .filter((v) => v.scopeType !== "global")
      .flatMap((v) => {
        const l = labelOf(indexer, v.name);
        return l?.isName ? [{ v, to: upperAscii(l.expr.trim()) }] : [];
      });

    // Names declared through a label that expands to a type (`ZINT a, b;`);
    // the indexer does not record them.
    let typeLabelled: Set<string> | undefined;
    const declaredByTypeLabel = (name: string) => {
      if (!typeLabelled) {
        typeLabelled = new Set();
        const all = tokensOf(text);
        for (let k = 0; k + 1 < all.length; k++) {
          if (!isIdentifier(all[k]) || !typeLabel(indexer, all[k].text))
            continue;
          for (let j = k + 1; isIdentifier(all[j]); j += 2) {
            typeLabelled.add(all[j].text);
            if (!isToken(all[j + 1], ",")) break;
          }
        }
      }
      return typeLabelled.has(name);
    };

    for (const f of indexer.getFunctionRanges(file)) {
      const body = functionBody(text, f);
      const T = body.tokens;
      const scopeId = indexer.localScopeId(file, f.name);
      // Declared names are no uses; the invalidDeclarations rule reports
      // the ones that are labels or that the compiler rejects.
      const declared = new Set<number>();
      walkStatements(body.stmts, (s) => {
        if (s.kind === "decl") for (const n of s.names!) declared.add(n.tok);
      });
      const args = nameArguments(T, body.start, body.end);

      for (let k = body.start; k < body.end; k++) {
        const t = T[k];
        if (!isIdentifier(t) || declared.has(k)) continue;
        const prev = k > body.start ? T[k - 1] : undefined;
        const next = k + 1 < body.end ? T[k + 1] : undefined;
        // Calls are the functionCalls rule's; `Tag.Field` and equipment
        // references (`Area.Unit.Item`) name tags, never variables.
        if (isToken(next, "(") || isToken(prev, ".") || isToken(next, ".")) {
          continue;
        }
        // The FOR variable is checked by the controlFlow rule.
        if (word(prev) === "FOR") continue;
        if (ALL_TYPES.has(t.text) || INCLUDE_BOOL_LABELS.has(t.text)) continue;

        const name = text.slice(t.start, t.end);
        const range = () =>
          new vscode.Range(doc.positionAt(t.start), doc.positionAt(t.end));

        const lab = labelOf(indexer, name);
        if (lab) {
          if (lab.needsArgs) {
            diags.push(
              diag(
                range(),
                `Label argument error: '${name}' is a label that takes arguments; use it with parentheses: ${name}(...).`,
                labelCertain(indexer, lab, file) ? ERROR : WARNING,
                "E2057",
              ),
            );
          }
          continue;
        }

        // How the call around the name takes it: "value" outside a call;
        // undefined when unknown, or inside a FUNCTION or VARARG argument
        // that is more than the name (the compiler reports that argument).
        const slot = args.get(k);
        let kind: ReturnType<typeof argumentKind> | null = null;
        const kindOf = () => {
          if (kind !== null) return kind;
          if (!slot) return (kind = "value");
          const callee = T[slot.callee];
          kind = argumentKind(
            indexer,
            text.slice(callee.start, callee.end),
            slot.index,
            file,
          );
          if (!slot.whole && kind !== "value") kind = undefined;
          return kind;
        };
        const fn = indexer.getFunctionFor(name, file);
        const visible =
          fn?.origin === "cicode" && (!fn.isPrivate || fn.file === file);

        const at = doc.positionAt(t.start);
        if (indexer.resolveVariableInScope(name, file, scopeId, at)) {
          if (!visible && kindOf() === "function") {
            diags.push(
              diag(
                range(),
                `Incompatible types: a callback must be an INT Cicode function without parameters; '${name}' is a variable.`,
                ERROR,
                "E2024",
              ),
            );
          }
          continue;
        }

        if (fn && visible) {
          const d = bareCicodeFunction(fn, name, kindOf(), range());
          if (d) {
            // A function of another project folder may not be compiled
            // with this file; the name would then be a tag. A return type
            // written as a label is indexed as VOID.
            if (
              !certain(fn, file) ||
              (d.code === "E2024" &&
                fn.returnType === "VOID" &&
                hasTypeLabels(indexer))
            ) {
              d.severity = WARNING;
            }
            diags.push(d);
          }
          continue;
        }
        if (fn?.origin === "builtin") {
          const kind = kindOf();
          if (kind === "function") {
            diags.push(
              diag(
                range(),
                `Incompatible types: a callback must be an INT Cicode function without parameters; built-in '${fn.name}' cannot be passed.`,
                ERROR,
                "E2024",
              ),
            );
          } else if (kind === "value" && (fn.minArgs ?? 0) > 0) {
            diags.push(
              diag(
                range(),
                `Incorrect number of arguments: built-in '${fn.name}' needs arguments; call it with parentheses.`,
                ERROR,
                "E2022",
              ),
            );
          }
          continue;
        }
        if (fn && fn.origin !== "cicode") continue;

        if (!cfg.warnUndeclaredVariables) continue;
        if (ignored.some((re) => re.test(name))) continue;
        if (declaredByTypeLabel(t.text)) continue;
        if (
          renamed.some(
            (r) =>
              r.to === t.text &&
              (r.v.scopeType === "module" || r.v.scopeId === scopeId),
          )
        ) {
          continue;
        }
        diags.push(
          diag(
            range(),
            undeclaredMessage(name, file, scopeId, indexer.getVariables(name)),
            WARNING,
            "W1007",
          ),
        );
      }
    }

    return diags;
  },
};

/** The diagnostic for Cicode function `fn` named without parentheses where
 *  an argument of `kind` is expected, or undefined when that is valid. */
function bareCicodeFunction(
  fn: FunctionInfo,
  name: string,
  kind: ReturnType<typeof argumentKind>,
  range: vscode.Range,
): vscode.Diagnostic | undefined {
  switch (kind) {
    case undefined:
      return undefined;
    case "function": {
      const rt = fn.returnType.toUpperCase();
      const params = fn.maxArgs ?? fn.params.length;
      if (rt === "INT" && params === 0) return undefined;
      return diag(
        range,
        `Incompatible types: a callback must be an INT function without parameters; '${name}' ${
          rt !== "INT" ? `returns ${rt}` : "has parameters"
        }.`,
        ERROR,
        "E2024",
      );
    }
    case "vararg":
      return diag(
        range,
        `Incompatible types: '${name}' is a function; call it with parentheses to pass its result: ${name}().`,
        ERROR,
        "E2024",
      );
    default:
      return diag(
        range,
        `Open bracket expected: '${name}' is a function; calling it needs parentheses: ${name}().`,
        ERROR,
        "E2019",
      );
  }
}

/** True when function `fn` is certainly part of `file`'s compile. */
function certain(fn: FunctionInfo, file: string): boolean {
  if (fn.file) return inCompile(file, fn.file);
  return fn.library === undefined || fn.library.toLowerCase() === "include";
}

function undeclaredMessage(
  name: string,
  file: string,
  scopeId: string,
  vars: ReadonlyArray<{ scopeType: string; scopeId: string }>,
): string {
  if (vars.some((v) => v.scopeId === scopeId || v.scopeId === file)) {
    return `'${name}' is used before its declaration, so the compiler reads it as a tag here.`;
  }
  if (vars.some((v) => v.scopeType === "module")) {
    return `'${name}' is a module variable of another file; here the compiler reads it as a tag.`;
  }
  return `Undeclared variable '${name}': the compiler reads it as a tag (W1007 Tag not defined, unless a variable tag has this name).`;
}
