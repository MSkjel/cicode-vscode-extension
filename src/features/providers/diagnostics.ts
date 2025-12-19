import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import { buildIgnoreSpans, inSpan, TYPE_RE } from "../../shared/textUtils";
import { countArgsTopLevel, findMatchingParen } from "../../shared/parseHelpers";
import { KEYWORDS_WITH_PAREN, CONTROL_KEYWORDS } from "../../shared/constants";
import {
  escapeRegExp,
  isCicodeDocument,
  computeParamBounds,
  getOptionalParamFlags,
} from "../../shared/utils";
import {
  DiagnosticCollector,
  getLintConfig,
} from "../../shared/diagnosticHelpers";

/**
 * Creates and manages diagnostics for Cicode files.
 * Validates function calls, return statements, control flow, and linting rules.
 */
export function makeDiagnostics(
  indexer: Indexer,
  cfg: () => vscode.WorkspaceConfiguration,
): vscode.DiagnosticCollection {
  const coll = vscode.languages.createDiagnosticCollection("cicode");
  let indexingReady = false;

  async function run(doc: vscode.TextDocument) {
    try {
      if (!indexingReady) return;
      if (!isCicodeDocument(doc)) return;

      const text = doc.getText();
      // ignore: spans including function headers (for skipping IF/WHILE in default param values)
      // ignoreNoHeaders: spans excluding function headers (for general comment/string skipping)
      const ignore = buildIgnoreSpans(text);
      const ignoreNoHeaders = buildIgnoreSpans(text, {
        includeFunctionHeaders: false,
      });

      const lintCfg = getLintConfig(cfg);
      const ignoredFuncs = new Set(lintCfg.ignoredFunctions);
      const collector = new DiagnosticCollector(doc);

      // ========================================================================
      // Function call validation
      // ========================================================================
      checkFunctionCalls(text, ignore, ignoredFuncs, indexer, doc, collector);

      // ========================================================================
      // Function definition checks
      // ========================================================================
      checkFunctionDefinitions(indexer, doc, collector);

      // ========================================================================
      // Return statement validation
      // ========================================================================
      checkReturnStatements(text, ignoreNoHeaders, indexer, doc, collector);

      // ========================================================================
      // Control flow keyword validation (IF/THEN, WHILE/DO)
      // ========================================================================
      checkControlFlowKeywords(text, ignore, ignoreNoHeaders, doc, collector);

      // ========================================================================
      // Unused variable detection
      // ========================================================================
      if (lintCfg.warnUnusedVariables) {
        checkUnusedVariables(text, ignoreNoHeaders, indexer, doc, collector);
      }

      // ========================================================================
      // Linting checks
      // ========================================================================
      if (lintCfg.enabled) {
        runLintingChecks(text, ignoreNoHeaders, lintCfg, doc, collector);
      }

      coll.set(doc.uri, collector.getAll());
    } catch (err) {
      console.error("cicode diagnostics failed", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Function call validation
  // ---------------------------------------------------------------------------
  function checkFunctionCalls(
    text: string,
    ignore: Array<[number, number]>,
    ignoredFuncs: Set<string>,
    indexer: Indexer,
    doc: vscode.TextDocument,
    collector: DiagnosticCollector,
  ) {
    const re = /\b([A-Za-z_]\w*)\s*\(/g;
    let m: RegExpExecArray | null;

    while ((m = re.exec(text))) {
      const name = m[1];
      if (
        KEYWORDS_WITH_PAREN.has(name.toUpperCase()) ||
        ignoredFuncs.has(name.toLowerCase())
      ) {
        continue;
      }

      const openAbs = m.index + m[0].lastIndexOf("(");
      if (inSpan(openAbs, ignore)) continue;

      const entry = indexer.getFunction(name);
      if (!entry) {
        const s = doc.positionAt(m.index);
        const e = doc.positionAt(m.index + name.length);
        collector.warning(
          new vscode.Range(s, e),
          `Unknown function '${name}'`,
          { code: "cicode.undefinedFunction" },
        );
        continue;
      }

      const closeAbs = findMatchingParen(text, openAbs, ignore);
      if (closeAbs === -1) continue;

      const provided = countArgsTopLevel(text, openAbs + 1, closeAbs, ignore);
      const { min: minArgs, max: maxArgs } = computeParamBounds(entry.params || []);

      if (provided < minArgs || provided > maxArgs) {
        const s = doc.positionAt(m.index);
        const e = doc.positionAt(closeAbs + 1);
        collector.warning(
          new vscode.Range(s, e),
          `W1004: Incorrect number of arguments for '${entry.name}'. Expected ${minArgs}-${maxArgs}, got ${provided}.`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Function definition checks (duplicates, shadowing, param order)
  // ---------------------------------------------------------------------------
  function checkFunctionDefinitions(
    indexer: Indexer,
    doc: vscode.TextDocument,
    collector: DiagnosticCollector,
  ) {
    const seen = new Set<string>();

    for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
      const key = f.name.toLowerCase();

      // E2021: Duplicate function in same file
      if (seen.has(key)) {
        collector.error(
          f.location.range,
          `E2021: Function '${f.name}' is already defined in this file`,
        );
      } else {
        seen.add(key);
      }

      // W1006: Shadows builtin function
      const builtin = indexer.getAllFunctions().get(key);
      if (builtin?.helpPath) {
        collector.warning(
          f.location.range,
          `W1006: Function '${f.name}' has the same name as a built-in function.`,
        );
      }

      // W1003: Optional param before required param
      const header = indexer.getFunction(f.name);
      const params = header?.params?.length
        ? header.params
        : (f.paramsRaw || "").split(",").map((s) => s.trim()).filter(Boolean);

      if (params.length) {
        const optFlags = getOptionalParamFlags(params);
        let foundOptional = false;
        let hasOrderError = false;

        for (const isOpt of optFlags) {
          if (isOpt) foundOptional = true;
          else if (foundOptional) {
            hasOrderError = true;
            break;
          }
        }

        if (hasOrderError) {
          collector.warning(
            f.location.range,
            "W1003: Argument with default/optional found before a required argument.",
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Return statement validation
  // ---------------------------------------------------------------------------
  function checkReturnStatements(
    text: string,
    ignoreNoHeaders: Array<[number, number]>,
    indexer: Indexer,
    doc: vscode.TextDocument,
    collector: DiagnosticCollector,
  ) {
    for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
      const cachedFunc = indexer.getFunction(f.name);
      const returnType = (
        f.returnType || cachedFunc?.returnType || "VOID"
      ).toUpperCase();

      const bodyStartAbs = doc.offsetAt(f.bodyRange.start);
      const bodyEndAbs = doc.offsetAt(f.bodyRange.end);
      const body = text.slice(bodyStartAbs, bodyEndAbs);

      let hasReturnWithValue = false;
      const retRe = /\bRETURN\b/gi;
      let m: RegExpExecArray | null;

      while ((m = retRe.exec(body))) {
        const retAbs = bodyStartAbs + m.index;
        if (inSpan(retAbs, ignoreNoHeaders)) continue;

        // Extract rest of line after RETURN, strip comments
        const fullLineEnd = body.indexOf("\n", m.index);
        const end = fullLineEnd === -1 ? body.length : fullLineEnd;
        const rawLine = body.slice(m.index, end);

        const after = rawLine
          .replace(/\/\/.*$/, "")
          .replace(/!.*$/, "")
          .replace(/\bRETURN\b/i, "")
          .replace(/;/g, "")
          .trim();

        // Check if RETURN has a value (not just a control keyword like END)
        const hasValue =
          after.length > 0 &&
          !CONTROL_KEYWORDS.has(after.split(/\s+/)[0].toUpperCase());

        if (hasValue) {
          hasReturnWithValue = true;

          // E2036: Cannot return value from void function
          if (returnType === "VOID") {
            const pos = doc.positionAt(retAbs);
            collector.error(
              new vscode.Range(pos, pos.translate(0, 6)),
              "E2036: Cannot return value from void function.",
            );
          }
        }
      }

      // E2037: Non-void function must return a value
      if (returnType !== "VOID" && !hasReturnWithValue) {
        collector.error(
          f.location.range,
          `E2037: Function '${f.name}' must return a value.`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Control flow keyword validation
  // ---------------------------------------------------------------------------
  function checkControlFlowKeywords(
    text: string,
    ignore: Array<[number, number]>,
    ignoreNoHeaders: Array<[number, number]>,
    doc: vscode.TextDocument,
    collector: DiagnosticCollector,
  ) {
    /**
     * Searches for a keyword (THEN/DO) after a control statement (IF/WHILE).
     * Handles parentheses for multi-line conditions and stops at statement boundaries.
     */
    const findKeywordAfter = (
      startPos: number,
      keyword: string,
      maxRange: number,
    ): boolean => {
      let searchPos = startPos;
      let parenDepth = 0;
      const maxSearch = Math.min(startPos + maxRange, text.length);
      const keywordLen = keyword.length;
      const keywordRe = new RegExp(`^${keyword}\\b`, "i");

      while (searchPos < maxSearch) {
        // Skip positions inside comments/strings
        if (inSpan(searchPos, ignoreNoHeaders)) {
          searchPos++;
          continue;
        }

        const ch = text[searchPos];

        // Track parenthesis depth for multi-line conditions
        if (ch === "(") {
          parenDepth++;
          searchPos++;
          continue;
        } else if (ch === ")") {
          parenDepth--;
          searchPos++;
          continue;
        }

        // Only check for keywords when outside parentheses and at word boundary
        if (parenDepth === 0) {
          const prevChar = searchPos > 0 ? text[searchPos - 1] : " ";
          const isWordBoundary = !/[A-Za-z0-9_]/.test(prevChar);

          if (isWordBoundary) {
            const slice = text.slice(searchPos, searchPos + keywordLen + 1);
            if (keywordRe.test(slice)) {
              return true;
            }
            // Stop at statement boundaries - if we hit these before finding our keyword,
            // the original statement is malformed. Includes IF/WHILE because hitting
            // a nested control statement means we missed the THEN/DO for the outer one.
            const boundarySlice = text.slice(searchPos, searchPos + 10);
            if (/^(END|FUNCTION|IF|WHILE|FOR|SELECT)\b/i.test(boundarySlice)) {
              return false;
            }
          }
        }
        searchPos++;
      }
      return false;
    };

    // E2032: IF requires THEN
    const ifRe = /\bIF\b/gi;
    let ifMatch: RegExpExecArray | null;
    while ((ifMatch = ifRe.exec(text))) {
      if (inSpan(ifMatch.index, ignoreNoHeaders)) continue;
      // Skip IF inside function headers (e.g., default param values)
      if (inSpan(ifMatch.index, ignore)) continue;

      if (!findKeywordAfter(ifMatch.index + 2, "THEN", 10000)) {
        const pos = doc.positionAt(ifMatch.index);
        collector.error(
          new vscode.Range(pos, pos.translate(0, 2)),
          "E2032: IF statement requires THEN keyword.",
        );
      }
    }

    // E2033: WHILE requires DO
    const whileRe = /\bWHILE\b/gi;
    let whileMatch: RegExpExecArray | null;
    while ((whileMatch = whileRe.exec(text))) {
      if (inSpan(whileMatch.index, ignoreNoHeaders)) continue;
      if (inSpan(whileMatch.index, ignore)) continue;

      if (!findKeywordAfter(whileMatch.index + 5, "DO", 10000)) {
        const pos = doc.positionAt(whileMatch.index);
        collector.error(
          new vscode.Range(pos, pos.translate(0, 5)),
          "E2033: WHILE statement requires DO keyword.",
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Unused variable detection
  // ---------------------------------------------------------------------------
  function checkUnusedVariables(
    text: string,
    ignoreNoHeaders: Array<[number, number]>,
    indexer: Indexer,
    doc: vscode.TextDocument,
    collector: DiagnosticCollector,
  ) {
    for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
      const bodyStartAbs = doc.offsetAt(f.bodyRange.start);
      const bodyEndAbs = doc.offsetAt(f.bodyRange.end);
      const body = text.slice(bodyStartAbs, bodyEndAbs);

      const scopeId = indexer.localScopeId(doc.uri.fsPath, f.name);
      const localVars = indexer.getVariablesByPredicate(
        (v) => v.scopeType === "local" && v.scopeId === scopeId && !v.isParam,
      );

      for (const v of localVars) {
        const safe = escapeRegExp(v.name);
        const nameRe = new RegExp(`\\b${safe}\\b`, "gi");
        let count = 0;
        let m: RegExpExecArray | null;

        while ((m = nameRe.exec(body))) {
          const pos = bodyStartAbs + m.index;
          if (!inSpan(pos, ignoreNoHeaders)) count++;
        }

        // Variable appears only once (declaration) = unused
        if (count <= 1) {
          collector.hint(
            v.location.range,
            `Variable '${v.name}' is declared but never used.`,
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Linting checks
  // ---------------------------------------------------------------------------
  function runLintingChecks(
    text: string,
    ignoreNoHeaders: Array<[number, number]>,
    lintCfg: ReturnType<typeof getLintConfig>,
    doc: vscode.TextDocument,
    collector: DiagnosticCollector,
  ) {
    for (let i = 0; i < doc.lineCount; i++) {
      const L = doc.lineAt(i);
      const s = L.text;
      const trimmed = s.trim();
      const isComment = /^\s*(\/\/|!)/.test(trimmed);

      // Line length check
      if (!isComment && lintCfg.maxLineLength > 0 && s.length > lintCfg.maxLineLength) {
        collector.hint(
          new vscode.Range(L.range.start, L.range.end),
          `Line exceeds ${lintCfg.maxLineLength} chars (${s.length}).`,
        );
      }

      // Mixed indentation check
      const leading = s.match(/^\s*/)?.[0] || "";
      if (lintCfg.warnMixedIndent && /^(?=.*\t)(?=.* )/.test(leading)) {
        collector.hint(
          new vscode.Range(
            new vscode.Position(i, 0),
            new vscode.Position(i, leading.length),
          ),
          "Mixed indentation (tabs and spaces).",
        );
      }

      // Missing semicolon on declarations
      if (lintCfg.warnMissingSemicolons && !isComment) {
        if (/^\s*((?:GLOBAL|MODULE)\s+)?(\w+)\s+\w+(\s*,\s*\w+)*\s*$/i.test(s)) {
          const typeWord = /^\s*(?:(?:GLOBAL|MODULE)\s+)?(\w+)/i.exec(s)?.[1] || "";
          if (TYPE_RE.test(typeWord) && !/;\s*(\/\/|!|$)/.test(s)) {
            collector.info(
              new vscode.Range(L.range.start, L.range.end),
              "Consider ending declarations with a semicolon.",
            );
          }
        }
      }

      // Keyword case check
      if (lintCfg.warnKeywordCase && !isComment) {
        const m = s.match(
          /\b(if|then|else|for|while|end|select|case|return|function|global|module)\b/,
        );
        if (m && m[0] !== m[0].toUpperCase()) {
          const idx = m.index || 0;
          collector.hint(
            new vscode.Range(
              new vscode.Position(i, idx),
              new vscode.Position(i, idx + m[0].length),
            ),
            `Prefer UPPERCASE keyword '${m[0].toUpperCase()}'.`,
          );
        }
      }

      // Magic numbers check
      if (lintCfg.warnMagicNumbers && !isComment) {
        // Skip declaration lines - they're giving numbers meaningful names
        const isDeclarationLine =
          /^\s*(?:(?:GLOBAL|MODULE)\s+)?(?:INT|REAL|STRING|LONG|ULONG|BOOLEAN|OBJECT|QUALITY|TIMESTAMP)\s+\w+/i.test(s);

        if (!isDeclarationLine) {
          const numRe = /\b(\d+(?:\.\d+)?)\b/g;
          let m: RegExpExecArray | null;
          while ((m = numRe.exec(s))) {
            const num = parseFloat(m[1]);
            const absPos = doc.offsetAt(new vscode.Position(i, m.index));

            // Skip array indices like [0], [1], etc.
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
              collector.hint(
                new vscode.Range(start, end),
                `Consider using a named constant instead of magic number '${m[1]}'.`,
              );
            }
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Event subscriptions
  // ---------------------------------------------------------------------------
  indexer.onIndexed(() => {
    indexingReady = true;
    // Run diagnostics on all open cicode documents
    for (const doc of vscode.workspace.textDocuments) {
      if (isCicodeDocument(doc)) {
        run(doc);
      }
    }
  });

  const subs: vscode.Disposable[] = [];
  subs.push(vscode.workspace.onDidOpenTextDocument(run));
  subs.push(vscode.workspace.onDidSaveTextDocument(run));
  subs.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) run(editor.document);
  }));

  // Return composite disposable with collection methods for compatibility
  return {
    dispose: () => {
      coll.dispose();
      subs.forEach((s) => s.dispose());
    },
    set: coll.set.bind(coll),
    delete: coll.delete.bind(coll),
    clear: coll.clear.bind(coll),
    forEach: coll.forEach.bind(coll),
    get: coll.get.bind(coll),
    has: coll.has.bind(coll),
    name: coll.name,
  } as vscode.DiagnosticCollection;
}
