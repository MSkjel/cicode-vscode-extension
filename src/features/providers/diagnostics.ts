import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import {
  buildIgnoreSpans,
  inSpan,
  TYPE_RE,
  cleanParamName,
} from "../../shared/textUtils";
import {
  countArgsTopLevel,
  findMatchingParen,
} from "../../shared/parseHelpers";
import { KEYWORDS_WITH_PAREN } from "../../shared/constants";

function computeArgBounds(params: string[]): {
  min: number;
  max: number;
  normalized: string[];
} {
  let min = 0,
    max = 0;
  let inOptional = false;
  const normalized: string[] = [];

  for (let raw of params || []) {
    if (!raw) continue;

    const hasOpen = raw.includes("[");
    const hasClose = raw.includes("]");
    const fullyBracketed = hasOpen && hasClose;

    const core = raw.replace(/[\[\]]/g, "").trim();

    // Pure bracket tokens like "[" or "]" — just toggle state.
    if (!core.length && (hasOpen || hasClose)) {
      if (hasOpen && !hasClose) inOptional = true;
      if (hasClose && !hasOpen) inOptional = false;
      continue;
    }

    normalized.push(core);
    max++;

    const hasDefault = /=/.test(raw);
    const isOptional = inOptional || hasDefault || fullyBracketed;

    if (!isOptional) min++;

    // Update optional state for spans like "[, INT x, INT y]"
    if (hasOpen && !hasClose) inOptional = true;
    if (hasClose && !hasOpen) inOptional = false;
  }

  return { min, max, normalized };
}

