import type * as vscode from "vscode";

export type ScopeType = "local" | "module" | "global";

export interface FunctionInfo {
  readonly name: string;
  readonly returnType: string;
  readonly params: string[];
  readonly file: string | null;
  readonly location: vscode.Location | null;
  readonly bodyRange: vscode.Range | null;
  readonly doc?: string;
  readonly returns?: string;
  readonly helpPath?: string;
  readonly paramDocs?: Record<string, string>;
}

export interface VariableEntry {
  readonly name: string;
  readonly type: string;
  readonly scopeType: ScopeType;
  readonly scopeId: string;
  readonly location: vscode.Location;
  readonly file: string;
  readonly range: vscode.Range | null;
  readonly isParam: boolean;
}
