import * as vscode from "vscode";

export function diag(
  range: vscode.Range,
  message: string,
  severity: vscode.DiagnosticSeverity,
  code?: string,
): vscode.Diagnostic {
  const d = new vscode.Diagnostic(range, message, severity);
  d.source = "cicode";
  if (code) d.code = code;
  return d;
}

export function hint(range: vscode.Range, message: string): vscode.Diagnostic {
  return diag(range, message, vscode.DiagnosticSeverity.Hint);
}

export function info(range: vscode.Range, message: string): vscode.Diagnostic {
  return diag(range, message, vscode.DiagnosticSeverity.Information);
}
