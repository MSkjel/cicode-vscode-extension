import * as vscode from "vscode";
import type { Indexer } from "../core/indexer/indexer";

export function makeStatusBar(indexer: Indexer): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  item.text = "Cicode: indexing…";
  item.command = "cicode.reindexAll";
  item.show();

  const refresh = () => {
    const f = indexer.getAllFunctions().size;
    const v = indexer.getTotalVariableCount();
    item.text = `Cicode: ${f} funcs | ${v} vars`;
    item.tooltip = "Click to reindex workspace";
  };

  indexer.onIndexed(refresh);
  refresh();
  return item;
}
