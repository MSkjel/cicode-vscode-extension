import * as vscode from "vscode";
import type { Rule } from "../rule";
import type { CheckContext } from "../context";
import { diag } from "../diag";
import { CICODE_TYPES } from "../../../shared/constants";

/**
 * Warns when a variable or function is declared with a type that is not valid
 * in Cicode (e.g. tag data types like LONG, DIGITAL used in declarations).
 */
export const invalidTypesRule: Rule = {
  id: "invalidTypes",

  check({
    indexer,
    doc,
    diagnosticsEnabled,
    cfg,
  }: CheckContext): vscode.Diagnostic[] {
    if (!diagnosticsEnabled || !cfg.warnInvalidTypes) return [];

    const diags: vscode.Diagnostic[] = [];
    const file = doc.uri.fsPath;

    for (const v of indexer.getVariablesInFile(file)) {
      if (!v.type || v.type === "UNKNOWN" || !v.location) continue;
      const baseType = v.type.replace(/\[.*/, "").trim().toUpperCase();
      if (!CICODE_TYPES.has(baseType)) {
        diags.push(
          diag(
            v.location.range,
            `'${baseType}' is not a valid Cicode variable type. Tag data types cannot be used in declarations.`,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      }
    }

    for (const f of indexer.getFunctionRanges(file)) {
      if (!f.returnType || f.returnType === "UNKNOWN") continue;
      const rt = f.returnType.toUpperCase();
      if (rt !== "VOID" && !CICODE_TYPES.has(rt)) {
        diags.push(
          diag(
            f.location.range,
            `'${f.returnType}' is not a valid Cicode return type.`,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      }
    }

    return diags;
  },
};
