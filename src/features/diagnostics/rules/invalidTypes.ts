import * as vscode from "vscode";
import type { Rule } from "../rule";
import type { CheckContext } from "../context";
import { diag } from "../diag";
import { CICODE_TYPES, RESERVED_WORDS } from "../../../shared/constants";
import type { FunctionRange } from "../../../core/indexer/types";
import { SCOPE_WORDS, tokenAt, tokensOf, typeLabel } from "./statements";

const VALID_TYPES = [...CICODE_TYPES].join(", ");

/**
 * Flags declarations whose type is not one of the six Cicode types (tag data
 * types such as LONG or DIGITAL, BOOLEAN, VOID, no type at all). A label
 * that expands to a type is a valid type. What the compiler does:
 * - parameter: E2015 (Bad raw data type) for a missing or invalid type,
 *   E2011 for an array parameter
 * - module/global variable and function return type: E2031
 * - local variable: compiles, but it is no declaration: the type word and
 *   the name are read as two tag references (W1007 Tag not defined, W1021
 *   Possible missing operand between tags)
 */
export const invalidTypesRule: Rule = {
  id: "invalidTypes",

  check({
    indexer,
    doc,
    text,
    diagnosticsEnabled,
    cfg,
  }: CheckContext): vscode.Diagnostic[] {
    if (!diagnosticsEnabled || !cfg.warnInvalidTypes) return [];

    const diags: vscode.Diagnostic[] = [];
    const file = doc.uri.fsPath;
    const ranges = indexer.getFunctionRanges(file);
    const T = tokensOf(text);
    const valid = (t: string) => CICODE_TYPES.has(t) || !!typeLabel(indexer, t);
    let rangesByScope: Map<string, FunctionRange> | undefined;

    for (const v of indexer.getVariablesInFile(file)) {
      if (!v.type || !v.location) continue;
      const type = v.type.toUpperCase();
      const baseType = type.replace(/\[.*/, "").trim();

      if (v.isParam) {
        // A reserved word as the name (`INT end`) is the invalidDeclarations
        // rule's E2008.
        if (RESERVED_WORDS.has(v.name.toUpperCase())) continue;
        rangesByScope ??= new Map(
          ranges.map((f) => [indexer.localScopeId(file, f.name), f]),
        );
        const f = rangesByScope.get(v.scopeId);
        if (baseType === "UNKNOWN") {
          diags.push(
            diag(
              v.location.range,
              `Bad raw data type: parameter '${v.name}' has no type (valid: ${VALID_TYPES}).`,
              vscode.DiagnosticSeverity.Error,
              "E2015",
            ),
          );
        } else if (!valid(baseType)) {
          // The type word is the token before the name.
          const nameTok = tokenAt(T, doc.offsetAt(v.location.range.start));
          const typeTok = T[nameTok - 1];
          const range =
            f && typeTok && typeTok.start >= f.headerIndex
              ? new vscode.Range(
                  doc.positionAt(typeTok.start),
                  doc.positionAt(typeTok.end),
                )
              : v.location.range;
          diags.push(
            diag(
              range,
              `Bad raw data type: '${baseType}' is not a valid Cicode parameter type (valid: ${VALID_TYPES}).`,
              vscode.DiagnosticSeverity.Error,
              "E2015",
            ),
          );
        } else if (type.includes("[")) {
          diags.push(
            diag(
              v.location.range,
              `Close bracket expected: parameter '${v.name}' cannot be an array; pass the elements instead.`,
              vscode.DiagnosticSeverity.Error,
              "E2011",
            ),
          );
        }
        continue;
      }

      if (baseType === "UNKNOWN" || valid(baseType)) continue;
      if (v.scopeType === "local") {
        diags.push(
          diag(
            v.location.range,
            `'${baseType}' is not a Cicode type (valid: ${VALID_TYPES}), so this declares nothing: the compiler reads '${baseType}' and '${v.name}' as tag references.`,
            vscode.DiagnosticSeverity.Warning,
            "W1021",
          ),
        );
      } else {
        diags.push(
          diag(
            v.location.range,
            `FUNCTION expected: '${baseType}' is not a valid Cicode variable type (valid: ${VALID_TYPES}).`,
            vscode.DiagnosticSeverity.Error,
            "E2031",
          ),
        );
      }
    }

    for (const f of ranges) {
      // The header words in front of FUNCTION are scope keywords and types;
      // the indexer reports "VOID" both for an explicit VOID and for none.
      // A scope keyword out of place is the functionDefs rule's E2031.
      const words = T.slice(tokenAt(T, f.itemStart), tokenAt(T, f.headerIndex));
      const bad = words.find(
        (t) => t.kind === "w" && !SCOPE_WORDS.has(t.text) && !valid(t.text),
      );
      if (!bad) continue;
      const rt = bad.text;
      diags.push(
        diag(
          new vscode.Range(doc.positionAt(bad.start), doc.positionAt(bad.end)),
          rt === "VOID"
            ? "FUNCTION expected: 'VOID' is not a valid Cicode return type; omit the return type instead."
            : `FUNCTION expected: '${rt}' is not a valid Cicode return type (valid: ${VALID_TYPES}).`,
          vscode.DiagnosticSeverity.Error,
          "E2031",
        ),
      );
    }

    return diags;
  },
};
