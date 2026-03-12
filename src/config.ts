import * as vscode from "vscode";

export const cfg = () => vscode.workspace.getConfiguration();

/** Returns the exclude glob for findFiles, or null if none configured (bypasses files.exclude). */
export function getExcludeGlob(
  cfg: () => vscode.WorkspaceConfiguration,
): string | null {
  const ex = cfg().get("cicode.indexing.excludeGlobs");
  if (Array.isArray(ex) && ex.length) return `{${ex.join(",")}}`;
  if (typeof ex === "string" && (ex as string).trim())
    return (ex as string).trim();
  return null;
}

export interface LintConfig {
  enabled: boolean;
  maxLineLength: number;
  warnMixedIndent: boolean;
  warnMissingSemicolons: boolean;
  warnKeywordCase: boolean;
  warnMagicNumbers: boolean;
  warnUnusedVariables: boolean;
  warnUndeclaredVariables: boolean;
  ignoredUndeclaredVariables: RegExp[];
  maxCallNestingDepth: number;
  maxBlockNestingDepth: number;
  ignoredFunctions: RegExp[];
}

/** Get all lint config values at once */
export function getLintConfig(
  cfg: () => vscode.WorkspaceConfiguration,
): LintConfig {
  const c = cfg();
  return {
    enabled: c.get("cicode.lint.enable", true),
    maxLineLength: c.get("cicode.lint.maxLineLength", 140) || 0,
    warnMixedIndent: c.get("cicode.lint.warnMixedIndent", true),
    warnMissingSemicolons: c.get("cicode.lint.warnMissingSemicolons", true),
    warnKeywordCase: c.get("cicode.lint.warnKeywordCase", true),
    warnMagicNumbers: c.get("cicode.lint.warnMagicNumbers", false),
    warnUnusedVariables: c.get("cicode.lint.warnUnusedVariables", true),
    warnUndeclaredVariables: c.get(
      "cicode.diagnostics.warnUndeclaredVariables",
      true,
    ),
    ignoredUndeclaredVariables: (
      c.get("cicode.diagnostics.ignoredUndeclaredVariables", []) as string[]
    ).map((v) => new RegExp(v, "i")),
    maxCallNestingDepth: c.get("cicode.lint.maxCallNestingDepth", 5),
    maxBlockNestingDepth: c.get("cicode.lint.maxBlockNestingDepth", 4),
    ignoredFunctions: (
      c.get("cicode.diagnostics.ignoredFunctions", []) as string[]
    ).map((f) => new RegExp(f, "i")),
  };
}
