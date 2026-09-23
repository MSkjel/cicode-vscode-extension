import * as vscode from "vscode";
import { decodeFileBytes } from "../../shared/utils";

/** Text of a source file as an opened TextDocument would hold it (same
 *  decoding and line breaks, so offsets and content hashes agree). */
export async function readSourceText(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return decodeFileBytes(uri, bytes);
}

/** Real workspace files only: git and diff views share the working file's
 *  fsPath but hold other content. */
export function isIndexableUri(uri: vscode.Uri): boolean {
  return (
    uri.scheme === "file" ||
    vscode.workspace.getWorkspaceFolder(uri) !== undefined
  );
}

/** The open document for `uri` (same scheme), if any. */
export function findOpenDocument(
  uri: vscode.Uri,
): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(
    (d) => d.uri.scheme === uri.scheme && d.uri.fsPath === uri.fsPath,
  );
}
