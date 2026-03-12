import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import type { LintConfig } from "../../config";

/**
 * All inputs a diagnostic rule needs to run.
 * Built once per document and passed to every rule.
 */
export interface CheckContext {
  doc: vscode.TextDocument;
  text: string;
  /** Ignore spans including function headers */
  ignore: Array<[number, number]>;
  /** Ignore spans excluding function headers */
  ignoreNoHeaders: Array<[number, number]>;
  indexer: Indexer;
  cfg: LintConfig;
  /** Regex patterns for function names to skip in call checks */
  ignoredFuncs: RegExp[];
  /** Value of cicode.diagnostics.enable */
  diagnosticsEnabled: boolean;
}
