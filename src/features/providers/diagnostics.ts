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
      const ignoreNoHeaders = buildIgnoreSpans(text, {
        includeFunctionHeaders: false,
      });
      const ignoredFuncs = new Set(
        (cfg().get("cicode.diagnostics.ignoredFunctions", []) as string[]).map(
          (f) => f.toLowerCase(),
        ),
      );
      const diags: vscode.Diagnostic[] = [];

      // Check function calls
      {
        const re = /\b([A-Za-z_]\w*)\s*\(/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          const name = m[1];
          if (
            KEYWORDS_WITH_PAREN.has(name.toUpperCase()) ||
            ignoredFuncs.has(name.toLowerCase())
          )
            continue;

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

      // E2019: Check for function calls without parentheses
      {
        const allFuncs = new Set<string>();
        for (const [name] of indexer.getAllFunctions()) {
          allFuncs.add(name);
        }

        const re = /\b([A-Za-z_]\w+)\b(?!\s*\()/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          if (inSpan(m.index, ignoreNoHeaders)) continue;

          const name = m[1];
          const nameLower = name.toLowerCase();

          if (
            allFuncs.has(nameLower) &&
            !KEYWORDS_WITH_PAREN.has(name.toUpperCase())
          ) {
            const s = doc.positionAt(m.index);
            const e = doc.positionAt(m.index + name.length);
            diags.push(
              new vscode.Diagnostic(
                new vscode.Range(s, e),
                `E2019: Function '${name}' requires parentheses ()`,
                vscode.DiagnosticSeverity.Error,
              ),
            );
          }
        }
      }

      // Check duplicate functions
      {
        const seen = new Set<string>();
        for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
          const key = f.name.toLowerCase();
          if (seen.has(key)) {
            diags.push(
              new vscode.Diagnostic(
                f.location.range,
                `E2021: Function '${f.name}' is already defined in this file`,
                vscode.DiagnosticSeverity.Error,
              ),
            );
          } else seen.add(key);
        }
      }

      // Check function shadows builtin
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

      // Check optional params order
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

      // Check return statements and control flow
      {
        for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
          const header = indexer.getFunction(f.name);
          const returnType = (header?.returnType || "VOID").toUpperCase();

          const bodyStartAbs = doc.offsetAt(f.bodyRange.start);
          const bodyEndAbs = doc.offsetAt(f.bodyRange.end);
          const body = text.slice(bodyStartAbs, bodyEndAbs);

          let hasReturnWithValue = false;
          const retRe = /\bRETURN\b\s*([^\r\n;]*)/gi;
          let m: RegExpExecArray | null;
          const returnPositions: number[] = [];

          while ((m = retRe.exec(body))) {
            const retAbs = bodyStartAbs + m.index;
            if (inSpan(retAbs, ignoreNoHeaders)) continue;

            returnPositions.push(m.index);
            const payload = (m[1] || "").trim();
            if (payload.length > 0) {
              hasReturnWithValue = true;

              if (returnType === "VOID") {
                const pos = doc.positionAt(retAbs);
                diags.push(
                  new vscode.Diagnostic(
                    new vscode.Range(pos, pos.translate(0, 6)),
                    "E2036: Cannot return value from void function.",
                    vscode.DiagnosticSeverity.Error,
                  ),
                );
              }
            }
          }

          if (returnType !== "VOID" && !hasReturnWithValue) {
            diags.push(
              new vscode.Diagnostic(
                f.location.range,
                `E2037: Function '${f.name}' must return a value.`,
                vscode.DiagnosticSeverity.Error,
              ),
            );
          }

          // Check for unreachable code after RETURN
          for (const retPos of returnPositions) {
            const afterReturn = body.slice(retPos);
            const returnLineEnd = afterReturn.indexOf("\n");
            if (returnLineEnd === -1) continue;

            const nextCode = afterReturn.slice(returnLineEnd + 1);
            const lines = nextCode.split(/\r?\n/);

            for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
              const line = lines[lineIdx].trim();
              if (!line) continue;

              const absPos =
                bodyStartAbs +
                retPos +
                returnLineEnd +
                1 +
                nextCode.indexOf(lines[lineIdx]);
              if (inSpan(absPos, ignoreNoHeaders)) continue;

              if (!/^(END|ELSE|EXCEPT|FINALLY|CASE)\b/i.test(line)) {
                const pos = doc.positionAt(absPos);
                diags.push(
                  new vscode.Diagnostic(
                    new vscode.Range(
                      pos,
                      pos.translate(0, Math.min(line.length, 50)),
                    ),
                    "Unreachable code after RETURN statement.",
                    vscode.DiagnosticSeverity.Warning,
                  ),
                );
                break;
              }
              break;
            }
          }
        }
      }

      // Check for missing control keywords (E2032, E2033, E2034)
      {
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();
          const lineStart = doc.offsetAt(new vscode.Position(i, 0));
          if (inSpan(lineStart, ignoreNoHeaders)) continue;

          // E2032: Missing THEN after IF (handle multi-line)
          const ifMatch = /\bIF\b/i.exec(line);
          if (ifMatch && !inSpan(lineStart + ifMatch.index, ignoreNoHeaders)) {
            let foundThen = /\bTHEN\b/i.test(line);
            if (!foundThen) {
              for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                const nextLine = lines[j].trim();
                if (!nextLine || /^(\/\/|!)/.test(nextLine)) continue;
                if (/\bTHEN\b/i.test(nextLine)) {
                  foundThen = true;
                  break;
                }
                if (/^\b(IF|FOR|WHILE|END|FUNCTION)\b/i.test(nextLine)) break;
              }
            }

            if (!foundThen) {
              const pos = new vscode.Position(i, ifMatch.index);
              diags.push(
                new vscode.Diagnostic(
                  new vscode.Range(pos, pos.translate(0, 2)),
                  "E2032: IF statement requires THEN keyword.",
                  vscode.DiagnosticSeverity.Error,
                ),
              );
            }
          }

          // E2033: Missing DO after WHILE (handle multi-line)
          const whileMatch = /\bWHILE\b/i.exec(line);
          if (
            whileMatch &&
            !inSpan(lineStart + whileMatch.index, ignoreNoHeaders)
          ) {
            let foundDo = /\bDO\b/i.test(line);
            if (!foundDo) {
              for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                const nextLine = lines[j].trim();
                if (!nextLine || /^(\/\/|!)/.test(nextLine)) continue;
                if (/\bDO\b/i.test(nextLine)) {
                  foundDo = true;
                  break;
                }
                if (/^\b(IF|FOR|WHILE|END|FUNCTION)\b/i.test(nextLine)) break;
              }
            }

            if (!foundDo) {
              const pos = new vscode.Position(i, whileMatch.index);
              diags.push(
                new vscode.Diagnostic(
                  new vscode.Range(pos, pos.translate(0, 5)),
                  "E2033: WHILE statement requires DO keyword.",
                  vscode.DiagnosticSeverity.Error,
                ),
              );
            }
          }
        }
      }

      // Check for unused variables
      if (cfg().get("cicode.lint.warnUnusedVariables", true)) {
        for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
          const bodyStartAbs = doc.offsetAt(f.bodyRange.start);
          const bodyEndAbs = doc.offsetAt(f.bodyRange.end);
          const body = text.slice(bodyStartAbs, bodyEndAbs);

          const scopeId = indexer.localScopeId(doc.uri.fsPath, f.name);
          const localVars = indexer.getVariablesByPredicate(
            (v) =>
              v.scopeType === "local" && v.scopeId === scopeId && !v.isParam,
          );

          for (const v of localVars) {
            const nameRe = new RegExp(`\\b${v.name}\\b`, "gi");
            let count = 0;
            let m: RegExpExecArray | null;

            while ((m = nameRe.exec(body))) {
              const pos = bodyStartAbs + m.index;
              if (!inSpan(pos, ignoreNoHeaders)) count++;
            }

            // If variable appears only once (its declaration), it's unused
            if (count <= 1) {
              diags.push(
                new vscode.Diagnostic(
                  v.location.range,
                  `Variable '${v.name}' is declared but never used.`,
                  vscode.DiagnosticSeverity.Hint,
                ),
              );
            }
          }
        }
      }

      // Linting checks
      if (cfg().get("cicode.lint.enable", true)) {
        const maxLen = cfg().get("cicode.lint.maxLineLength", 140) || 0;
        const warnMixed = cfg().get("cicode.lint.warnMixedIndent", true);
        const warnSemi = cfg().get("cicode.lint.warnMissingSemicolons", true);
        const warnKwCase = cfg().get("cicode.lint.warnKeywordCase", true);
        const warnMagicNumbers = cfg().get(
          "cicode.lint.warnMagicNumbers",
          false,
        );

        for (let i = 0; i < doc.lineCount; i++) {
          const L = doc.lineAt(i);
          const s = L.text;
          const trimmed = s.trim();
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
          if (warnMixed && /^(?=.*\t)(?=.* )/.test(leading)) {
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
          }

          if (warnSemi && !isComment) {
            if (
              /^\s*((?:GLOBAL|MODULE)\s+)?(\w+)\s+\w+(\s*,\s*\w+)*\s*$/i.test(s)
            ) {
              const typeWord =
                /^\s*(?:(?:GLOBAL|MODULE)\s+)?(\w+)/i.exec(s)?.[1] || "";
              if (TYPE_RE.test(typeWord) && !/;\s*(\/\/|!|$)/.test(s)) {
                diags.push(
                  new vscode.Diagnostic(
                    new vscode.Range(L.range.start, L.range.end),
                    "Consider ending declarations with a semicolon.",
                    vscode.DiagnosticSeverity.Information,
                  ),
                );
              }
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

          // Magic numbers check
          if (warnMagicNumbers && !isComment) {
            const numRe = /\b(\d+(?:\.\d+)?)\b/g;
            let m: RegExpExecArray | null;
            while ((m = numRe.exec(s))) {
              const num = parseFloat(m[1]);
              const absPos = doc.offsetAt(new vscode.Position(i, m.index));

              // Skip array indices
              const isArrayIndex = /\[\s*\d+\s*\]/.test(
                s.slice(Math.max(0, m.index - 2), m.index + m[1].length + 2),
              );

              if (
                num !== 0 &&
                num !== 1 &&
                num !== -1 &&
                !isArrayIndex &&
                !inSpan(absPos, ignoreNoHeaders)
              ) {
                const start = new vscode.Position(i, m.index);
                const end = new vscode.Position(i, m.index + m[1].length);
                diags.push(
                  new vscode.Diagnostic(
                    new vscode.Range(start, end),
                    `Consider using a named constant instead of magic number '${m[1]}'.`,
                    vscode.DiagnosticSeverity.Hint,
                  ),
                );
              }
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
