import * as path from "path";
import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import type { LabelRecord } from "../../core/indexer/labelsReader";
import type { FunctionInfo, VariableEntry } from "../../shared/types";
import {
  getSymbolAtPosition,
  isNameChar,
  isNameStart,
} from "../../shared/textUtils";

/** Digits right before offset `end` of `line`, back to a non-name char. */
function isNumberBefore(line: string, end: number): boolean {
  let q = end;
  while (q > 0 && isNameChar(line[q - 1])) q--;
  return q < end && line[q] >= "0" && line[q] <= "9";
}

/**
 * The name under the cursor and its range, or null. The field of a
 * `Tag.Field` reference (also `A.B.C`) is part of a tag reference, not a
 * name the extension can resolve, so it gives null; the part after the dot
 * of a real such as `1.e5` is not a field.
 */
export function nameAt(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): { name: string; range: vscode.Range } | null {
  const name = getSymbolAtPosition(doc, pos);
  if (!name || !isNameStart(name[0]) || ![...name].every(isNameChar))
    return null;
  const line = doc.lineAt(pos.line).text;
  let e = pos.character;
  while (e < line.length && isNameChar(line[e])) e++;
  const s = e - name.length;
  if (s < 0 || line.slice(s, e) !== name) return null;
  if (line[s - 1] === "." && !isNumberBefore(line, s - 1)) return null;
  return { name, range: new vscode.Range(pos.line, s, pos.line, e) };
}

/** True when `file` is in `doc`'s project folder or the Include project. */
function nearFile(file: string, doc: vscode.TextDocument): boolean {
  const dir = path.dirname(file).toLowerCase();
  return (
    dir === path.dirname(doc.uri.fsPath).toLowerCase() ||
    path.basename(dir) === "include"
  );
}

export type ResolvedName =
  | { kind: "label"; label: LabelRecord }
  | { kind: "function"; fn: FunctionInfo }
  | { kind: "variable"; v: VariableEntry; hides?: FunctionInfo };

/**
 * What `name` at `pos` means, in the compiler's lookup order: a constant
 * label, a function-like label (labels are substituted before names are
 * looked up), a variable in scope, then the function a call from this file
 * reaches. A variable declared in Cicode hides a function of its name
 * (`F(1)` is then the variable followed by `(1)`); a local or module
 * variable only from its declaration on.
 */
export function resolveNameAt(
  indexer: Indexer,
  doc: vscode.TextDocument,
  pos: vscode.Position,
  name: string,
): ResolvedName | null {
  const label = indexer.getLabel(name);
  if (label) return { kind: "label", label };
  const fn = indexer.getFunctionFor(name, doc.uri.fsPath);
  if (fn?.origin === "label") return { kind: "function", fn };
  const v = indexer.resolveVariableAt(doc, pos, name);
  // Local variable tags from locvar.DBF have no declaration in the code;
  // whether they hide a function is not known, so the function is kept.
  // A GLOBAL and a function of one name can't share a compile (E2021), so
  // a GLOBAL of another project folder doesn't hide this project's function.
  if (
    v &&
    (!fn || v.location) &&
    !(
      fn &&
      v.scopeType === "global" &&
      !nearFile(v.file, doc) &&
      (!fn.file || nearFile(fn.file, doc))
    )
  ) {
    return { kind: "variable", v, hides: fn };
  }
  return fn ? { kind: "function", fn } : null;
}
