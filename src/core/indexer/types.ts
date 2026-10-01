import type * as vscode from "vscode";

export interface FunctionRange {
  name: string;
  /** Upper-case return type; "VOID" when none is written. */
  returnType: string;
  /** Text inside the parentheses, comments blanked; "" without parentheses. */
  paramsRaw: string;
  /** Offset of the FUNCTION keyword. */
  headerIndex: number;
  /** Position of the FUNCTION keyword. */
  headerPos: vscode.Position;
  /** Offset of the first header word (scope, return type or FUNCTION). */
  itemStart: number;
  /** Offset of the function name. */
  nameOffset: number;
  /** False for a parameterless header written without parentheses. */
  hasParens: boolean;
  /** Scope keyword in front of the header (PRIVATE, PUBLIC; GLOBAL and
   *  MODULE are compile errors). */
  scope?: string;
  /** False when the body has no END (it then runs to the next header). */
  closed: boolean;
  location: vscode.Location;
  /** End of the header, where the body starts. */
  startOffset: number;
  /** End of the body (after its END). */
  endOffset: number;
  bodyRange: vscode.Range;
  docText?: string;
  paramDocs?: Record<string, string>;
  returnsDoc?: string;
}
