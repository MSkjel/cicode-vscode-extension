import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import type { ReferenceCache } from "../../core/referenceCache";
import type { FunctionInfo } from "../../shared/types";
import { isNameChar, isNameStart } from "../../shared/textUtils";
import { RESERVED_WORDS } from "../../shared/constants";
import { nameAt, resolveNameAt } from "./nameAt";

/** Longest function name the compiler accepts (E2109). */
const MAX_FUNCTION_NAME = 250;

function addDefinition(
  edit: vscode.WorkspaceEdit,
  entry: FunctionInfo | undefined,
  newName: string,
): void {
  if (!entry?.location) return;
  edit.replace(entry.location.uri, entry.location.range, newName);
}

/** Why `newName` cannot replace a name, or null when it can. */
function invalidNewName(
  indexer: Indexer,
  newName: string,
  isFunction: boolean,
): string | null {
  if (!isNameStart(newName[0]) || ![...newName].every((c) => isNameChar(c))) {
    return `"${newName}" is not a Cicode name.`;
  }
  if (RESERVED_WORDS.has(newName.toUpperCase())) {
    return `"${newName}" is a reserved word.`;
  }
  // Labels are substituted before names are looked up, so the renamed
  // symbol would silently become the label.
  if (indexer.isKnownLabel(newName)) {
    return `"${newName}" is a label: the compiler would replace every use of it.`;
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
  return {
    prepareRename(doc, pos) {
      // null on a field of a tag reference (`Tag.Field`) and off names
      const at = nameAt(doc, pos);
      if (!at) return null;
      const word = at.name;

      if (RESERVED_WORDS.has(word.toUpperCase()))
        throw new Error("A keyword cannot be renamed.");
      if (indexer.isKnownLabel(word))
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
      const problem = invalidNewName(indexer, newName, entry !== undefined);
      if (problem) throw new Error(problem);
      const edit = new vscode.WorkspaceEdit();

      // Try to use cached references for functions (much faster), unless a
      // variable of the name may hide the function somewhere
      const mayBeHidden = indexer.getVariables(word).some((v) => v.location);
      if (refCache.isReady && entry && !mayBeHidden) {
        const cached = refCache.getReferences(word);
        if (cached) {
          // Only the calls that reach this definition (PRIVATE functions
          // are per file)
          const locations = await refCache.toLocations(
            cached.refs.filter(
              (ref) => indexer.getFunctionFor(word, ref.file) === entry,
            ),
          );
          for (const loc of locations)
            edit.replace(loc.uri, loc.range, newName);
          addDefinition(edit, entry, newName);
          return edit;
        }
      }

      // Fallback: use VS Code's reference provider
      const refs = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        doc.uri,
        pos,
      );
      for (const loc of refs || []) edit.replace(loc.uri, loc.range, newName);
      addDefinition(edit, entry, newName);
      return edit;
    },
  };
}
