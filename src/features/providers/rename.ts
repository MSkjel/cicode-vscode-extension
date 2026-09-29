import * as path from "path";
import * as vscode from "vscode";
import { sameDefinition, type Indexer } from "../../core/indexer/indexer";
import type { ReferenceCache } from "../../core/referenceCache";
import type { FunctionInfo, VariableEntry } from "../../shared/types";
import {
  buildLineIndex,
  isNameChar,
  isNameStart,
  lineAtOffset,
} from "../../shared/textUtils";
import { RESERVED_WORDS } from "../../shared/constants";
import { nameAt, outsideUse, reaches, resolveNameAt } from "./nameAt";

/** Longest function name the compiler accepts (E2109). */
const MAX_FUNCTION_NAME = 250;

/** Why `newName` cannot replace a name, or null when it can. */
function invalidNewName(newName: string, isFunction: boolean): string | null {
  if (!isNameStart(newName[0]) || ![...newName].every((c) => isNameChar(c))) {
    return `"${newName}" is not a Cicode name.`;
  }
  if (RESERVED_WORDS.has(newName.toUpperCase())) {
    return `"${newName}" is a reserved word.`;
  }
  if (isFunction && newName.length > MAX_FUNCTION_NAME) {
    return `Function names are limited to ${MAX_FUNCTION_NAME} characters.`;
  }
  return null;
}

