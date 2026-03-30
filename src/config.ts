import * as vscode from "vscode";

export const cfg = () => vscode.workspace.getConfiguration();

const _regexCache = new Map<string, RegExp[]>();
function compilePatterns(patterns: string[]): RegExp[] {
  const key = JSON.stringify(patterns);
  if (!_regexCache.has(key)) {
    _regexCache.set(
      key,
      patterns.filter(Boolean).map((p) => new RegExp(p, "i")),
    );
  }
  return _regexCache.get(key)!;
}

/**
 * Find workspace files matching a pattern.
 * Always bypasses files.exclude (passes null), then filters against
 * cicode.indexing.excludePatterns so only our own setting controls exclusions.
 */
export async function findWorkspaceFiles(
  include: string,
  cfg: () => vscode.WorkspaceConfiguration,
): Promise<vscode.Uri[]> {
  const all = await vscode.workspace.findFiles(include, null);

  const patterns = cfg().get<string[]>("cicode.indexing.excludePatterns", []);
  if (!patterns.length) return all;

  const regexes = compilePatterns(patterns);
  return all.filter((uri) => {
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
    return !regexes.some((re) => re.test(rel));
  });
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
  warnInvalidTypes: boolean;
  ignoredUndeclaredVariables: RegExp[];
  warnDeclarationsInBlocks: boolean;
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
    warnInvalidTypes: c.get("cicode.diagnostics.warnInvalidTypes", true),
    ignoredUndeclaredVariables: compilePatterns(
      c.get("cicode.diagnostics.ignoredUndeclaredVariables", []) as string[],
    ),
    warnDeclarationsInBlocks: c.get(
      "cicode.diagnostics.warnDeclarationsInBlocks",
      true,
    ),
    maxCallNestingDepth: c.get("cicode.lint.maxCallNestingDepth", 5),
    maxBlockNestingDepth: c.get("cicode.lint.maxBlockNestingDepth", 4),
    ignoredFunctions: compilePatterns(
      c.get("cicode.diagnostics.ignoredFunctions", []) as string[],
    ),
  };
}
