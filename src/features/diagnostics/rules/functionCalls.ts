import * as vscode from "vscode";
import type { Rule } from "../rule";
import type { CheckContext } from "../context";
import { diag } from "../diag";
import { inSpan } from "../../../shared/textUtils";
import {
  countArgsTopLevel,
  findMatchingParen,
} from "../../../shared/parseHelpers";
import { KEYWORDS_WITH_PAREN } from "../../../shared/constants";
import { computeParamBounds } from "../../../shared/utils";

/**
 * Warns on calls to unknown functions and on argument count mismatches.
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
    const re = /\b([A-Za-z_]\w*)\s*\(/g;
    let m: RegExpExecArray | null;

    while ((m = re.exec(text))) {
      const name = m[1];
      if (
        KEYWORDS_WITH_PAREN.has(name.toUpperCase()) ||
        ignoredFuncs.some((re) => re.test(name))
      ) {
        continue;
      }

      const openAbs = m.index + m[0].lastIndexOf("(");
      if (inSpan(openAbs, ignore)) continue;

      const entry = indexer.getFunction(name);
      if (!entry) {
        diags.push(
          diag(
            new vscode.Range(
              doc.positionAt(m.index),
              doc.positionAt(m.index + name.length),
            ),
            `Unknown function '${name}'`,
            vscode.DiagnosticSeverity.Warning,
            "cicode.undefinedFunction",
          ),
        );
        continue;
      }

      const closeAbs = findMatchingParen(text, openAbs, ignore);
      if (closeAbs === -1) continue;

      const provided = countArgsTopLevel(text, openAbs + 1, closeAbs, ignore);
      const { min: minArgs, max: maxArgs } = computeParamBounds(
        entry.params || [],
      );

      if (provided < minArgs || provided > maxArgs) {
        diags.push(
          diag(
            new vscode.Range(
              doc.positionAt(m.index),
              doc.positionAt(closeAbs + 1),
            ),
            `Incorrect number of arguments for '${entry.name}'. Expected ${minArgs}-${maxArgs}, got ${provided}.`,
            vscode.DiagnosticSeverity.Warning,
            "W1004",
          ),
        );
      }
    }

    return diags;
  },
};