export function makeRename(
  indexer: Indexer,
  refCache: ReferenceCache,
): vscode.RenameProvider {
  /** A file of a workspace project (an untitled document counts). Other
   *  projects (external, or of a file opened from outside the workspace)
   *  are read from disk and never searched for references. */
  const inWorkspace = (file: string) =>
    !path.isAbsolute(file) || indexer.projects.projectOf(file).inWorkspace;
  /** Why a definition in `file` cannot be renamed from `doc`, or null.
   *  Functions and GLOBAL variables are renamed across the workspace only;
   *  a local or module variable stays in its file. */
  const notHere = (
    word: string,
    file: string | null,
    doc: vscode.TextDocument,
    local: boolean,
  ) =>
    file && (local ? indexer.isExternal(file) : !inWorkspace(file))
      ? `${word} is defined in project ${indexer.projects.projectName(file)}, outside the workspace.`
      : !local && !inWorkspace(doc.uri.fsPath)
        ? `${path.basename(doc.uri.fsPath)} belongs to project ${indexer.projects.projectName(doc.uri.fsPath)}, outside the workspace: its uses of ${word} are not renamed.`
        : null;
  const local = (v: VariableEntry) => v.scopeType !== "global";
  /** A GLOBAL `v` used at `offset` of `file`. */
  const usesVariable =
    (word: string, v: VariableEntry) =>
    (file: string, text: string, offset: number) => {
      const li = buildLineIndex(text);
      const line = lineAtOffset(li, offset);
      const at = new vscode.Position(line, offset - li.starts[line]);
      const encl = indexer
        .getFunctionRanges(file)
        .find((f) => offset >= f.startOffset && offset < f.endOffset);
      const r = indexer.resolveVariableInScope(
        word,
        file,
        encl ? indexer.localScopeId(file, encl.name) : null,
        at,
      );
      return r?.scopeType === "global" && r.file === v.file;
    };

  return {
    prepareRename(doc, pos) {
      // null on a field of a tag reference (`Tag.Field`) and off names
      const at = nameAt(doc, pos);
      if (!at) return null;
      const word = at.name;

      if (RESERVED_WORDS.has(word.toUpperCase()))
        throw new Error("A keyword cannot be renamed.");
      if (indexer.isKnownLabel(word, doc.uri.fsPath))
        throw new Error(`${word} is a label from labels.DBF.`);
      const r = resolveNameAt(indexer, doc, pos, word);
      if (r?.kind === "variable") {
        if (!r.v.location)
          throw new Error(
            `${word} is a local variable tag from locvar.DBF, not declared in the code.`,
          );
        return at.range;
      }
      const f = r?.kind === "function" ? r.fn : undefined;
      if (f && (f.origin === "builtin" || (!f.origin && f.file === null)))
        throw new Error(`${word} is a built-in function.`);
      if (f && !f.location)
        throw new Error(`${word} is not defined in the workspace.`);
      // Anything else is a tag (or a name the compiler rejects): renaming
      // every word of that spelling would break the tag's references.
      if (!f)
        throw new Error(`${word} is not a function or variable declared here.`);

      return at.range;
    },
    async provideRenameEdits(doc, pos, newName) {
      const word = nameAt(doc, pos)?.name;
      if (!word) return null;
      const r = resolveNameAt(indexer, doc, pos, word);
      const entry = r?.kind === "function" ? r.fn : undefined;
      const variable = r?.kind === "variable" ? r.v : undefined;
      const defFile = entry ? entry.file : (variable?.file ?? null);
      const problem =
        invalidNewName(newName, entry !== undefined) ??
        notHere(word, defFile, doc, !!variable && local(variable));
      if (problem) throw new Error(problem);
      // Projects outside the workspace that use it keep the old name.
      const outside =
        defFile && path.isAbsolute(defFile)
          ? entry?.location
            ? await outsideUse(
                indexer,
                word,
                defFile,
                reaches(indexer, word, entry),
              )
            : variable?.location && !local(variable)
              ? await outsideUse(
                  indexer,
                  word,
                  defFile,
                  usesVariable(word, variable),
                )
              : undefined
          : undefined;
      if (outside) {
        throw new Error(
          `${word} is also used in ${indexer.projects.projectName(outside)}/${path.basename(outside)}, outside the workspace: renaming would break it.`,
        );
      }
      const edit = new vscode.WorkspaceEdit();
      const files = new Set<string>([doc.uri.fsPath]);
      const replace = (loc: vscode.Location) => {
        edit.replace(loc.uri, loc.range, newName);
        files.add(loc.uri.fsPath);
      };
      /** The edit, unless a label of the new name is compiled with one of
       *  the edited files: labels are substituted before names are looked
       *  up, so the renamed symbol would silently become the label there.
       *  Nor where an edited call reaches another definition when another
       *  root compiles its file: one rename cannot suit both compiles. */
      const checked = () => {
        for (const f of entry ? files : []) {
          const per = indexer.getFunctionsByUnit(word, f);
          const other = per.filter((u) => u.fn && !sameDefinition(u.fn, entry));
          if (other.length && per.some((u) => sameDefinition(u.fn, entry))) {
            throw new Error(
              `${vscode.workspace.asRelativePath(f)} is also compiled by ${other.map((u) => u.unit.root).join(" and ")}, where ${word} is another function: renaming this one would break that compile.`,
            );
          }
        }
        for (const f of files) {
          if (!indexer.isKnownLabel(newName, f)) continue;
          const where =
            f === doc.uri.fsPath
              ? ""
              : ` where ${vscode.workspace.asRelativePath(f)} is compiled`;
          throw new Error(
            `"${newName}" is a label${where}: the compiler would replace every use of it.`,
          );
        }
        return edit;
      };
      const addDefinition = (def: FunctionInfo | undefined) => {
        if (def?.location) replace(def.location);
      };

      // Try to use cached references for functions (much faster), unless a
      // variable of the name may hide the function somewhere
      const mayBeHidden = indexer.getVariables(word).some((v) => v.location);
      if (refCache.isReady && entry && !mayBeHidden) {
        const cached = refCache.getReferences(word);
        if (cached) {
          // Only the calls that reach this definition
          const reached = reaches(indexer, word, entry);
          const locations = await refCache.toLocations(
            cached.refs.filter((ref) => reached(ref.file)),
          );
          for (const loc of locations) replace(loc);
          addDefinition(entry);
          return checked();
        }
      }

      // Fallback: use VS Code's reference provider
      const refs = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        doc.uri,
        pos,
      );
      for (const loc of refs || []) replace(loc);
      addDefinition(entry);
      return checked();
    },
  };
}
