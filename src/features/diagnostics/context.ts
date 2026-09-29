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

// A project compiles every .ci file of its folder, plus the projects its
// include.DBF names (recursively) and Include. Compiling a root project
// gives one unit; a project included by several roots is in several units,
// and sees every name of each (indexer.projects).

/** True for a file of the Include project. */
export function isIncludeFile(indexer: Indexer, file: string): boolean {
  return indexer.projects.isInclude(file);
}

/** True when both files are in one project folder. */
export function inSameFolder(a: string, b: string): boolean {
  return path.dirname(a).toLowerCase() === path.dirname(b).toLowerCase();
}

/** True when a definition in `other` is compiled together with `file`:
 *  their projects share a compile unit. */
export function inCompile(
  indexer: Indexer,
  file: string,
  other: string,
): boolean {
  return indexer.projects.sameUnit(file, other);
}

/** True when a definition in `def` can be seen from `file` (lookups: the
 *  same relation as inCompile). */
export function visibleFrom(
  indexer: Indexer,
  file: string,
  def: string,
): boolean {
  return indexer.projects.isVisible(file, def);
}

/** inCompile for a labels.DBF or locvar.DBF source (also outside the
 *  workspace). */
export function sourceInCompile(
  indexer: Indexer,
  file: string,
  source: string,
): boolean {
  return inCompile(indexer, file, source);
}

/** True when a function or label entry is part of `file`'s compile: a
 *  built-in, a shipped library entry of a project in a unit of the file
 *  (Include always is), or defined in a project sharing a unit. */
export function entryInCompile(
  indexer: Indexer,
  file: string,
  fn: FunctionInfo,
): boolean {
  if (fn.file) return inCompile(indexer, file, fn.file);
  if (fn.library) return indexer.projects.hasLibrary(file, fn.library);
  return fn.origin === "builtin";
}

/** True when `a` is compiled before `b` of the same folder: files are taken
 *  in order of their upper-case names. */
export function compilesBefore(a: string, b: string): boolean {
  return path.basename(a).toUpperCase() < path.basename(b).toUpperCase();
}

/** Per compile unit holding both files: the root it compiles and whether
 *  `a` is compiled before `b` there (Include first, then the includes
 *  depth-first in row order, the root last; files by name inside a
 *  project). Empty when they share no unit; `before` is false for the same
 *  file. */
export function compileOrder(
  indexer: Indexer,
  a: string,
  b: string,
): Array<{ root: string; before: boolean }> {
  return indexer.projects
    .compareInUnit(a, b)
    .map((o) => ({ root: o.unit.root, before: o.order < 0 }));
}

/** Every unit of the file resolved all its include rows, so a name missing
 *  from them is certainly unknown to the compiler. */
export function unitComplete(indexer: Indexer, file: string): boolean {
  return indexer.projects.unitComplete(file);
}

/** Project name of a file for messages (MASTER.DBF name or folder name). */
export function projectName(indexer: Indexer, file: string): string {
  return indexer.projects.projectName(file);
}

/** Workspace-relative path for messages. */
export function displayPath(file: string): string {
  return vscode.workspace.asRelativePath(file);
}
