import * as vscode from "vscode";
import type { Rule } from "../rule";
import type { CheckContext } from "../context";
import { diag } from "../diag";
import { inSpan } from "../../../shared/textUtils";
import { getFunctionBodyText } from "../../../shared/parseHelpers";
import {
  KEYWORDS_WITH_PAREN,
  CICODE_TYPES,
  BLOCK_START_KEYWORDS,
  STRUCTURAL_KEYWORDS,
  STATEMENT_BOUNDARY_KEYWORDS,
  MISC_KEYWORDS,
  TOKEN_RE,
} from "../../../shared/constants";

const SKIP_IDENTIFIERS = new Set([
  ...KEYWORDS_WITH_PAREN,
  ...CICODE_TYPES,
  ...BLOCK_START_KEYWORDS,
  ...STRUCTURAL_KEYWORDS,
  ...STATEMENT_BOUNDARY_KEYWORDS,
  ...MISC_KEYWORDS,
]);

export const undeclaredVarsRule: Rule = {
  id: "undeclaredVars",

  check({
    text,
    ignoreNoHeaders,
    indexer,
    doc,
    diagnosticsEnabled,
    cfg,
  }: CheckContext): vscode.Diagnostic[] {
    if (!diagnosticsEnabled) return [];
    if (!cfg.warnUndeclaredVariables) return [];

    const diags: vscode.Diagnostic[] = [];
    const ignored = cfg.ignoredUndeclaredVariables;
    const file = doc.uri.fsPath;

    for (const f of indexer.getFunctionRanges(file)) {
      const { body, bodyStartAbs } = getFunctionBodyText(f, text, doc);

      TOKEN_RE.lastIndex = 0;
      const tokenRe = TOKEN_RE;
      let m: RegExpExecArray | null;

      while ((m = tokenRe.exec(body))) {
        const absPos = bodyStartAbs + m.index;
        if (inSpan(absPos, ignoreNoHeaders)) continue;

        const name = m[1];
        if (SKIP_IDENTIFIERS.has(name.toUpperCase())) continue;
        if (ignored.some((re) => re.test(name))) continue;

        // Skip function calls — functionCallsRule handles those
        const afterTrimmed = body.slice(m.index + name.length).trimStart();
        if (afterTrimmed[0] === "(") continue;

        // Skip field access (e.g. obj.Field)
        if (m.index > 0 && body[m.index - 1] === ".") continue;

        // Skip known function names (e.g. used as callbacks or references)
        if (indexer.getFunction(name)) continue;

        // Skip known label constants from labels.DBF
        if (indexer.isKnownLabel(name)) continue;

        const resolved = indexer.resolveVariableAt(
          doc,
          doc.positionAt(absPos),
          name,
        );
        if (!resolved) {
          const pos = doc.positionAt(absPos);
          diags.push(
            diag(
              new vscode.Range(pos, pos.translate(0, name.length)),
              `Undeclared variable '${name}'.`,
              vscode.DiagnosticSeverity.Warning,
            ),
          );
        }
      }
    }

    return diags;
  },
};
