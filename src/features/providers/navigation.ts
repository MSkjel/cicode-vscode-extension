import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import type { LabelRecord } from "../../core/indexer/labelsReader";
import type { ReferenceCache } from "../../core/referenceCache";
import type { FunctionInfo, VariableEntry } from "../../shared/types";
import {
  buildIgnoreSpans,
  inSpan,
  cleanParamName,
  isNameChar,
  nameKey,
} from "../../shared/textUtils";
import { buildDefinitionOffsets } from "../../shared/parseHelpers";
import { NAME_CHARS, RESERVED_WORDS } from "../../shared/constants";
import { CI_FILE_GLOB } from "../../shared/globs";
import { formatScopeType } from "../../shared/utils";
import { findWorkspaceFiles } from "../../config";
import { argumentNote, functionSignature, signatureParts } from "./completion";
import { nameAt, namePattern, reaches, resolveNameAt } from "./nameAt";

/** Same variable: the entry a name resolves to at some position. GLOBAL
 *  variables of different projects share the scope id. */
const sameVariable = (a: VariableEntry, b: VariableEntry) =>
  a.scopeType === b.scopeType &&
  a.scopeId === b.scopeId &&
  a.file === b.file &&
  nameKey(a.name) === nameKey(b.name);

/** Same constant label record. */
const sameLabel = (a: LabelRecord | undefined, b: LabelRecord) =>
  !!a && a.file === b.file && nameKey(a.name) === nameKey(b.name);

