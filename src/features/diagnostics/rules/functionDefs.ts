import * as vscode from "vscode";
import type { Rule } from "../rule";
import type { CheckContext } from "../context";
import { diag } from "../diag";
import { getOptionalParamFlags } from "../../../shared/utils";
import { splitParamsTopLevel } from "../../../shared/parseHelpers";

/**
 * Checks function definitions for:
 * - E2021: duplicate function in the same file
 * - W1006: function shadows a builtin
 * - W1003: optional parameter declared before a required one
 */
export const functionDefsRule: Rule = {
  id: "functionDefs",

  check({
    indexer,
    doc,
    diagnosticsEnabled,
  }: CheckContext): vscode.Diagnostic[] {
    if (!diagnosticsEnabled) return [];

    const diags: vscode.Diagnostic[] = [];
    const seen = new Set<string>();

    for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
      const key = f.name.toLowerCase();

      if (seen.has(key)) {
        diags.push(
          diag(
            f.location.range,
            `Function '${f.name}' is already defined in this file`,
            vscode.DiagnosticSeverity.Error,
            "E2021",
          ),
        );
      } else {
        seen.add(key);
      }

      const builtin = indexer.getAllFunctions().get(key);
      if (builtin?.helpPath) {
        diags.push(
          diag(
            f.location.range,
            `Function '${f.name}' has the same name as a built-in function.`,
            vscode.DiagnosticSeverity.Warning,
            "W1006",
          ),
        );
      }

      const header = indexer.getFunction(f.name);
      const params = header?.params?.length
        ? header.params
        : splitParamsTopLevel(f.paramsRaw || "").filter(Boolean);

      if (params.length) {
        const optFlags = getOptionalParamFlags(params);
        let foundOptional = false;

        for (const isOpt of optFlags) {
          if (isOpt) {
            foundOptional = true;
          } else if (foundOptional) {
            diags.push(
              diag(
                f.location.range,
                "Argument with default/optional found before a required argument.",
                vscode.DiagnosticSeverity.Warning,
                "W1003",
              ),
            );
            break;
          }
        }
      }
    }

    return diags;
  },
};
