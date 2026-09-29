import * as vscode from "vscode";
import type { Indexer } from "../core/indexer/indexer";

export function makeStatusBar(indexer: Indexer): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  item.text = "Cicode: indexing…";
  item.command = "cicode.reindexAll";
  item.show();

  const refresh = () => {
    // Function names of every indexed project
    const f = indexer.getFunctionNames().size;
    const v = indexer.getTotalVariableCount();
    item.text = `Cicode: ${f} funcs | ${v} vars`;
    item.tooltip = "Click to reindex workspace";
  };

  // Debounce refreshes: onIndexed can fire in bursts (per-file reindexes,
  // mass deletes/renames), and each refresh collects every function name
  // and recounts all variables just to update a label.
  let timer: NodeJS.Timeout | undefined;
  const subscription = indexer.onIndexed(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, 1000);
  });
  refresh();

  return {
    dispose(): void {
      if (timer) clearTimeout(timer);
      subscription.dispose();
      item.dispose();
    },
  };
}