export function makeNavProviders(
  indexer: Indexer,
  refCache: ReferenceCache,
  cfg: () => vscode.WorkspaceConfiguration,
): vscode.Disposable[] {
  const lang = { language: "cicode" } as const;

  return [
    vscode.languages.registerDefinitionProvider(lang, {
      provideDefinition(document, position) {
        const w = nameAt(document, position)?.name;
        if (!w) return null;
        // A constant label has no definition in the code
        const r = resolveNameAt(indexer, document, position, w);
        if (r?.kind === "function") return r.fn.location;
        if (r?.kind === "variable") return r.v.location;
        return null;
      },
    }),

    vscode.languages.registerHoverProvider(lang, {
      provideHover(document, position) {
        const w = nameAt(document, position)?.name;
        if (!w) return null;

        const r = resolveNameAt(indexer, document, position, w);
        if (r?.kind === "label") {
          const label = r.label;
          let md = "```cicode\n" + `${label.name} = ${label.expr}` + "\n```";
          if (label.comment) md += `\n\n${label.comment}`;
          if (
            indexer.getFunctionFor(w, document.uri.fsPath) ||
            indexer.resolveVariableAt(document, position, w)
          ) {
            md +=
              "\n\nA label: the compiler substitutes it for every use of this name, so the function or variable of the same name is never used.";
          }
          return new vscode.Hover(new vscode.MarkdownString(md));
        }

        if (r?.kind === "function") {
          const entry = r.fn;
          let md = "```cicode\n" + functionSignature(entry) + "\n```";
          if (entry.expr) md += `\n\n**Expands to:** \`${entry.expr}\``;
          if (entry.doc) md += `\n\n${entry.doc}`;
          if (entry.returns) md += `\n\n**Returns:** ${entry.returns}`;

          const showLink = vscode.workspace
            .getConfiguration("cicode")
            .get<boolean>("hover.showHelpLink", true);
          const hasHelp = entry.helpId || entry.helpPath;
          if (showLink && hasHelp) {
            const cmdUri = vscode.Uri.parse(
              `command:cicode.openHelpForSymbol?${encodeURIComponent(JSON.stringify(entry.name))}`,
            );
            md += `\n\n[Open full help](${cmdUri})`;
          }

          const ms = new vscode.MarkdownString(md);
          ms.isTrusted = true;
          return new vscode.Hover(ms);
        }

        if (r?.kind === "variable") {
          const v = r.v;
          const scope = formatScopeType(v.scopeType, { scopeId: v.scopeId });
          let md = "```cicode\n" + `${v.type} ${v.name} // ${scope}` + "\n```";
          if (v.doc) md += `\n\n${v.doc}`;
          if (r.hides) {
            md += `\n\nThis variable hides the function \`${r.hides.name}\`: \`${v.name}(...)\` here does not call it.`;
          }
          return new vscode.Hover(new vscode.MarkdownString(md));
        }

        return null;
      },
    }),

    vscode.languages.registerReferenceProvider(lang, {
      async provideReferences(document, position, _context, token) {
        const word = nameAt(document, position)?.name;
        if (!word) return [];

        const resolved = resolveNameAt(indexer, document, position, word);
        // A label replaces every use of its name: match the name anywhere
        // in the files that see this label record.
        if (resolved?.kind === "label") {
          const label = resolved.label;
          return liveScanAllFiles(word, (f) =>
            sameLabel(indexer.getLabel(word, f), label),
          );
        }

        const funcEntry = resolved?.kind === "function" ? resolved.fn : null;
        const varEntry = resolved?.kind === "variable" ? resolved.v : null;

        if (funcEntry) {
          // The files whose calls reach this definition
          const sameFunction = reaches(indexer, word, funcEntry);
          // Not where a variable of the name is in scope and hides it
          const isFunction = (doc: vscode.TextDocument, pos: vscode.Position) =>
            resolveNameAt(indexer, doc, pos, word)?.kind === "function";
          const mayBeHidden =
            funcEntry.origin !== "label" &&
            indexer.getVariables(word).some((v) => v.location);
          const cached = refCache.getReferences(word);
          if (cached && refCache.isReady) {
            const locs = await refCache.toLocations(
              cached.refs.filter((r) => sameFunction(r.file)),
            );
            if (!mayBeHidden) return locs;
            const kept: vscode.Location[] = [];
            for (const loc of locs) {
              const doc = await vscode.workspace.openTextDocument(loc.uri);
              if (isFunction(doc, loc.range.start)) kept.push(loc);
            }
            return kept;
          }
          // Fallback to live scan
          return liveScanAllFiles(
            word,
            sameFunction,
            mayBeHidden ? isFunction : undefined,
          );
        }

        // For variables use scope-limited live scan
        if (varEntry) {
          // A local of the same name hides a module or global variable, and
          // a use before a declaration is a tag, not the variable.
          const sameVar = (doc: vscode.TextDocument, pos: vscode.Position) => {
            const v = indexer.resolveVariableAt(doc, pos, word);
            return v !== null && sameVariable(v, varEntry);
          };
          if (varEntry.scopeType === "local") {
            const funcRanges = indexer.getFunctionRanges(document.uri.fsPath);
            const enclosingFunc = funcRanges.find(
              (f) =>
                indexer.localScopeId(document.uri.fsPath, f.name) ===
                varEntry.scopeId,
            );
            const range = enclosingFunc
              ? new vscode.Range(
                  enclosingFunc.headerPos,
                  enclosingFunc.bodyRange.end,
                )
              : varEntry.range!;
            return liveScan(document.uri, word, range, sameVar);
          }
          if (varEntry.scopeType === "module") {
            return liveScan(document.uri, word, undefined, sameVar);
          }
          // A GLOBAL variable or locvar tag: the files that see it, but an
          // overlay (a folder inside a project's folder) only borrows names
          return liveScanAllFiles(
            word,
            (f) => {
              const g = indexer.projects;
              const p = g.projectOf(f);
              return (
                g.isVisible(f, varEntry.file) &&
                (!p.overlayOf || p.key === g.projectOf(varEntry.file).key)
              );
            },
            sameVar,
          );
        }

        // Unknown symbol (a tag): the files compiled with this one
        return liveScanAllFiles(word, (f) =>
          indexer.projects.sameUnit(document.uri.fsPath, f),
        );

        // ---------------------------------------------------------------
        // Helpers
        // ---------------------------------------------------------------

        async function liveScan(
          uri: vscode.Uri,
          target: string,
          range?: vscode.Range,
          keep?: (doc: vscode.TextDocument, pos: vscode.Position) => boolean,
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

          // Build set of offsets where function names are defined
          const defOffsets = buildDefinitionOffsets(
            text,
            indexer.getFunctionRanges(uri.fsPath),
          );

          // Whole names only (they may hold cp1252 letters and '\'), and
          // not the field of a `Tag.Field` reference.
          const re = new RegExp(
            `(?<![${NAME_CHARS}.])${namePattern(target)}(?![${NAME_CHARS}])`,
            "g",
          );

          let m: RegExpExecArray | null;
          while ((m = re.exec(searchText))) {
            const abs = baseOffset + m.index;
            if (inSpan(m.index, ignore)) continue;
            if (defOffsets.has(abs)) continue;

            const start = doc.positionAt(abs);
            if (keep && !keep(doc, start)) continue;
            const end = doc.positionAt(abs + target.length);
            results.push(
              new vscode.Location(uri, new vscode.Range(start, end)),
            );
          }
          return results;
        }

        async function liveScanAllFiles(
          target: string,
          keepFile?: (file: string) => boolean,
          keep?: (doc: vscode.TextDocument, pos: vscode.Position) => boolean,
        ): Promise<vscode.Location[]> {
          const files = await findWorkspaceFiles(CI_FILE_GLOB, cfg);
          const results: vscode.Location[] = [];
          for (const f of files) {
            if (token.isCancellationRequested) return results;
            if (keepFile && !keepFile(f.fsPath)) continue;
            results.push(...(await liveScan(f, target, undefined, keep)));
          }
          return results;
        }
      },
    }),

    vscode.languages.registerSignatureHelpProvider(
      lang,
      {
        provideSignatureHelp(document, position, token) {
          if (token.isCancellationRequested) return null;
          const enclosing = indexer.findEnclosingFunction(document, position);
          const scanFloor = enclosing
            ? document.offsetAt(enclosing.headerPos)
            : 0;
          // Only fetch what the backward scan can reach: the call being typed
          // cannot start before the enclosing function header. Cap the window
          // so the no-'('/';' worst case stays O(1) per keystroke.
          const base = Math.max(scanFloor, document.offsetAt(position) - 10000);
          const text = document.getText(
            new vscode.Range(document.positionAt(base), position),
          );
          // The indexer's cached spans lag the live document by the 500ms
          // reindex debounce, and signature help always runs mid-edit
          // (triggered by the keystroke itself), so compute spans on the
          // live window text (offsets are window-relative, matching `text`).
          const ignoreSpans = buildIgnoreSpans(text, {
            includeFunctionHeaders: false,
          });
          let depth = 0,
            funcPos = -1;
          for (let i = text.length - 1; i >= 0; i--) {
            if (token.isCancellationRequested) return null;
            if (inSpan(i, ignoreSpans)) continue;
            const ch = text[i];
            if (ch === ")") depth++;
            else if (ch === "(") {
              if (depth === 0) {
                funcPos = i;
                break;
              }
              depth--;
            } else if (ch === ";" && depth === 0) break;
          }
          if (funcPos === -1) return null;

          // The name before '(' (whitespace and comments may sit between).
          let nameEnd = funcPos;
          while (
            nameEnd > 0 &&
            (/\s/.test(text[nameEnd - 1]) || inSpan(nameEnd - 1, ignoreSpans))
          )
            nameEnd--;
          let nameStart = nameEnd;
          while (nameStart > 0 && isNameChar(text[nameStart - 1])) nameStart--;
          if (nameStart === nameEnd || text[nameStart - 1] === ".") return null;
          const funcName = text.slice(nameStart, nameEnd);
          // A keyword is never a call, even when a function has its name.
          if (RESERVED_WORDS.has(funcName.toUpperCase())) return null;

          // Not a call where a label constant or a variable has the name
          const r = resolveNameAt(
            indexer,
            document,
            document.positionAt(base + nameStart),
            funcName,
          );
          if (r?.kind !== "function") return null;
          const entry: FunctionInfo = r.fn;

          const sig = signatureParts(entry, funcName);
          const sigInfo = new vscode.SignatureInformation(sig.label);
          const pdocs = entry.paramDocs || {};
          sigInfo.parameters = (entry.params || []).map((p, i) => {
            const clean = cleanParamName(p);
            // Offsets, so a parameter named like the function or its type
            // is highlighted at its own place.
            const info = new vscode.ParameterInformation(sig.params[i]);
            const doc = pdocs[clean] || pdocs[clean.toLowerCase()];
            const note = argumentNote(entry, i);
            if (doc || note) {
              const md = new vscode.MarkdownString();
              if (doc) md.appendMarkdown(`**${clean}:** ${doc}`);
              if (note) md.appendMarkdown(`${doc ? "\n\n" : ""}${note}`);
              info.documentation = md;
            }
            return info;
          });

          // The argument being typed: top-level commas before the cursor
          // (a VARARG list ends in "...", which takes every further one).
          let commas = 0;
          let level = 0;
          for (let i = funcPos + 1; i < text.length; i++) {
            if (inSpan(i, ignoreSpans)) continue;
            const ch = text[i];
            if (ch === "(") level++;
            else if (ch === ")") level--;
            else if (ch === "," && level === 0) commas++;
          }

          const sigHelp = new vscode.SignatureHelp();
          sigHelp.signatures = [sigInfo];
          sigHelp.activeSignature = 0;
          sigHelp.activeParameter = Math.min(
            commas,
            Math.max(sigInfo.parameters.length - 1, 0),
          );
          return sigHelp;
        },
      },
      {
        triggerCharacters: ["(", ",", '"'],
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
