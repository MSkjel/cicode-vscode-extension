import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import type { ReferenceCache } from "../../core/referenceCache";
import {
  buildIgnoreSpans,
  inSpan,
  cleanParamName,
} from "../../shared/textUtils";
import { countArgsTopLevel } from "../../shared/parseHelpers";
import { KEYWORDS_WITH_PAREN } from "../../shared/constants";
import { escapeRegExp, formatScopeType } from "../../shared/utils";

export function makeNavProviders(
  indexer: Indexer,
  refCache: ReferenceCache,
): vscode.Disposable[] {
  const lang = { language: "cicode" } as const;

  return [
    vscode.languages.registerDefinitionProvider(lang, {
      provideDefinition(document, position) {
        const wr = document.getWordRangeAtPosition(position, /\w+/);
        if (!wr) return null;
        const w = document.getText(wr);
        const f = indexer.getFunction(w);
        if (f?.location) return f.location;
        const v = indexer.resolveVariableAt(document, position, w);
        return v?.location || null;
      },
    }),

    vscode.languages.registerHoverProvider(lang, {
      provideHover(document, position) {
        const wr = document.getWordRangeAtPosition(position, /\w+/);
        if (!wr) return null;

        const w = document.getText(wr);
        const entry = indexer.getFunction(w);
        if (entry) {
          const sig = `${entry.returnType} ${entry.name}(${(entry.params || []).join(", ")})`;
          let md = "```cicode\n" + sig + "\n```";
          if (entry.doc) md += `\n\n${entry.doc}`;
          if (entry.returns) md += `\n\n**Returns:** ${entry.returns}`;

          const showLink = vscode.workspace
            .getConfiguration("cicode")
            .get<boolean>("hover.showHelpLink", true);
          const helpPath = (entry as any).helpPath as string | undefined;
          if (showLink && helpPath) {
            const cmdUri = vscode.Uri.parse(
              `command:cicode.openHelpForSymbol?${encodeURIComponent(JSON.stringify(entry.name))}`,
            );
            md += `\n\n[Open full help](${cmdUri})`;
          }

          const ms = new vscode.MarkdownString(md);
          ms.isTrusted = true;
          return new vscode.Hover(ms);
        }

        const v = indexer.resolveVariableAt(document, position, w);
        if (v) {
          const scope = formatScopeType(v.scopeType, { scopeId: v.scopeId });
          const md =
            "```cicode\n" + `${v.type} ${v.name} // ${scope}` + "\n```";
          return new vscode.Hover(new vscode.MarkdownString(md));
        }

        return null;
      },
    }),

    vscode.languages.registerReferenceProvider(lang, {
      async provideReferences(document, position) {
        const wr = document.getWordRangeAtPosition(position, /\w+/);
        if (!wr) return [];
        const word = document.getText(wr);

        const funcEntry = indexer.getFunction(word);
        const varEntry = indexer.resolveVariableAt(document, position, word);

        // For functions: use the cache when available
        if (funcEntry) {
          const cached = refCache.getReferences(word);
          if (cached && refCache.isReady) {
            return refCache.toLocations(cached.refs);
          }
          // Fallback: live scan
          return liveScanAllFiles(word);
        }

        // For variables: scope-limited live scan (already fast)
        if (varEntry) {
          if (varEntry.scopeType === "local") {
            if (varEntry.isParam) {
              const funcRanges = indexer.getFunctionRanges(document.uri.fsPath);
              const enclosingFunc = funcRanges.find(
                (f) =>
                  indexer.localScopeId(document.uri.fsPath, f.name) ===
                  varEntry.scopeId,
              );
              if (enclosingFunc) {
                const fullRange = new vscode.Range(
                  enclosingFunc.headerPos,
                  enclosingFunc.bodyRange.end,
                );
                return liveScan(document.uri, word, fullRange);
              }
              return liveScan(document.uri, word, varEntry.range!);
            }
            return liveScan(document.uri, word, varEntry.range!);
          }
          if (varEntry.scopeType === "module") {
            return liveScan(document.uri, word);
          }
          // global variable – scan all files
          return liveScanAllFiles(word);
        }

        // Unknown symbol – scan all files
        return liveScanAllFiles(word);

        // ---------------------------------------------------------------
        // Helpers
        // ---------------------------------------------------------------

        async function liveScan(
          uri: vscode.Uri,
          target: string,
          range?: vscode.Range,
        ): Promise<vscode.Location[]> {
          const results: vscode.Location[] = [];
          const doc = await vscode.workspace.openTextDocument(uri);
          const text = doc.getText();
          const searchText = range
            ? text.slice(doc.offsetAt(range.start), doc.offsetAt(range.end))
            : text;
          const baseOffset = range ? doc.offsetAt(range.start) : 0;
          const ignore = buildIgnoreSpans(searchText, {
            includeFunctionHeaders: false,
          });
          const escaped = escapeRegExp(target);
          const re = new RegExp(`\\b${escaped}\\b`, "g");

          let m: RegExpExecArray | null;
          while ((m = re.exec(searchText))) {
            const abs = baseOffset + m.index;
            if (inSpan(m.index, ignore)) continue;

            const start = doc.positionAt(abs);
            const end = doc.positionAt(abs + target.length);
            results.push(
              new vscode.Location(uri, new vscode.Range(start, end)),
            );
          }
          return results;
        }

        async function liveScanAllFiles(
          target: string,
        ): Promise<vscode.Location[]> {
          const files = await vscode.workspace.findFiles("**/*.ci");
          const results: vscode.Location[] = [];
          for (const f of files) {
            results.push(...(await liveScan(f, target)));
          }
          return results;
        }
      },
    }),

    vscode.languages.registerSignatureHelpProvider(
      lang,
      {
        provideSignatureHelp(document, position) {
          const text = document.getText(
            new vscode.Range(new vscode.Position(0, 0), position),
          );
          let depth = 0,
            funcPos = -1;
          for (let i = text.length - 1; i >= 0; i--) {
            const ch = text[i];
            if (ch === ")") depth++;
            else if (ch === "(") {
              if (depth === 0) {
                funcPos = i;
                break;
              }
              depth--;
            }
          }
          if (funcPos === -1) return null;

          const funcRange = document.getWordRangeAtPosition(
            document.positionAt(funcPos - 1),
            /\w+/,
          );
          if (!funcRange) return null;

          const funcName = document.getText(funcRange);
          if (KEYWORDS_WITH_PAREN.has(funcName.toUpperCase())) return null;

          const entry = indexer.getFunction(funcName);
          if (!entry) return null;

          const signature = `${entry.returnType} ${funcName}(${(entry.params || []).join(", ")})`;
          const sigInfo = new vscode.SignatureInformation(signature);

          const pdocs = entry.paramDocs || {};
          sigInfo.parameters = (entry.params || []).map((p) => {
            const clean = cleanParamName(p);
            const info = new vscode.ParameterInformation(clean);
            const doc = pdocs[clean] || pdocs[clean.toLowerCase()];
            if (doc) {
              const md = new vscode.MarkdownString();
              md.appendMarkdown(`**${clean}:** ${doc}`);
              info.documentation = md;
            }
            return info;
          });

          const sigHelp = new vscode.SignatureHelp();
          sigHelp.signatures = [sigInfo];
          sigHelp.activeSignature = 0;

          // Use proper argument counting that handles strings, comments, and nested parens
          const cursorPos = document.offsetAt(position);
          const argsStart = funcPos + 1; // Position after '('
          const argsText = text.slice(argsStart, cursorPos);
          const ignore = buildIgnoreSpans(argsText);

          // Count completed arguments (commas at top level)
          const argCount = countArgsTopLevel(
            argsText,
            0,
            argsText.length,
            ignore,
          );

          // activeParameter is the current argument index (0-based)
          // If we have N completed args, we're on argument N (0-indexed)
          sigHelp.activeParameter = Math.min(
            Math.max(0, argCount > 0 ? argCount - 1 : 0),
            Math.max((entry.params || []).length - 1, 0),
          );

          // Check if cursor is after a comma (starting a new argument)
          const trimmedEnd = argsText.trimEnd();
          if (trimmedEnd.endsWith(",")) {
            sigHelp.activeParameter = Math.min(
              argCount,
              Math.max((entry.params || []).length - 1, 0),
            );
          }

          return sigHelp;
        },
      },
      {
        triggerCharacters: ["(", ",", '"', "'"],
        retriggerCharacters: [
          ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_".split(
            "",
          ),
          " ",
          ",",
          ")",
        ],
      },
    ),
  ];
}
