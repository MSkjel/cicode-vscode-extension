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
  /** Label macro expansion (origin "label"). */
  readonly expr?: string;
  readonly returns?: string;
  readonly helpPath?: string;
  readonly helpId?: string;
  readonly paramDocs?: Record<string, string>;
  /** builtin = compiler's built-in table, cicode = .ci source, label = function-like label. */
  readonly origin?: FunctionOrigin;
  /** Compiler FLAGS: 1 = obsolete (E2101), 2-4 = deprecated (W1008-W1010). */
  readonly obsolete?: number;
  /** Exact argument bounds when known; maxArgs -1 = any number. */
  readonly minArgs?: number;
  readonly maxArgs?: number;
  /** PRIVATE .ci function: callable only from its own file (E2031 elsewhere). */
  readonly isPrivate?: boolean;
  /** Compiler argument kinds per parameter: a type, "var <type>" (by reference), FUNCTION, VARIANT or a final VARARG. */
  readonly argTypes?: string[];
  /** AVEVA library project that defines a shipped cicode or label entry, e.g. "Include". */
  readonly library?: string;
}

export type FunctionOrigin = "builtin" | "cicode" | "label";

export interface VariableEntry {
  readonly name: string;
  readonly type: string;
  readonly scopeType: ScopeType;
  readonly scopeId: string;
  readonly location: vscode.Location | null;
  readonly file: string;
  readonly range: vscode.Range | null;
  readonly isParam: boolean;
  readonly doc?: string;
}
