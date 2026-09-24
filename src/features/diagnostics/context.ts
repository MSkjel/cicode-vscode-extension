import * as path from "path";
import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import type { LintConfig } from "../../config";
import type { FunctionInfo } from "../../shared/types";

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

// A project compiles every .ci file of its folder, plus the projects it
// includes. The Include project is always included and compiled first; for
// any other folder the workspace alone doesn't tell whether it is included.

/** True for a file of the Include project. */
export function isIncludeFile(file: string): boolean {
  return path.basename(path.dirname(file)).toLowerCase() === "include";
}

/** True when both files are in one project folder. */
export function inSameFolder(a: string, b: string): boolean {
  return path.dirname(a).toLowerCase() === path.dirname(b).toLowerCase();
}

/** True when a definition in `other` is certainly compiled together with
 *  `file`: same project folder, or the Include project. */
export function inCompile(file: string, other: string): boolean {
  return inSameFolder(file, other) || isIncludeFile(other);
}

/** Like inCompile, also true for the labels.DBF read from the Include
 *  project outside the workspace. */
export function sourceInCompile(
  indexer: Indexer,
  file: string,
  source: string,
): boolean {
  return (
    inCompile(file, source) || indexer.getExternalLabelFiles().includes(source)
  );
}

/** True when a function or label entry is certainly part of `file`'s
 *  compile: a built-in, or defined in the file's project or in Include. */
export function entryInCompile(
  indexer: Indexer,
  file: string,
  fn: FunctionInfo,
): boolean {
  if (fn.file) return sourceInCompile(indexer, file, fn.file);
  return fn.origin === "builtin" || fn.library?.toLowerCase() === "include";
}

/** True when `a` is compiled before `b` of the same folder: files are taken
 *  in order of their upper-case names. */
export function compilesBefore(a: string, b: string): boolean {
  return path.basename(a).toUpperCase() < path.basename(b).toUpperCase();
}

/** Workspace-relative path for messages. */
export function displayPath(file: string): string {
  return vscode.workspace.asRelativePath(file);
}
