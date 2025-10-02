import type * as vscode from "vscode";

export interface FunctionRange {
  name: string;
  returnType: string;
  paramsRaw: string;
  headerIndex: number;
  headerPos: vscode.Position;
  location: vscode.Location;
  startOffset: number;
  endOffset: number;
  bodyRange: vscode.Range;
}
