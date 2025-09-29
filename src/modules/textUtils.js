// Tiny text/lex helpers reused across providers + indexer.

/** Strip // line comments (not string-aware; use spans for accuracy when needed). */
function stripLineComments(s) {
  return s.replace(/\/\/.*$/gm, '');
}

/** Strip /* block comments *\/ */
function stripBlockComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Strip "double" and 'single' quoted strings with escapes. */
function stripStrings(s) {
  return s.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '');
}

/** Strip function header lines (FUNCTION foo(...) up to the closing ')'). */
function stripFunctionHeaders(s) {
  return s.replace(/(^|\n)\s*(\w+\s+)?function\s+\w+\s*\([^)]*\)/gim, '');
}

/** Build ignore spans for comments, strings, and function headers. */
function buildIgnoreSpans(text) {
  const spans = [];
  const pushAll = (re) => { let m; while ((m = re.exec(text))) spans.push([m.index, m.index + m[0].length]); };

  // // line comments
  pushAll(/\/\/.*$/gm);
  // /* block comments */
  pushAll(/\/\*[\s\S]*?\*\//g);
  // strings
  pushAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g);

  // function headers (start after the newline group)
  {
    const re = /(^|\n)\s*(\w+\s+)?function\s+\w+\s*\([^)]*\)/gim;
    let m;
    while ((m = re.exec(text))) {
      const start = m.index + (m[1] ? m[1].length : 0);
      spans.push([start, m.index + m[0].length]);
    }
  }

  // Merge overlaps
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of spans) {
    if (!merged.length || s > merged[merged.length - 1][1]) merged.push([s, e]);
    else merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
  }
  return merged;
}

/** Check if position is within any span. */
function inSpan(pos, spans) {
  for (const [s, e] of spans) {
    if (pos >= s && pos < e) return true;
    if (pos < s) break;
  }
  return false;
}

/** Known Cicode base types (for declaration recognition). */
const TYPE_RE = /^(INT|REAL|STRING|OBJECT|BOOL|BOOLEAN|LONG|ULONG|UNKNOWN)$/i;

/** Clean a param token from signature into a user label (handles [optional], defaults, types). */
function cleanParamName(param) {
  let p = String(param || '').trim();
  p = p.replace(/[\[\]]/g, ' ').trim();                 // [ ] out
  p = p.replace(/\s*=\s*[^,)]*$/, '').trim();            // defaults
  p = p.replace(/^(GLOBAL|LOCAL|CONST)\s+/i, '');       // qualifiers
  p = p.replace(/^(INT|REAL|STRING|OBJECT|BOOL|BOOLEAN|LONG|ULONG|UNKNOWN)\s+/i, '');
  p = p.replace(/:\s*(INT|REAL|STRING|OBJECT|BOOL|BOOLEAN|LONG|ULONG|UNKNOWN)\b/i, '');
  p = p.replace(/:$/, '');
  p = p.replace(/\s+/g, ' ').trim();
  const m = p.match(/^[A-Za-z_]\w*/);
  return m ? m[0] : p || '?';
}

/** Detect call-site named arguments like Name: expr */
function argLooksNamed(argText) {
  return /^\s*[A-Za-z_]\w*\s*:\s*/.test(argText);
}

/** Split declaration variable names and drop initializers. */
function splitDeclNames(namesPart) {
  return namesPart
    .split(',')
    .map(s => s.trim())
    .map(s => s.replace(/\s*=\s*.+$/, ''))
    .filter(Boolean);
}

module.exports = {
  stripLineComments,
  stripBlockComments,
  stripStrings,
  stripFunctionHeaders,
  buildIgnoreSpans,
  inSpan,
  TYPE_RE,
  cleanParamName,
  argLooksNamed,
  splitDeclNames,
};
