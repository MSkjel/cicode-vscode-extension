import * as vscode from "vscode";
import type { Indexer } from "../core/indexer/indexer";
import { cleanParamName } from "../shared/textUtils";

export function buildDocSkeleton(opts: {
  name: string;
  returnType: string;
  paramsRaw: string;
}): string {
  const { name, returnType } = opts;
  const params = (opts.paramsRaw || "")
    .split(",")
    .map((s) => cleanParamName(s))
    .filter(Boolean);

  const lines: string[] = [];
  lines.push("/**");
  lines.push(`<function name="${name}">`);

  lines.push(" <summary>");
  lines.push(`  TODO summary`);
  lines.push(" </summary>");

  for (const p of params) {
    lines.push(` <param name="${p}">TODO</param>`);
  }

  if (returnType && returnType.toUpperCase() !== "VOID") {
    lines.push(" <returns>TODO</returns>");
  }

  lines.push("</function>");
  lines.push("**/");

  return lines.join("\n") + "\n";
}

export async function insertDocSkeletonAtCursor(
  indexer: Indexer,
): Promise<boolean> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return false;

  const doc = editor.document;
  const pos = editor.selection.active;

  const fr =
    indexer.findEnclosingFunction(doc, pos) ||
    nearestFunctionAtOrAbove(indexer, doc, pos);
  if (!fr) {
    vscode.window.showInformationMessage(
      "Cicode: No function found at cursor.",
    );
    return false;
  }

  const headerLine = fr.headerPos.line;
  const prevLineText = headerLine > 0 ? doc.lineAt(headerLine - 1).text : "";
  if (/^\s*\/\/\//.test(prevLineText)) {
    vscode.window.showInformationMessage("Cicode: Doc block already present.");
    return false;
  }

  const skeleton = buildDocSkeleton({
    name: fr.name,
    returnType: fr.returnType || "VOID",
    paramsRaw: fr.paramsRaw || "",
  });

  const insertPos = new vscode.Position(headerLine, 0);
  await editor.edit((eb) => eb.insert(insertPos, skeleton));
  return true;
}

function nearestFunctionAtOrAbove(
  indexer: Indexer,
  doc: vscode.TextDocument,
  pos: vscode.Position,
) {
  const file = doc.uri.fsPath;
  const list = indexer.getFunctionRanges(file);
  if (!list?.length) return null;
  const caretOffset = doc.offsetAt(pos);
  let best: (typeof list)[number] | null = null;
  for (const f of list) {
    const headerOffset = doc.offsetAt(f.headerPos);
    if (
      headerOffset <= caretOffset &&
      (!best || headerOffset > doc.offsetAt(best.headerPos))
    ) {
      best = f;
    }
  }
  return best;
}
