import * as vscode from "vscode";
import type { Rule } from "../rule";
import type { CheckContext } from "../context";
import { hint } from "../diag";
import { CICODE_TYPES } from "../../../shared/constants";
import { upperAscii } from "../../../shared/textUtils";
import type { VariableEntry } from "../../../shared/types";
import { functionBody, isIdentifier, isToken, labelOf } from "./statements";

/**
 * Hints at local variables and parameters a function never uses (the
 * compiler says nothing about them). A use before a local's declaration is
 * a tag reference, not the local. Controlled by cfg.warnUnusedVariables.
 */
export const unusedVarsRule: Rule = {
  id: "unusedVars",

  check({ text, indexer, doc, cfg }: CheckContext): vscode.Diagnostic[] {
    if (!cfg.warnUnusedVariables) return [];

    const diags: vscode.Diagnostic[] = [];
    const file = doc.uri.fsPath;

    // Group this file's locals by scopeId once, instead of scanning the
    // whole workspace variable cache per function.
    const localsByScope = new Map<string, VariableEntry[]>();
    for (const v of indexer.getVariablesInFile(file)) {
      if (v.scopeType !== "local" || !v.location) continue;
      // Not a declaration (invalid type) or not this name (a label); other
      // rules report those.
      if (!CICODE_TYPES.has(v.type.replace(/\[.*/, "").trim().toUpperCase())) {
        continue;
      }
      if (labelOf(indexer, v.name)) continue;
      let arr = localsByScope.get(v.scopeId);
      if (!arr) localsByScope.set(v.scopeId, (arr = []));
      arr.push(v);
    }

    for (const f of indexer.getFunctionRanges(file)) {
      const locals = localsByScope.get(indexer.localScopeId(file, f.name));
      if (!locals?.length) continue;

      // Offsets of each name's occurrences in the body (not `Tag.Field`).
      const { tokens: T, start, end } = functionBody(text, f);
      const uses = new Map<string, number[]>();
      for (const v of locals) uses.set(upperAscii(v.name), []);
      for (let k = start; k < end; k++) {
        const t = T[k];
        const at = uses.get(t.text);
        if (!at || !isIdentifier(t) || isToken(T[k - 1], ".")) continue;
        at.push(t.start);
      }

      for (const v of locals) {
        const from = doc.offsetAt(v.location!.range.start);
        const count = uses
          .get(upperAscii(v.name))!
          .filter((o) => v.isParam || o >= from).length;
        // The declaration itself is one occurrence of a local.
        if (count > (v.isParam ? 0 : 1)) continue;
        const d = hint(
          v.location!.range,
          v.isParam
            ? `Parameter '${v.name}' is never used.`
            : `Variable '${v.name}' is declared but never used.`,
        );
        d.tags = [vscode.DiagnosticTag.Unnecessary];
        diags.push(d);
      }
    }

    return diags;
  },
};
