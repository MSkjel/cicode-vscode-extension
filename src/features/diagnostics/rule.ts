import type * as vscode from "vscode";
import type { CheckContext } from "./context";

export interface Rule {
  readonly id: string;
  check(ctx: CheckContext): vscode.Diagnostic[];
}
