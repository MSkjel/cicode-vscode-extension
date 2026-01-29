import * as vscode from "vscode";

// ============================================================================
// Diagnostic Severity Shortcuts
// ============================================================================

export type DiagnosticLevel = "error" | "warning" | "info" | "hint";

const severityMap: Record<DiagnosticLevel, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

// ============================================================================
// Diagnostic Factory
// ============================================================================

export interface DiagnosticOptions {
  code?: string;
  source?: string;
}

/** Create a diagnostic at the given range */
export function createDiagnostic(
  range: vscode.Range,
  message: string,
  level: DiagnosticLevel,
  options: DiagnosticOptions = {},
): vscode.Diagnostic {
  const diag = new vscode.Diagnostic(range, message, severityMap[level]);
  if (options.code) diag.code = options.code;
  diag.source = options.source || "cicode";
  return diag;
}

/** Create a diagnostic at a position with given length */
export function createDiagnosticAt(
  doc: vscode.TextDocument,
  offset: number,
  length: number,
  message: string,
  level: DiagnosticLevel,
  options: DiagnosticOptions = {},
): vscode.Diagnostic {
  const start = doc.positionAt(offset);
  const end = doc.positionAt(offset + length);
  return createDiagnostic(
    new vscode.Range(start, end),
    message,
    level,
    options,
  );
}

/** Create a diagnostic for a specific line */
export function createLineDiagnostic(
  doc: vscode.TextDocument,
  line: number,
  startCol: number,
  length: number,
  message: string,
  level: DiagnosticLevel,
  options: DiagnosticOptions = {},
): vscode.Diagnostic {
  const start = new vscode.Position(line, startCol);
  const end = new vscode.Position(line, startCol + length);
  return createDiagnostic(
    new vscode.Range(start, end),
    message,
    level,
    options,
  );
}

// ============================================================================
// Diagnostic Collector
// ============================================================================

/** Helper class to collect diagnostics with a fluent interface */
export class DiagnosticCollector {
  private diagnostics: vscode.Diagnostic[] = [];
  private doc: vscode.TextDocument;

  constructor(doc: vscode.TextDocument) {
    this.doc = doc;
  }

  /** Add error diagnostic */
  error(
    range: vscode.Range,
    message: string,
    options?: DiagnosticOptions,
  ): this {
    this.diagnostics.push(createDiagnostic(range, message, "error", options));
    return this;
  }

  /** Add warning diagnostic */
  warning(
    range: vscode.Range,
    message: string,
    options?: DiagnosticOptions,
  ): this {
    this.diagnostics.push(createDiagnostic(range, message, "warning", options));
    return this;
  }

  /** Add info diagnostic */
  info(
    range: vscode.Range,
    message: string,
    options?: DiagnosticOptions,
  ): this {
    this.diagnostics.push(createDiagnostic(range, message, "info", options));
    return this;
  }

  /** Add hint diagnostic */
  hint(
    range: vscode.Range,
    message: string,
    options?: DiagnosticOptions,
  ): this {
    this.diagnostics.push(createDiagnostic(range, message, "hint", options));
    return this;
  }

  /** Add error at offset */
  errorAt(
    offset: number,
    length: number,
    message: string,
    options?: DiagnosticOptions,
  ): this {
    this.diagnostics.push(
      createDiagnosticAt(this.doc, offset, length, message, "error", options),
    );
    return this;
  }

  /** Add warning at offset */
  warningAt(
    offset: number,
    length: number,
    message: string,
    options?: DiagnosticOptions,
  ): this {
    this.diagnostics.push(
      createDiagnosticAt(this.doc, offset, length, message, "warning", options),
    );
    return this;
  }

  /** Add raw diagnostic */
  add(diag: vscode.Diagnostic): this {
    this.diagnostics.push(diag);
    return this;
  }

  /** Get all collected diagnostics */
  getAll(): vscode.Diagnostic[] {
    return this.diagnostics;
  }

  /** Get count of collected diagnostics */
  get count(): number {
    return this.diagnostics.length;
  }
}

// ============================================================================
// Config Helper
// ============================================================================

export interface LintConfig {
  enabled: boolean;
  maxLineLength: number;
  warnMixedIndent: boolean;
  warnMissingSemicolons: boolean;
  warnKeywordCase: boolean;
  warnMagicNumbers: boolean;
  warnUnusedVariables: boolean;
  ignoredFunctions: string[];
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
    ignoredFunctions: (
      c.get("cicode.diagnostics.ignoredFunctions", []) as string[]
    ).map((f) => f.toLowerCase()),
  };
}
