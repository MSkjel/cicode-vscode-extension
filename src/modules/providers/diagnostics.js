const vscode = require('vscode');
const { buildIgnoreSpans, inSpan, TYPE_RE } = require('../../modules/textUtils');

function makeDiagnostics(indexer, cfg) {
  const coll = vscode.languages.createDiagnosticCollection('cicode');

  const run = async (doc) => {
    try {
      if (doc.languageId !== 'cicode' && !doc.uri.fsPath.toLowerCase().endsWith('.ci')) return;

      const text = doc.getText();
      const out = [];

      // --------------------------------
      // Existing checks
      // --------------------------------
      const ignore = buildIgnoreSpans(text);

      // unknown functions
      const callRe = /\b([A-Za-z_]\w*)\s*\(/g; let m;
      while ((m = callRe.exec(text))) {
        const name = m[1];
        const paren = m.index + m[0].indexOf('(');
        if (inSpan(paren, ignore)) continue;
        if (!indexer.hasFunction(name)) {
          const s = doc.positionAt(m.index); const e = doc.positionAt(m.index + name.length);
          const d = new vscode.Diagnostic(new vscode.Range(s, e), `Unknown function '${name}'`, vscode.DiagnosticSeverity.Warning);
          d.code = 'cicode.undefinedFunction'; d.source = 'cicode'; out.push(d);
        }
      }

      // duplicates in this file
      const seen = new Map();
      for (const f of indexer.getFunctionRanges(doc.uri.fsPath)) {
        const key = f.name.toLowerCase();
        if (seen.has(key)) {
          const d = new vscode.Diagnostic(f.location.range, `Duplicate function '${f.name}' in this file`, vscode.DiagnosticSeverity.Information);
          d.code = 'cicode.duplicateFunction'; out.push(d);
        } else seen.set(key, true);
      }

      // --------------------------------
      // Best-practice lints
      // --------------------------------
      if (cfg().get('cicode.lint.enable', true)) {
        const maxLen = cfg().get('cicode.lint.maxLineLength', 140) || 0;
        const warnTabs = cfg().get('cicode.lint.warnTabs', true);
        const warnMixed = cfg().get('cicode.lint.warnMixedIndent', true);
        const warnSemi = cfg().get('cicode.lint.warnMissingSemicolons', true);
        const warnKwCase = cfg().get('cicode.lint.warnKeywordCase', false);

        for (let i = 0; i < doc.lineCount; i++) {
          const l = doc.lineAt(i);
          const s = l.text;

          // ignore blank and full-line comment lines for most checks
          const trimmed = s.trim();
          const isComment = /^\s*(\/\/|!)/.test(trimmed);

          // max length
          if (!isComment && maxLen > 0 && s.length > maxLen) {
            out.push(new vscode.Diagnostic(
              new vscode.Range(l.range.start, l.range.end),
              `Line exceeds ${maxLen} chars (${s.length}).`,
              vscode.DiagnosticSeverity.Hint
            ));
          }

          // tabs / mixed indent (only at start)
          const leading = s.match(/^\s*/)?.[0] || '';
          if (warnTabs && /^\t+/.test(leading)) {
            out.push(new vscode.Diagnostic(
              new vscode.Range(new vscode.Position(i, 0), new vscode.Position(i, leading.length)),
              'Use spaces (4) for indentation (tabs found).',
              vscode.DiagnosticSeverity.Hint
            ));
          }
          if (warnMixed && /^(?=.*\t)(?=.* )/.test(leading)) {
            out.push(new vscode.Diagnostic(
              new vscode.Range(new vscode.Position(i, 0), new vscode.Position(i, leading.length)),
              'Mixed indentation (tabs and spaces).',
              vscode.DiagnosticSeverity.Hint
            ));
          }

          // missing semicolon after type declarations (informational)
          if (warnSemi && !isComment) {
            // Only outside functions OR at the top of a function body. Quick check:
            if (/^\s*(GLOBAL\s+)?(\w+)\s+\w+(\s*,\s*\w+)*\s*$/i.test(s)) {
              const typeWord = /^\s*(?:GLOBAL\s+)?(\w+)/i.exec(s)?.[1] || '';
              if (TYPE_RE.test(typeWord) && !/;\s*(\/\/|!|$)/.test(s)) {
                out.push(new vscode.Diagnostic(
                  new vscode.Range(l.range.start, l.range.end),
                  'Consider ending declarations with a semicolon.',
                  vscode.DiagnosticSeverity.Information
                ));
              }
            }
          }

          // keyword casing (suggestion only)
          if (warnKwCase && !isComment) {
            // simple common keywords; we won’t touch inside strings/comments
            const m = s.match(/\b(if|then|else|for|while|end|select|case|return|function|global|module)\b/);
            if (m && m[0] !== m[0].toUpperCase()) {
              const idx = m.index || 0;
              out.push(new vscode.Diagnostic(
                new vscode.Range(new vscode.Position(i, idx), new vscode.Position(i, idx + m[0].length)),
                `Prefer UPPERCASE keyword '${m[0].toUpperCase()}'.`,
                vscode.DiagnosticSeverity.Hint
              ));
            }
          }
        }
      }

      coll.set(doc.uri, out);
    } catch (e) { console.error('diagnostics fail', e); }
  };

  indexer.onIndexed(() => { const ed = vscode.window.activeTextEditor; if (ed) run(ed.document); });
  vscode.workspace.onDidOpenTextDocument(run);
  vscode.workspace.onDidChangeTextDocument(e => run(e.document));
  return coll;
}

module.exports = { makeDiagnostics };
