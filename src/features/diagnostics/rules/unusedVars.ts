import * as vscode from "vscode";
import type { Rule } from "../rule";
import type { CheckContext } from "../context";
import { hint } from "../diag";
import { inSpan } from "../../../shared/textUtils";
import { getFunctionBodyText } from "../../../shared/parseHelpers";
import { WORD_RE } from "../../../shared/constants";

/**
 * Warns on unused local variables and unused function parameters.
 * Controlled by cfg.warnUnusedVariables.
 */
export const unusedVarsRule: Rule = {
  id: "unusedVars",

  check({
    text,
    ignoreNoHeaders,
    indexer,
    doc,
    cfg,
  }: CheckContext): vscode.Diagnostic[] {
    if (!cfg.warnUnusedVariables) return [];

    const diags: vscode.Diagnostic[] = [];

    for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
      const { body, bodyStartAbs } = getFunctionBodyText(f, text, doc);

      const scopeId = indexer.localScopeId(doc.uri.fsPath, f.name);
      const localVars = indexer.getVariablesByPredicate(
        (v) => v.scopeType === "local" && v.scopeId === scopeId,
      );
      if (!localVars.length) continue;

      const varNames = new Map<string, typeof localVars>();
      for (const v of localVars) {
        const key = v.name.toLowerCase();
        let arr = varNames.get(key);
        if (!arr) {
          arr = [];
          varNames.set(key, arr);
        }
        arr.push(v);
      }

      const counts = new Map<string, number>();
      WORD_RE.lastIndex = 0;
      const wordRe = WORD_RE;
      let m: RegExpExecArray | null;

      while ((m = wordRe.exec(body))) {
        const key = m[0].toLowerCase();
        if (!varNames.has(key)) continue;
        const pos = bodyStartAbs + m.index;
        if (inSpan(pos, ignoreNoHeaders)) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
      }

      // Parameters have 0 occurrences when unused
      // Local vars have 1 occurrence when unused
      for (const [key, vars] of varNames) {
        const count = counts.get(key) || 0;
        for (const v of vars) {
          const threshold = v.isParam ? 0 : 1;
          if (count <= threshold && v.location) {
            diags.push(
              hint(
                v.location.range,
                v.isParam
                  ? `Parameter '${v.name}' is never used.`
                  : `Variable '${v.name}' is declared but never used.`,
              ),
            );
          }
        }
      }
    }

    return diags;
  },
};
