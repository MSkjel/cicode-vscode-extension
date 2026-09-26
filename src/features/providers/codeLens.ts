import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import type { ReferenceCache } from "../../core/referenceCache";

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

      for (const f of funcRanges) {
        // Above the first header line: scope and return type may sit on
        // lines above FUNCTION, and the name on the line below it.
        let anchor = document.positionAt(f.itemStart);
        if (anchor.isAfter(f.headerPos)) anchor = f.headerPos;
        anchor = new vscode.Position(anchor.line, 0);
        const range = new vscode.Range(anchor, anchor);

        // Labels are substituted before names are looked up: every call
        // of a function named like a label expands the label instead.
        if (indexer.isKnownLabel(f.name)) {
          lenses.push(
            new vscode.CodeLens(range, {
              title: `label ${f.name} replaces every call`,
              command: "",
            }),
          );
          continue;
        }

        // Calls that reach this definition: a PRIVATE function is called
        // from its own file only, and a file with its own PRIVATE function
        // of the name calls that one.
        const def = indexer
          .getFunctionDefinitions(f.name)
          .find((d) => d.file === file);
        const refs = refCache.getReferences(f.name)?.refs;
        const refCount =
          def && refs
            ? refs.filter((r) => indexer.getFunctionFor(f.name, r.file) === def)
                .length
            : refCache.getReferenceCount(f.name);

        lenses.push(
          new vscode.CodeLens(range, {
            title: refCount === 1 ? "1 reference" : `${refCount} references`,
            command: "editor.action.findReferences",
            arguments: [document.uri, f.location.range.start],
          }),
        );
      }

      return lenses;
    },
  };
}
