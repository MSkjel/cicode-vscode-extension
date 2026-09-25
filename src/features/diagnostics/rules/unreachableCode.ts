import * as vscode from "vscode";
import type { Rule } from "../rule";
import type { CheckContext } from "../context";
import { hint } from "../diag";
import { functionBody, usesStructuralLabel, type Stmt } from "./statements";

/**
 * Hints at statements that follow a RETURN in the same statement list and
 * can never run. The compiler says nothing about them. In a function
 * without a return type RETURN takes no value, so `RETURN Foo();` returns
 * at once and never calls Foo; in a typed function RETURN takes the
 * expression after it, also from the next line.
 */
export const unreachableCodeRule: Rule = {
  id: "unreachableCode",

  check({
    text,
    indexer,
    doc,
    diagnosticsEnabled,
  }: CheckContext): vscode.Diagnostic[] {
    if (!diagnosticsEnabled) return [];

    const diags: vscode.Diagnostic[] = [];

    for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
      const { tokens: T, stmts, start, end } = functionBody(text, f);
      if (usesStructuralLabel(indexer, text, T, start, end)) continue;
      const typed = f.returnType !== "VOID";

      const visit = (list: readonly Stmt[]) => {
        let ret: Stmt | undefined;
        for (const s of list) {
          // A token no statement starts with is an error of its own (e.g.
          // the `?abc?` of `RETURN ?abc?;`); what follows it is not judged.
          if (ret && s.kind === "stray") break;
          if (ret && s.kind !== "empty" && !isPlainDeclaration(s)) {
            const last = list[list.length - 1];
            const sameLine =
              doc.positionAt(T[ret.start].start).line ===
              doc.positionAt(T[s.start].start).line;
            const d = hint(
              new vscode.Range(
                doc.positionAt(T[s.start].start),
                doc.positionAt(T[last.end - 1].end),
              ),
              !typed && ret.end === s.start && sameLine
                ? "Unreachable code: RETURN in a function without a return type takes no value, so this never runs."
                : "Unreachable code after RETURN.",
            );
            d.tags = [vscode.DiagnosticTag.Unnecessary];
            diags.push(d);
            break;
          }
          if (s.kind === "return") ret = s;
        }
        for (const s of list) for (const b of s.blocks) visit(b);
      };
      visit(stmts);
    }

    return diags;
  },
};

/** A declaration without initializers, which runs no code. */
function isPlainDeclaration(s: Stmt): boolean {
  return s.kind === "decl" && s.names!.every((n) => n.init < 0);
}
