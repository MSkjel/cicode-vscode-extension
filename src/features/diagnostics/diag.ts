import * as path from "path";
import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import { displayPath, projectName } from "./context";

/** Diagnostic from source "cicode"; `code` is the compiler's code when it has one (E2022, W1004, ...). */
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

/** A file for messages: its workspace path, or `Project/file.ci` for a
 *  project read from outside the workspace. */
export function fileLabel(indexer: Indexer, file: string): string {
  return indexer.isExternal(file)
    ? `${projectName(indexer, file)}/${path.basename(file)}`
    : displayPath(file);
}