export function makeDiagnostics(
  indexer: Indexer,
  cfg: () => vscode.WorkspaceConfiguration,
): vscode.DiagnosticCollection {
  const coll = vscode.languages.createDiagnosticCollection("cicode");

  async function run(doc: vscode.TextDocument) {
    try {
      if (
        doc.languageId !== "cicode" &&
        !doc.uri.fsPath.toLowerCase().endsWith(".ci")
      )
        return;

      const text = doc.getText();
      const ignore = buildIgnoreSpans(text);
      const diags: vscode.Diagnostic[] = [];

      {
        const re = /\b([A-Za-z_]\w*)\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          const name = m[1];
          if (KEYWORDS_WITH_PAREN.has(name.toUpperCase())) continue;

          const openAbs = m.index + m[0].lastIndexOf("(");
          if (inSpan(openAbs, ignore)) continue;

          const entry = indexer.getFunction(name);
          if (!entry) {
            const s = doc.positionAt(m.index);
            const e = doc.positionAt(m.index + name.length);
            const d = new vscode.Diagnostic(
              new vscode.Range(s, e),
              `Unknown function '${name}'`,
              vscode.DiagnosticSeverity.Warning,
            );
            d.code = "cicode.undefinedFunction";
            d.source = "cicode";
            diags.push(d);
            continue;
          }

          const closeAbs = findMatchingParen(text, openAbs, ignore);
          if (closeAbs === -1) continue;

          const provided = countArgsTopLevel(
            text,
            openAbs + 1,
            closeAbs,
            ignore,
          );
          const { min: minArgs, max: maxArgs } = computeArgBounds(
            entry.params || [],
          );

          if (provided < minArgs || provided > maxArgs) {
            const s = doc.positionAt(m.index);
            const e = doc.positionAt(closeAbs + 1);
            diags.push(
              new vscode.Diagnostic(
                new vscode.Range(s, e),
                `W1004: Incorrect number of arguments for '${entry.name}'. Expected ${minArgs}-${maxArgs}, got ${provided}.`,
                vscode.DiagnosticSeverity.Warning,
              ),
            );
          }
        }
      }

      {
        const seen = new Set<string>();
        for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
          const key = f.name.toLowerCase();
          if (seen.has(key)) {
            diags.push(
              new vscode.Diagnostic(
                f.location.range,
                `Duplicate function '${f.name}' in this file`,
                vscode.DiagnosticSeverity.Information,
              ),
            );
          } else seen.add(key);
        }
      }

      {
        for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
          const builtin = indexer.getAllFunctions().get(f.name.toLowerCase());
          if (builtin?.helpPath) {
            diags.push(
              new vscode.Diagnostic(
                f.location.range,
                `W1006: Function '${f.name}' has the same name as a built-in function.`,
                vscode.DiagnosticSeverity.Warning,
              ),
            );
          }
        }
      }

      {
        for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
          const header = indexer.getFunction(f.name);
          const params = header?.params?.length
            ? header.params
            : (f.paramsRaw || "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
          if (!params.length) continue;

          const optFlags = (() => {
            let inOpt = false;
            return params.map((p) => {
              const hasOpen = p.includes("["),
                hasClose = p.includes("]"),
                hasDefault = /=/.test(p);
              const isOpt = inOpt || hasDefault || (hasOpen && hasClose);
              if (hasOpen && !hasClose) inOpt = true;
              if (hasClose && !hasOpen) inOpt = false;
              return isOpt;
            });
          })();

          let bad = false;
          for (let i = 0; i < optFlags.length; i++) {
            if (optFlags[i]) {
              for (let j = i + 1; j < optFlags.length; j++) {
                if (!optFlags[j]) {
                  bad = true;
                  break;
                }
              }
            }
            if (bad) break;
          }
          if (bad) {
            diags.push(
              new vscode.Diagnostic(
                f.location.range,
                "W1003: Argument with default/optional found before a required argument.",
                vscode.DiagnosticSeverity.Warning,
              ),
            );
          }
        }
      }

      {
        for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
          const header = indexer.getFunction(f.name);
          const returnType = (header?.returnType || "VOID").toUpperCase();

          const bodyStartAbs = doc.offsetAt(f.bodyRange.start);
          const bodyEndAbs = doc.offsetAt(f.bodyRange.end);
          const body = text.slice(bodyStartAbs, bodyEndAbs);
          let hasReturnWithValue = false;
          const retRe = /\bRETURN\b([\s\S]*?)(?:;|$)/gi;
          let m: RegExpExecArray | null;

          while ((m = retRe.exec(body))) {
            const retAbs = bodyStartAbs + m.index;
            if (inSpan(retAbs, ignore)) continue;
            const payload = (m[1] || "").trim();
            if (payload.length > 0) {
              hasReturnWithValue = true;
              break;
            }
          }

          if (returnType === "VOID" && hasReturnWithValue) {
            diags.push(
              new vscode.Diagnostic(
                f.location.range,
                "E2036: Cannot return value from void function.",
                vscode.DiagnosticSeverity.Error,
              ),
            );
          } else if (returnType !== "VOID" && !hasReturnWithValue) {
            diags.push(
              new vscode.Diagnostic(
                f.location.range,
                `E2037: Function '${f.name}' must return a value.`,
                vscode.DiagnosticSeverity.Error,
              ),
            );
          }
        }
      }

      if (cfg().get("cicode.lint.enable", true)) {
        const maxLen = cfg().get("cicode.lint.maxLineLength", 140) || 0;
        const warnMixed = cfg().get("cicode.lint.warnMixedIndent", true);
        const warnSemi = cfg().get("cicode.lint.warnMissingSemicolons", true);
        const warnKwCase = cfg().get("cicode.lint.warnKeywordCase", false);

        for (let i = 0; i < doc.lineCount; i++) {
          const L = doc.lineAt(i),
            s = L.text,
            trimmed = s.trim();
          const isComment = /^\s*(\/\/|!)/.test(trimmed);

          if (!isComment && maxLen > 0 && s.length > maxLen) {
            diags.push(
              new vscode.Diagnostic(
                new vscode.Range(L.range.start, L.range.end),
                `Line exceeds ${maxLen} chars (${s.length}).`,
                vscode.DiagnosticSeverity.Hint,
              ),
            );
          }
          const leading = s.match(/^\s*/)?.[0] || "";
          if (warnMixed && /^(?=.*\t)(?=.* )/.test(leading))
            diags.push(
              new vscode.Diagnostic(
                new vscode.Range(
                  new vscode.Position(i, 0),
                  new vscode.Position(i, leading.length),
                ),
                "Mixed indentation (tabs and spaces).",
                vscode.DiagnosticSeverity.Hint,
              ),
            );
          if (warnSemi && !isComment) {
            if (/^\s*(GLOBAL\s+)?(\w+)\s+\w+(\s*,\s*\w+)*\s*$/i.test(s)) {
              const typeWord = /^\s*(?:GLOBAL\s+)?(\w+)/i.exec(s)?.[1] || "";
              if (TYPE_RE.test(typeWord) && !/;\s*(\/\/|!|$)/.test(s))
                diags.push(
                  new vscode.Diagnostic(
                    new vscode.Range(L.range.start, L.range.end),
                    "Consider ending declarations with a semicolon.",
                    vscode.DiagnosticSeverity.Information,
                  ),
                );
            }
          }
          if (warnKwCase && !isComment) {
            const m = s.match(
              /\b(if|then|else|for|while|end|select|case|return|function|global|module)\b/,
            );
            if (m && m[0] !== m[0].toUpperCase()) {
              const idx = m.index || 0;
              diags.push(
                new vscode.Diagnostic(
                  new vscode.Range(
                    new vscode.Position(i, idx),
                    new vscode.Position(i, idx + m[0].length),
                  ),
                  `Prefer UPPERCASE keyword '${m[0].toUpperCase()}'.`,
                  vscode.DiagnosticSeverity.Hint,
                ),
              );
            }
          }
        }
      }

      coll.set(doc.uri, diags);
    } catch (err) {
      console.error("cicode diagnostics failed", err);
    }
  }

  const subs: vscode.Disposable[] = [];
  subs.push(vscode.workspace.onDidOpenTextDocument(run));
  subs.push(vscode.workspace.onDidChangeTextDocument((e) => run(e.document)));
  subs.push(vscode.workspace.onDidSaveTextDocument(run));
  if (vscode.window.activeTextEditor)
    run(vscode.window.activeTextEditor.document);
  return coll;
}
