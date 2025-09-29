const vscode = require('vscode');

/**
 * Cicode formatter (best-practices, conservative)
 * - Openers (indent AFTER): FUNCTION, IF, FOR, WHILE, TRY, REPEAT, SELECT CASE
 * - Closers (dedent BEFORE): END, END SELECT
 * - Middles (same indent as body): ELSE, CASE, EXCEPT, FINALLY
 * - Inside ANY (...) region (headers or calls), we DO NOT rewrite spacing
 *   and PRESERVE indentation for continuation lines.
 * - Strip trailing whitespace; collapse blank lines (config); ensure final newline.
 * - Optionally convert leading tabs to 4 spaces (outside parentheses).
 * - Normalize spaces outside parentheses only: around '=' and ','.
 */
function makeFormatter(cfg) {
  const OPENERS = [
    /^\s*(\w+\s+)?function\b/i,
    /^\s*if\b/i,
    /^\s*for\b/i,
    /^\s*while\b/i,
    /^\s*try\b/i,
    /^\s*repeat\b/i,
    /^\s*select\s+case\b/i,
  ];
  const CLOSERS = [/^\s*end\s+select\b/i, /^\s*end\b/i];
  const MIDDLES = [/^\s*else\b/i, /^\s*case\b/i, /^\s*except\b/i, /^\s*finally\b/i];

  const isAny = (line, patterns) => patterns.some(re => re.test(line));

  function parenDelta(line) {
    const parts = line.split(/(".*?(?<!\\)"|'.*?(?<!\\)')/);
    let opens = 0, closes = 0;
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) continue;
      const seg = parts[i];
      opens += (seg.match(/\(/g) || []).length;
      closes += (seg.match(/\)/g) || []).length;
    }
    return opens - closes;
  }

  function normalizeOutsideParens(line) {
    if (!/[=,]/.test(line)) return line;
    return line
      .split(/(".*?(?<!\\)"|'.*?(?<!\\)')/)
      .map((seg, idx) => {
        if (idx % 2 === 1) return seg;
        const chunks = [];
        let buf = ''; let depth = 0;
        for (let i = 0; i < seg.length; i++) {
          const c = seg[i];
          if (c === '(') { if (depth === 0 && buf) { chunks.push({ type: 'code', text: buf }); buf = ''; } depth++; buf += c; }
          else if (c === ')') { buf += c; depth = Math.max(0, depth - 1); if (depth === 0) { chunks.push({ type: 'paren', text: buf }); buf = ''; } }
          else buf += c;
        }
        if (buf) chunks.push({ type: depth > 0 ? 'paren' : 'code', text: buf });
        return chunks.map(ch =>
          ch.type === 'paren' ? ch.text
            : ch.text.replace(/\s*=\s*/g, ' = ').replace(/\s*,\s*/g, ', ')
        ).join('');
      })
      .join('');
  }

  return {
    provideDocumentFormattingEdits(doc) {
      if (!cfg().get('cicode.format.enable', true)) return [];

      const maxBlank = Math.max(0, cfg().get('cicode.format.maxConsecutiveBlankLines', 1));
      const convertTabs = !!cfg().get('cicode.format.convertTabs', false);

      const start = new vscode.Position(0, 0);
      const end = doc.lineAt(doc.lineCount - 1).range.end;

      const out = [];
      let depth = 0;
      let parenBalance = 0;
      let blankCount = 0;

      for (let i = 0; i < doc.lineCount; i++) {
        let raw = doc.lineAt(i).text;
        // strip trailing whitespace always
        let line = raw.replace(/\s+$/, '');
        const trimmed = line.trim();

        // track parens before any changes
        const delta = parenDelta(line);

        // blank-line collapse (outside parens only)
        if (trimmed.length === 0 && parenBalance === 0) {
          blankCount++;
          if (blankCount <= maxBlank) out.push('');
          // do not change depth/parenBalance here
          continue;
        } else {
          blankCount = 0;
        }

        // Full-line comments: outside parens, re-indent to depth; inside parens, preserve
        if (/^\s*(\/\/|!)/.test(trimmed)) {
          if (parenBalance > 0) {
            out.push(line);
          } else {
            let base = '    '.repeat(depth);
            let body = trimmed;
            if (convertTabs) base = base.replace(/\t/g, '    ');
            out.push(base + body);
          }
          parenBalance += delta;
          continue;
        }

        // Inside a multi-line (...) block -> preserve exactly
        if (parenBalance > 0) {
          out.push(line);
          parenBalance += delta;
          continue;
        }

        // Dedent for closers BEFORE writing this line
        if (isAny(trimmed, CLOSERS)) depth = Math.max(0, depth - 1);

        // Middlers aligned with body (depth-1)
        const isMiddle = isAny(trimmed, MIDDLES);
        const baseDepth = isMiddle ? Math.max(0, depth - 1) : depth;

        // Normalize outside parens only
        let normalized = normalizeOutsideParens(line).trim();

        // Convert leading tabs (optional) – outside parens only
        let indent = '    '.repeat(baseDepth);
        if (convertTabs) indent = indent.replace(/\t/g, '    ');

        const rebuilt = normalized.length ? (indent + normalized) : '';
        out.push(rebuilt);

        // Openers increase depth AFTER line
        if (isAny(trimmed, OPENERS)) depth++;

        // If this line starts a multi-line paren block, preserve the following lines
        if (delta > 0) parenBalance += delta;
      }

      // ensure single final newline
      if (out.length === 0 || out[out.length - 1] !== '') out.push('');

      return [vscode.TextEdit.replace(new vscode.Range(start, end), out.join('\n'))];
    }
  };
}

module.exports = { makeFormatter };
