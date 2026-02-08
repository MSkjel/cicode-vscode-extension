import * as vscode from "vscode";
import type { Indexer } from "../core/indexer/indexer";
import { cleanParamName } from "../shared/textUtils";
import { cfg } from "../config";

interface DocSkeletonConfig {
  useBlockComment: Boolean; // Whether block comments (/** ... */) or if single line comments (///) are used for the doc skeleton
  useXMLDoxygenCommands: Boolean; // Whether regular doxygen speceial commands (@ and /), or if doxygen XML tags are used by the doc skeleton
  nonXMLCommandChar: string; // if the non xml doxygen should use @ or /
}
function getDocstringFormat(): DocSkeletonConfig {
  const c = cfg();
  return {
    useBlockComment:
      c.get(
        "cicode.documentation.docskeleton.useBlockComment",
        "Block comment",
      ) === "Block comment"
        ? true
        : false,
    useXMLDoxygenCommands:
      c.get(
        "cicode.documentation.docskeleton.doxygenStyle",
        "XML Doxygen commands",
      ) === "XML Doxygen commands"
        ? true
        : false,
    nonXMLCommandChar:
      c.get(
        "cicode.documentation.docskeleton.doxygenStyle",
        "Javadoc style (@)",
      ) === "Javadoc style (@)"
        ? "@"
        : "\\",
  };
}
/**
 * Returns an array of strings, containing the required docstring.
 *
 * @param useXML - If the string should use XML doxygen commands, or if it should use normal doxygen comments.
 * @param tagName - Name of the tag/command to be used.
 * @param leadingCharacters - The string to be inserted at the beginning of the line.
 * @param splitOverMultiLines - If the string should be split over multiple lines, this is only used for XML tags.
 * @param xmlAttribute - the attribute to use for XML tag (ie, name="<xmlAttribute")
 * @param includeTagNameInTodo - whether the tagName should be included in the TODO statment
 * @param insertEmptyLineAtEnd - if an empty line with leading char should be inserted at the end
 * @param insertEmptyLineAtBeginning - if an empty line with leading char should be inserted at the beginning
 */
function insertXmlOrDoxygenTag(
  useXML: Boolean,
  tagName: string,
  leadingCharacters: string = "",
  splitOverMultiLines: Boolean = false,
  xmlAttribute: string = "",
  includeTagNameInTodo: Boolean = true,
  insertEmptyLineAtEnd: Boolean = false,
  insertEmptyLineAtBeginning: Boolean = false,
  doxygenLeadingChar: string = "@",
): string[] {
  const line: string[] = [];
  if (insertEmptyLineAtBeginning) {
    line.push(`${leadingCharacters}`);
  }
  let commandOpening = "";
  {
    let leadingChar: string = useXML ? "<" : ` ${doxygenLeadingChar}`;
    let closingChar = "";
    if (xmlAttribute !== "") {
      closingChar = useXML ? ` name="${xmlAttribute}">` : ` ${xmlAttribute} `;
    } else {
      closingChar = useXML ? ">" : " ";
    }

    commandOpening = `${leadingChar}${tagName}${closingChar}`;
  }
  let commandClosing = "";
  {
    if (useXML) {
      commandClosing = `</${tagName}>`;
    }
  }
  if (!splitOverMultiLines) {
    line.push(
      `${leadingCharacters}${commandOpening}TODO ${includeTagNameInTodo ? tagName : ""}${commandClosing}`,
    );
  } else {
    line.push(`${leadingCharacters}${commandOpening}`);
    line.push(
      `${leadingCharacters} TODO ${includeTagNameInTodo ? tagName : ""}`,
    );
    line.push(`${leadingCharacters}${commandClosing}`);
  }
  if (insertEmptyLineAtEnd) {
    line.push(`${leadingCharacters}`);
  }
  return line;
}

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
  let docConfig = getDocstringFormat();

  const lines: string[] = [];
  const docCommentLeadingCharacter = docConfig.useBlockComment ? " *" : "///";
  if (docConfig.useBlockComment) {
    lines.push("/**");
  }

  insertXmlOrDoxygenTag(
    docConfig.useXMLDoxygenCommands,
    docConfig.useXMLDoxygenCommands ? "summary" : "brief",
    docCommentLeadingCharacter,
    docConfig.useXMLDoxygenCommands,
    "",
    true,
    !docConfig.useXMLDoxygenCommands,
    false,
    docConfig.nonXMLCommandChar,
  ).forEach((line) => {
    lines.push(line);
  });
  for (const p of params) {
    insertXmlOrDoxygenTag(
      docConfig.useXMLDoxygenCommands,
      "param",
      docCommentLeadingCharacter,
      false,
      p,
      false,
      false,
      false,
      docConfig.nonXMLCommandChar,
    ).forEach((line) => {
      lines.push(line);
    });
  }

  if (returnType && returnType.toUpperCase() !== "VOID") {
    insertXmlOrDoxygenTag(
      docConfig.useXMLDoxygenCommands,
      "returns",
      docCommentLeadingCharacter,
      false,
      "",
      false,
      false,
      !docConfig.useXMLDoxygenCommands,
      docConfig.nonXMLCommandChar,
    ).forEach((line) => {
      lines.push(line);
    });
  }

  if (docConfig.useBlockComment) {
    lines.push(" */");
  }
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
  if (/^\s*\/\/\//.test(prevLineText) || /^\s*\*+\//.test(prevLineText)) {
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
