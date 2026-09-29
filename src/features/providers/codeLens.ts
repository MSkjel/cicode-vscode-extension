import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import type { ReferenceCache } from "../../core/referenceCache";
import { reaches } from "./nameAt";

export function makeCodeLens(
  indexer: Indexer,
  refCache: ReferenceCache,
  cfg: () => vscode.WorkspaceConfiguration,
): vscode.CodeLensProvider & vscode.Disposable {
  const _onDidChange = new vscode.EventEmitter<void>();
  const subscription = refCache.onCacheUpdated(() => _onDidChange.fire());

  return {
    onDidChangeCodeLenses: _onDidChange.event,

    dispose(): void {
      subscription.dispose();
      _onDidChange.dispose();
    },

    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
      if (!cfg().get<boolean>("cicode.codeLens.enable", true)) return [];

      const lenses: vscode.CodeLens[] = [];
      const file = document.uri.fsPath;
      const funcRanges = indexer.getFunctionRanges(file);
      // Only workspace files are searched: callers in projects outside it
      // that are compiled with this one are not counted (Include and
      // System aside, which call few functions they do not define).
      const g = indexer.projects;
      const noun =
        indexer.isExternal(file) ||
        [...g.visible(file).keys()].some(
          (k) => !g.isImplicit(k) && g.project(k)?.inWorkspace === false,
        )
          ? "workspace reference"
          : "reference";

      for (const f of funcRanges) {
        // Above the first header line: scope and return type may sit on
        // lines above FUNCTION, and the name on the line below it.
        let anchor = document.positionAt(f.itemStart);
        if (anchor.isAfter(f.headerPos)) anchor = f.headerPos;
        anchor = new vscode.Position(anchor.line, 0);
        const range = new vscode.Range(anchor, anchor);

        // Labels are substituted before names are looked up: every call
        // of a function named like a label expands the label instead.
        if (indexer.isKnownLabel(f.name, file)) {
          lenses.push(
            new vscode.CodeLens(range, {
              title: `label ${f.name} replaces every call`,
              command: "",
            }),
          );
          continue;
        }

        // Calls that reach this definition
        const def = indexer
          .getFunctionDefinitions(f.name)
          .find((d) => d.file === file);
        const refCount = def
          ? refCache.getReferenceCount(f.name, reaches(indexer, f.name, def))
          : 0;

        lenses.push(
          new vscode.CodeLens(range, {
            title: `${refCount} ${noun}${refCount === 1 ? "" : "s"}`,
            command: "editor.action.findReferences",
            arguments: [document.uri, f.location.range.start],
          }),
        );
      }

      return lenses;
    },
  };
}
