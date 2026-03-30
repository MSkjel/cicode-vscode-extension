import * as vscode from "vscode";
import type { Rule } from "../rule";
import type { CheckContext } from "../context";
import { diag } from "../diag";
import { inSpan, stripLineComment } from "../../../shared/textUtils";
import { CONTROL_KEYWORDS } from "../../../shared/constants";
import { getFunctionBodyText } from "../../../shared/parseHelpers";

/**
 * Validates return statements:
 * - E2036: void function returning a value
 * - E2037: non-void function with no return value
 */
export const returnTypeRule: Rule = {
  id: "returnType",

  check({
    text,
    ignoreNoHeaders,
    indexer,
    doc,
    diagnosticsEnabled,
  }: CheckContext): vscode.Diagnostic[] {
    if (!diagnosticsEnabled) return [];

    const diags: vscode.Diagnostic[] = [];

    for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
      const cachedFunc = indexer.getFunction(f.name);
      const returnType = (
        f.returnType ||
        cachedFunc?.returnType ||
        "VOID"
      ).toUpperCase();

      const { body, bodyStartAbs } = getFunctionBodyText(f, text, doc);

      let hasReturnWithValue = false;
      const retRe = /\bRETURN\b/gi;
      let m: RegExpExecArray | null;

      while ((m = retRe.exec(body))) {
        const retAbs = bodyStartAbs + m.index;
        if (inSpan(retAbs, ignoreNoHeaders)) continue;

        const lineEnd = body.indexOf("\n", m.index);
        const end = lineEnd === -1 ? body.length : lineEnd;
        const after = stripLineComment(body.slice(m.index, end))
          .replace(/\bRETURN\b/i, "")
          .replace(/;/g, "")
          .trim();

        const hasValue =
          after.length > 0 &&
          !CONTROL_KEYWORDS.has(after.split(/\s+/)[0].toUpperCase());

        if (hasValue) {
          hasReturnWithValue = true;

          if (returnType === "VOID") {
            const pos = doc.positionAt(retAbs);
            diags.push(
              diag(
                new vscode.Range(pos, pos.translate(0, 6)),
                "Cannot return value from void function.",
                vscode.DiagnosticSeverity.Error,
                "E2036",
              ),
            );
          }
        }
      }

      if (returnType !== "VOID" && !hasReturnWithValue) {
        diags.push(
          diag(
            f.location.range,
            `Function '${f.name}' must return a value.`,
            vscode.DiagnosticSeverity.Error,
            "E2037",
          ),
        );
      }
    }

    return diags;
  },
};
