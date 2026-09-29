import * as vscode from "vscode";
import { sameDefinition, type Indexer } from "../../core/indexer/indexer";
import type { LabelRecord } from "../../core/indexer/labelsReader";
import {
  findOpenDocument,
  readSourceText,
} from "../../core/indexer/sourceText";
import type { FunctionInfo, VariableEntry } from "../../shared/types";
import {
  buildIgnoreSpans,
  getSymbolAtPosition,
  inSpan,
  isNameChar,
  isNameStart,
} from "../../shared/textUtils";
import { NAME_CHARS } from "../../shared/constants";
import { escapeRegExp } from "../../shared/utils";

/** RegExp source for a name as the compiler compares names: ASCII letters
 *  in either case, any other character as written (see nameKey). */
export function namePattern(name: string): string {
  return [...name]
    .map((c) =>
      /[A-Za-z]/.test(c)
        ? `[${c.toLowerCase()}${c.toUpperCase()}]`
        : escapeRegExp(c),
    )
    .join("");
}

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

/** A GLOBAL `v` hides the function `fn` in `file`: some unit compiling the
 *  file also compiles both (they clash there, E2021, and the variable is
 *  used). Otherwise they meet only in different units, and the one of the
 *  project nearer the file wins (its own first, then unit order). */
function globalHides(
  indexer: Indexer,
  file: string,
  v: VariableEntry,
  fn: FunctionInfo,
): boolean {
  if (!fn.file) return true; // a built-in is in every unit
  const g = indexer.projects;
  const kv = g.projectOf(v.file).key;
  const kf = g.projectOf(fn.file).key;
  if (
    g
      .unitsOf(file)
      .some((u) => u.projects.includes(kv) && u.projects.includes(kf))
  )
    return true;
  const vis = g.visible(file);
  return (vis.get(kv) ?? Infinity) < (vis.get(kf) ?? Infinity);
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
 * variable only from its declaration on. Everything is looked up among the
 * projects compiled with the document.
 */
export function resolveNameAt(
  indexer: Indexer,
  doc: vscode.TextDocument,
  pos: vscode.Position,
  name: string,
): ResolvedName | null {
  const file = doc.uri.fsPath;
  const label = indexer.getLabel(name, file);
  if (label) return { kind: "label", label };
  const fn = indexer.getFunctionFor(name, file);
  if (fn?.origin === "label") return { kind: "function", fn };
  const v = indexer.resolveVariableAt(doc, pos, name);
  // Local variable tags from locvar.DBF have no declaration in the code;
  // whether they hide a function is not known, so the function is kept.
  if (
    v &&
    (!fn || v.location) &&
    (!fn || v.scopeType !== "global" || globalHides(indexer, file, v, fn))
  ) {
    return { kind: "variable", v, hides: fn };
  }
  return fn ? { kind: "function", fn } : null;
}

/** Per file (memoized): a call of `name` there reaches `def` when some
 *  unit compiling the file is compiled (a project included by several roots
 *  may reach another definition under each). The file is compiled with it
 *  and has no PRIVATE function of the name (a PRIVATE function is called
 *  from its own file only). An overlay (a folder inside a project's folder,
 *  never compiled) only borrows its home's names: its calls are no
 *  references of definitions elsewhere. */
export function reaches(
  indexer: Indexer,
  name: string,
  def: FunctionInfo,
): (file: string) => boolean {
  const g = indexer.projects;
  const home = def.file ? g.projectOf(def.file).key : "";
  const memo = new Map<string, boolean>();
  return (file) => {
    let ok = memo.get(file);
    if (ok === undefined) {
      const p = g.projectOf(file);
      ok =
        (!p.overlayOf || p.key === home) &&
        indexer
          .getFunctionsByUnit(name, file)
          .some((u) => sameDefinition(u.fn, def));
      memo.set(file, ok);
    }
    return ok;
  };
}

/**
 * The first file of a project outside the workspace compiled with `defFile`
 * that holds `name` as a whole word (not in a comment or string, not a
 * `Tag.Field` field) at an offset `uses` accepts. Such projects are read
 * from disk, never searched for references: a rename would leave that use
 * under the old name.
 */
export async function outsideUse(
  indexer: Indexer,
  name: string,
  defFile: string,
  uses: (file: string, text: string, offset: number) => boolean,
): Promise<string | undefined> {
  const g = indexer.projects;
  const re = new RegExp(
    `(?<![${NAME_CHARS}.])${namePattern(name)}(?![${NAME_CHARS}])`,
    "g",
  );
  for (const key of g.visible(defFile).keys()) {
    if (g.project(key)?.inWorkspace !== false) continue;
    for (const file of indexer.projectSourceFiles(key)) {
      const uri = vscode.Uri.file(file);
      let text: string;
      try {
        text = findOpenDocument(uri)?.getText() ?? (await readSourceText(uri));
      } catch {
        continue;
      }
      const ignore = buildIgnoreSpans(text, { includeFunctionHeaders: false });
      for (const m of text.matchAll(re)) {
        if (!inSpan(m.index, ignore) && uses(file, text, m.index)) return file;
      }
    }
  }
  return undefined;
}
