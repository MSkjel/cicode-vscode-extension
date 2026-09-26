import * as vscode from "vscode";
import {
  CICODE_TYPES_PATTERN,
  NAME_CHARS,
  NAME_PATTERN,
  NAME_START_CHARS,
} from "./constants";

const _CLEAN_PARAM_TYPE_PREFIX = new RegExp(
  `^(${CICODE_TYPES_PATTERN}|UNKNOWN)\\s+`,
  "i",
);
const _CLEAN_PARAM_TYPE_SUFFIX = new RegExp(
  `:\\s*(${CICODE_TYPES_PATTERN}|UNKNOWN)\\b`,
  "i",
);

export const TYPE_RE = new RegExp(`^(${CICODE_TYPES_PATTERN}|UNKNOWN)$`, "i");

// =============================================================================
// Lexical rules of the compiler (also the basis of core/indexer/lexer.ts)
// =============================================================================

/** Reserved words that are operators, the only ones an expression can hold. */
export const OPERATOR_WORDS = new Set([
  "NOT",
  "AND",
  "OR",
  "MOD",
  "BITAND",
  "BITOR",
  "BITXOR",
]);

const _NAME_START_RE = new RegExp(`[${NAME_START_CHARS}]`);
const _NAME_CHAR_RE = new RegExp(`[${NAME_CHARS}]`);

/** True if `c` can start a name: a letter or '_'. The compiler reads source
 *  as cp1252, so letters such as æ, ø, é and Š count too. */
export function isNameStart(c: string | undefined): boolean {
  if (!c) return false;
  const k = c.charCodeAt(0);
  if (k < 0x80)
    return (k >= 0x61 && k <= 0x7a) || (k >= 0x41 && k <= 0x5a) || k === 0x5f;
  return _NAME_START_RE.test(c[0]);
}

/** True if `c` can continue a name: a name start, a digit, ¹ ² ³ or '\'. */
export function isNameChar(c: string | undefined): boolean {
  if (!c) return false;
  const k = c.charCodeAt(0);
  if (k < 0x80) return (k >= 0x30 && k <= 0x39) || k === 0x5c || isNameStart(c);
  return _NAME_CHAR_RE.test(c[0]);
}

const _NON_ASCII_RE = /[^\x00-\x7f]/;

/** Lookup key of a name. Names compare case-insensitively in ASCII letters
 *  only: `Æ` and `æ`, or `Š` and `š`, make different names. */
export function nameKey(name: string): string {
  return _NON_ASCII_RE.test(name)
    ? name.replace(/[A-Z]+/g, (m) => m.toLowerCase())
    : name.toLowerCase();
}

/** `s` with its ASCII letters upper-cased (see nameKey). */
export function upperAscii(s: string): string {
  return _NON_ASCII_RE.test(s)
    ? s.replace(/[a-z]+/g, (m) => m.toUpperCase())
    : s.toUpperCase();
}

/** C isspace(): the whitespace the lexer skips between tokens. */
export function isSpace(c: string | undefined): boolean {
  return (
    c === " " ||
    c === "\t" ||
    c === "\n" ||
    c === "\r" ||
    c === "\v" ||
    c === "\f"
  );
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

/** End of the number token starting at the digit at `i`. Leading zeros are
 *  skipped; digits followed by '.', 'e' or 'E' make a real (`1.`, `1e`,
 *  `1.5e-3`); 'b', 'o' or 'x' switch to binary, octal or hex digits that
 *  start one character after the leading zeros. A name may follow directly
 *  (`0x1FZz`, and `12b` lexes as `1`, `2`, `b`). */
export function numberEnd(s: string, i: number): number {
  let p = i;
  while (s[p] === "0") p++;
  const first = p;
  while (isDigit(s[p])) p++;
  const c = s[p];
  if (c === "." || c === "e" || c === "E") {
    if (s[p] === ".") {
      p++;
      while (isDigit(s[p])) p++;
    }
    if (s[p] === "e" || s[p] === "E") {
      p++;
      if (s[p] === "+" || s[p] === "-") p++;
      while (isDigit(s[p])) p++;
    }
    return p;
  }
  const radix =
    c === "b" || c === "B"
      ? /[01]/
      : c === "o" || c === "O"
        ? /[0-7]/
        : c === "x" || c === "X"
          ? /[0-9A-Fa-f]/
          : null;
  if (!radix) return p;
  p = first + 1;
  while (p < s.length && radix.test(s[p])) p++;
  return p;
}

/** End of the format picture token at the '#' at `i`: '#', '0' and '-'
 *  repeat; then '!' (which ends it), or '.' or a lower-case 's' followed by
 *  '#'s; then "EU" or "engunit" in any case, also after whitespace or a line
 *  break (`:###EUx` lexes as the picture and a name `x`). */
function formatPictureEnd(text: string, i: number, n: number): number {
  let j = i;
  while (j < n && (text[j] === "#" || text[j] === "0" || text[j] === "-")) j++;
  if (j < n && text[j] === "!") return j + 1;
  if (j < n && (text[j] === "." || text[j] === "s")) {
    j++;
    while (j < n && text[j] === "#") j++;
  }
  let k = j;
  while (k < n && isSpace(text[k])) k++;
  const w = text.slice(k, Math.min(k + 7, n)).toLowerCase();
  if (w.startsWith("eu")) return k + 2;
  if (w === "engunit") return k + 7;
  return j;
}

const _SPAN_START_RE = /["!/|#]/g;

// Spans the lexer reads as something other than names, numbers and
// operators, in order and never overlapping:
// - comments: `!` or `//` to the end of the line, `/*` to the first `*/`
//   (no nesting, so `/**/` is complete and `/* a **/` closes at `**/`);
// - strings: `"` to the next unescaped `"`, across lines; `^` escapes the
//   next character, a closing quote or a line break included;
// - `|...|` tokens (no escapes, may cross lines; never valid in code, but
//   their content is not lexed);
// - `#` format pictures (see formatPictureEnd);
// - everything from a NUL or Ctrl-Z, where the compiler's input ends.
// An unterminated comment, string or `|` runs to the end.
/** Uncached ignore spans of `text` (buildIgnoreSpans without function
 *  headers), for fragments that should not evict the document's memo. */
export function scanIgnoreSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const eof = text.search(/[\0\x1a]/);
  const n = eof === -1 ? text.length : eof;

  let i = 0;
  while (i < n) {
    _SPAN_START_RE.lastIndex = i;
    const m = _SPAN_START_RE.exec(text);
    if (!m || m.index >= n) break;
    const start = m.index;
    const ch = m[0];
    i = start + 1;

    if (ch === '"') {
      while (i < n) {
        const c = text[i++];
        if (c === "^") i++;
        else if (c === '"') break;
      }
      i = Math.min(i, n);
    } else if (ch === "!" || (ch === "/" && text[i] === "/")) {
      const nl = text.indexOf("\n", i);
      i = nl === -1 || nl > n ? n : nl;
    } else if (ch === "/" && text[i] === "*") {
      const close = text.indexOf("*/", i + 1);
      i = close === -1 || close >= n ? n : close + 2;
    } else if (ch === "|") {
      const close = text.indexOf("|", i);
      i = close === -1 || close >= n ? n : close + 1;
    } else if (ch === "#") {
      i = formatPictureEnd(text, start, n);
    } else {
      continue; // a lone '/'
    }
    spans.push([start, i]);
  }
  if (eof !== -1) spans.push([eof, text.length]);
  return spans;
}

/** True if the ignore span starting at `pos` is a comment, which the
 *  compiler treats as whitespace (other spans are tokens). */
export function isCommentStart(text: string, pos: number): boolean {
  const c = text[pos];
  return (
    c === "!" || (c === "/" && (text[pos + 1] === "/" || text[pos + 1] === "*"))
  );
}

/** True if the character before `position` is inside a comment, a string, a
 *  `|...|` token or a format picture. */
export function isInCommentOrString(
  document: vscode.TextDocument,
  position: vscode.Position,
): boolean {
  const offset = document.offsetAt(position);
  if (offset === 0) return false;
  // Scan the full document: a fixed lookback window misses /* */ blocks
  // opened before the window start. buildIgnoreSpans memoizes only the most
  // recent text per flag (any other caller evicts it), so this is a linear
  // scan per call unless another provider just scanned the same text.
  const spans = buildIgnoreSpans(document.getText(), {
    includeFunctionHeaders: false,
  });
  return inSpan(offset - 1, spans);
}

/** Strip a trailing line comment (`//` or `!` outside strings, block
 *  comments, `|...|` tokens and format pictures) and trailing whitespace. */
export function stripLineComment(line: string): string {
  for (const [s] of scanIgnoreSpans(line)) {
    if (line[s] === "!" || (line[s] === "/" && line[s + 1] === "/")) {
      return line.slice(0, s).trimEnd();
    }
  }
  return line.trimEnd();
}

/** Sorts spans and merges overlapping ones. Spans that only touch stay
 *  separate, so each keeps its kind (see isCommentStart). */
export function mergeSpans(
  spans: Array<[number, number]>,
): Array<[number, number]> {
  if (!spans.length) return [];
  spans.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of spans) {
    if (!out.length || s >= out[out.length - 1][1]) out.push([s, e]);
    else out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
  }
  return out;
}

export function inSpan(pos: number, spans: Array<[number, number]>): boolean {
  return spanEndAt(pos, spans) !== -1;
}

/** End of the span containing `pos`, or -1. */
function spanEndAt(pos: number, spans: Array<[number, number]>): number {
  let lo = 0,
    hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [s, e] = spans[mid];
    if (pos >= s && pos < e) return e;
    if (pos < s) hi = mid - 1;
    else lo = mid + 1;
  }
  return -1;
}

/** Single-slot memo per includeFunctionHeaders flag: holds only the most
 *  recently scanned text, so any call with different text evicts it. */
const _spanCache = new Map<
  boolean,
  { text: string; spans: Array<[number, number]> }
>();

const _HEADER_PREFIX_RE = new RegExp(
  `^(?:PRIVATE|PUBLIC|GLOBAL|MODULE|${CICODE_TYPES_PATTERN})$`,
  "i",
);
const _FUNCTION_RE = /function/gi;

/** Offset of the first token at or after `pos` (which must not be inside a
 *  string): whitespace and comments are skipped. */
export function skipBlank(text: string, pos: number): number {
  for (;;) {
    while (pos < text.length && isSpace(text[pos])) pos++;
    let end = -1;
    if (text[pos] === "!" || (text[pos] === "/" && text[pos + 1] === "/")) {
      end = text.indexOf("\n", pos);
    } else if (text[pos] === "/" && text[pos + 1] === "*") {
      end = text.indexOf("*/", pos + 2);
      if (end !== -1) end += 2;
    } else {
      return pos;
    }
    if (end === -1) return text.length;
    pos = end;
  }
}

/** Returns only the function-header spans (not comments/strings): from the
 *  scope and type words before FUNCTION to the closing paren of the
 *  parameter list, or to the end of the name when there is no list.
 *  Comments may sit between the tokens. */
export function buildHeaderSpans(
  text: string,
  base: Array<[number, number]>,
): Array<[number, number]> {
  const extra: Array<[number, number]> = [];
  let lastEnd = 0;
  _FUNCTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = _FUNCTION_RE.exec(text))) {
    const at = m.index;
    const after = at + m[0].length;
    if (
      at < lastEnd ||
      isNameChar(text[at - 1]) ||
      text[at - 1] === "." ||
      isNameChar(text[after]) ||
      inSpan(at, base)
    )
      continue;

    let start = at;
    for (;;) {
      let p = start;
      while (p > lastEnd && isSpace(text[p - 1])) p--;
      let q = p;
      while (q > lastEnd && isNameChar(text[q - 1])) q--;
      if (
        q === p ||
        inSpan(q, base) ||
        !_HEADER_PREFIX_RE.test(text.slice(q, p))
      )
        break;
      start = q;
    }

    let pos = skipBlank(text, after);
    if (!isNameStart(text[pos])) continue;
    while (pos < text.length && isNameChar(text[pos])) pos++;
    let end = pos;

    pos = skipBlank(text, pos);
    if (text[pos] === "(") {
      let depth = 1;
      pos++;
      while (pos < text.length && depth > 0) {
        const e = spanEndAt(pos, base);
        if (e !== -1) {
          pos = e;
          continue;
        }
        if (text[pos] === "(") depth++;
        else if (text[pos] === ")") depth--;
        pos++;
      }
      if (depth !== 0) continue;
      end = pos;
    }

    extra.push([start, end]);
    lastEnd = end;
  }
  return extra;
}

function _addFunctionHeaderSpans(
  text: string,
  base: Array<[number, number]>,
): Array<[number, number]> {
  return mergeSpans([...base, ...buildHeaderSpans(text, base)]);
}

export function buildIgnoreSpans(
  text: string,
  opts: { includeFunctionHeaders?: boolean } = {},
): Array<[number, number]> {
  const { includeFunctionHeaders = true } = opts;

  const cached = _spanCache.get(includeFunctionHeaders);
  if (cached && cached.text === text) return cached.spans;

  const cachedBase = _spanCache.get(false);
  const base =
    cachedBase && cachedBase.text === text
      ? cachedBase.spans
      : scanIgnoreSpans(text);
  _spanCache.set(false, { text, spans: base });
  if (!includeFunctionHeaders) return base;
  const full = _addFunctionHeaderSpans(text, base);
  _spanCache.set(true, { text, spans: full });
  return full;
}

export function cleanParamName(param?: string | null): string {
  let p = String(param ?? "").trim();
  p = p.replace(/[\[\]]/g, " ").trim();
  p = p.replace(/\s*=\s*[^,)]+$/, "").trim();
  p = p.replace(/^(GLOBAL|LOCAL|CONST|PUBLIC|PRIVATE)\s+/i, "");
  p = p.replace(_CLEAN_PARAM_TYPE_PREFIX, "");
  p = p.replace(_CLEAN_PARAM_TYPE_SUFFIX, "");
  p = p.replace(/:$/, "");
  p = p.replace(/\s+/g, " ").trim();
  if (!isNameStart(p[0])) return p;
  let n = 1;
  while (n < p.length && isNameChar(p[n])) n++;
  return p.slice(0, n);
}

/** True if the line starts with a line comment (`//` or `!`). */
export function isCommentLine(line: string): boolean {
  return /^\s*(\/\/|!)/.test(line);
}

/** [start, end) of the name under column `col` (or ending at it), lexed as
 *  the compiler does: digits that begin a number are not part of a name
 *  (`12b`, `1.5e3`), and the field after `Tag.` is not a name of its own. */
function nameRangeInLine(line: string, col: number): [number, number] | null {
  let s = col;
  let e = col;
  while (s > 0 && isNameChar(line[s - 1])) s--;
  while (e < line.length && isNameChar(line[e])) e++;
  if (s === e) return null;

  let pos = s;
  if (line[s - 1] === ".") {
    let q = s - 1;
    while (q > 0 && isNameChar(line[q - 1])) q--;
    if (q < s - 1 && !isDigit(line[q])) return null;
    // Fraction or exponent of a real such as 1.5 or 1.e5
    if (q < s - 1) pos = Math.max(s, numberEnd(line, q));
  }
  while (pos < e) {
    const c = line[pos];
    if (isDigit(c)) pos = numberEnd(line, pos);
    else if (isNameStart(c)) return col >= pos ? [pos, e] : null;
    else pos++; // '\', ¹, ² or ³ cannot start a name
  }
  return null;
}

/** Name under the cursor, or null. In `Tag.Field` only `Tag` is a name: the
 *  field is part of a tag reference, never a function, variable or label,
 *  so hover, definition and rename find nothing there. */
export function getSymbolAtPosition(
  doc: vscode.TextDocument,
  position: vscode.Position,
): string | null {
  const line = doc.lineAt(position.line).text;
  const r = nameRangeInLine(line, position.character);
  return r ? line.slice(r[0], r[1]) : null;
}

export function leftWordRangeAt(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): vscode.Range | undefined {
  const line = doc.lineAt(pos.line).text;
  let s = pos.character;
  if (pos.character > 0 && isNameChar(line[pos.character - 1])) {
    while (s > 0 && isNameChar(line[s - 1])) s--;
    if (!isNameStart(line[s])) return undefined;
    return new vscode.Range(pos.line, s, pos.line, pos.character);
  }
  return undefined;
}

function normalizeDocText(s: string): string {
  const lines = String(s).replace(/\r\n?/g, "\n").split("\n");

  let common = Infinity;
  for (const L of lines) {
    if (!L.trim()) continue;
    const m = L.match(/^[ \t]*/);
    common = Math.min(common, m ? m[0].replace(/\t/g, "    ").length : 0);
  }
  if (!isFinite(common)) common = 0;

  const stripped = lines.map((L) => {
    if (!L.trim()) return "";
    let i = 0,
      width = 0;
    while (i < L.length && (L[i] === " " || L[i] === "\t") && width < common) {
      width += L[i] === "\t" ? 4 : 1;
      i++;
    }
    return L.slice(i)
      .replace(/[ \t]{2,}/g, " ")
      .trimEnd();
  });

  const out: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) {
      out.push(buf.join(" ").trim());
      buf = [];
    }
  };
  for (const L of stripped) {
    if (L === "") flush();
    else buf.push(L.trim());
  }
  flush();

  return out.join("\n\n").trim();
}

/** Pre-split line view of a text, with each line's start offset in the
 *  original (un-normalized) text. Build once per file and reuse. */
export interface LineIndex {
  /** Line contents without trailing \r or \n. */
  readonly lines: string[];
  /** Offset of each line's first character in the original text. */
  readonly starts: number[];
}

export function buildLineIndex(text: string): LineIndex {
  const lines: string[] = [];
  const starts: number[] = [];
  let pos = 0;
  for (;;) {
    starts.push(pos);
    const nl = text.indexOf("\n", pos);
    if (nl === -1) {
      const tail = text.slice(pos);
      lines.push(tail.endsWith("\r") ? tail.slice(0, -1) : tail);
      break;
    }
    let end = nl;
    if (end > pos && text[end - 1] === "\r") end--;
    lines.push(text.slice(pos, end));
    pos = nl + 1;
  }
  return { lines, starts };
}

/** Index of the line containing the given offset. */
export function lineAtOffset(li: LineIndex, offset: number): number {
  let lo = 0,
    hi = li.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (li.starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function extractSlashDoubleStarDoc(
  lineIndex: LineIndex,
  headerStart: number,
): string[] {
  const lines = lineIndex.lines;
  const headerLine = Math.max(
    0,
    Math.min(lines.length - 1, lineAtOffset(lineIndex, headerStart)),
  );

  const isBlank = (s: string) => /^\s*$/.test(s);
  // "/**" opens a doc comment; "/**/" is a complete, empty plain comment.
  const containsOpeningDocComment = (s: string) => /^\s*\/\*\*(?!\/)/.test(s);
  const containsClosingDocComment = (s: string) => /\*\/\s*$/.test(s);

  const out: string[] = [];
  let i = headerLine - 1;

  while (i >= 0 && isBlank(lines[i])) i--;

  if (i < 0 || !containsClosingDocComment(lines[i])) return [];

  // A closing line that also opens its comment must be a /** doc opener;
  // otherwise it's a plain /* ... */ comment, not a doc block.
  if (/\/\*/.test(lines[i]) && !containsOpeningDocComment(lines[i])) return [];

  const collected: number[] = [];
  const closingLine = i;
  while (i >= 0 && !containsOpeningDocComment(lines[i])) {
    // Interior doc lines never contain comment delimiters; hitting one
    // means we've walked out of the comment block into code above.
    if (i !== closingLine && /\/\*|\*\//.test(lines[i])) return [];
    collected.push(i);
    i--;
  }
  if (i < 0) return []; // no /** opener above: not a doc comment
  collected.push(i); // include the /** opener line itself
  collected.reverse();

  // Interior lines may start with a "*", which is dropped.
  const containsStartingStar = (s: string) => /^\s*\*/.test(s);

  let pendingBlank = false;
  for (const k of collected) {
    const L = lines[k];
    if (!isBlank(L)) {
      if (pendingBlank && out.length && out[out.length - 1] !== "")
        out.push("");
      pendingBlank = false;
      switch (true) {
        case containsClosingDocComment(L): {
          const stripped = L.replace(/\s*\*?\*\/\s*$/, "").replace(
            /^\s*\/\*\*\s*/,
            "",
          );
          if (isBlank(stripped)) {
            pendingBlank = true;
          }
          out.push(stripped.trim());
          break;
        }
        case containsOpeningDocComment(L):
          if (isBlank(L.replace(/\s*\/\*\*/, ""))) {
            pendingBlank = true;
          }
          out.push(L.replace(/\s*\/\*\*\s*/, "").trim());
          break;
        case containsStartingStar(L):
          out.push(L.replace(/^\s*\*/, "").trim());
          break;
        default:
          out.push(L);
          break;
      }
    } else if (isBlank(L)) {
      pendingBlank = true;
    }
  }

  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();

  return out;
}

export function extractLeadingTripleSlashDoc(
  lineIndex: LineIndex,
  headerStart: number,
): string[] {
  const lines = lineIndex.lines;
  const headerLine = Math.max(
    0,
    Math.min(lines.length - 1, lineAtOffset(lineIndex, headerStart)),
  );

  const isBlank = (s: string) => /^\s*$/.test(s);
  const isTriple = (s: string) => /^\s*\/\/\//.test(s);

  const out: string[] = [];
  let i = headerLine - 1;

  while (i >= 0 && isBlank(lines[i])) i--;
  if (i < 0 || !isTriple(lines[i])) return [];

  const collected: number[] = [];
  while (i >= 0 && (isTriple(lines[i]) || isBlank(lines[i]))) {
    collected.push(i);
    i--;
  }
  collected.reverse();

  let pendingBlank = false;
  for (const k of collected) {
    const L = lines[k];
    if (isTriple(L)) {
      if (pendingBlank && out.length && out[out.length - 1] !== "")
        out.push("");
      pendingBlank = false;
      out.push(L.replace(/^\s*\/\/\/\s?/, ""));
    } else if (isBlank(L)) {
      pendingBlank = true;
    }
  }

  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();

  return out;
}

export function parseDocLines(lines: string[]): {
  summary: string;
  paramDocs: Record<string, string>;
  returns?: string;
} {
  // XML tags are unlikely to occur by accident, so they are tried first.
  let extractDocLines = parseXmlDocLines(lines);
  if (
    !(
      extractDocLines.summary === "" &&
      Object.keys(extractDocLines.paramDocs).length === 0 &&
      extractDocLines.returns === undefined
    )
  ) {
    return {
      summary: extractDocLines.summary,
      paramDocs: extractDocLines.paramDocs,
      returns: extractDocLines.returns,
    };
  } else {
    extractDocLines = parseNonXmlDocLines(lines);
    return {
      summary: extractDocLines.summary,
      paramDocs: extractDocLines.paramDocs,
      returns: extractDocLines.returns,
    };
  }
}

function parseNonXmlDocLines(lines: string[]): {
  summary: string;
  paramDocs: Record<string, string>;
  returns?: string;
} {
  const raw = lines.join("\n");

  // Summary: the text after @brief or @short, else the first line.
  let summary = "";
  {
    const m = /[@\\](?:short|brief)(?:[\s\n]?\s?)(.*)/i.exec(raw);
    const entireFirstLine = /^(?:\n*)(.+)$/im.exec(raw);
    const backupBody = entireFirstLine ? entireFirstLine[1] : raw;
    const body = m ? m[1] : backupBody;
    summary = normalizeDocText(body);
  }

  const paramDocs: Record<string, string> = {};
  {
    // One name per @param; names may hold cp1252 letters and '\'.
    const re = new RegExp(
      `[@\\\\]param(?:\\[(?:in|out)\\])?[ \\t]+(${NAME_PATTERN})[ \\t]*([^\\r\\n]*)`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      const name = (m[1] || "").trim();
      const body = (m[2] || "").trim();
      if (name) paramDocs[name] = normalizeDocText(body);
    }
  }

  let returns: string | undefined;
  {
    const m = /[@\\](?:return(?:s)?)(?:[\s\n]?\s?)(.*)/i.exec(raw);
    if (m) returns = normalizeDocText(m[1].trim());
  }

  return { summary, paramDocs, returns };
}

export function parseXmlDocLines(lines: string[]): {
  summary: string;
  paramDocs: Record<string, string>;
  returns?: string;
} {
  const raw = lines.join("\n");

  let summary = "";
  {
    const m = /<summary>([\s\S]*?)<\/summary>/i.exec(raw);
    const body = m ? m[1] : "";
    summary = normalizeDocText(body.replace(/<[^>]+>/g, ""));
  }

  const paramDocs: Record<string, string> = {};
  {
    const re = /<param\s+name\s*=\s*"(.*?)"\s*>([\s\S]*?)<\/param>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      const name = (m[1] || "").trim();
      const body = (m[2] || "").replace(/<[^>]+>/g, "");
      if (name) paramDocs[name] = normalizeDocText(body);
    }
  }

  let returns: string | undefined;
  {
    const m = /<returns>([\s\S]*?)<\/returns>/i.exec(raw);
    if (m) returns = normalizeDocText(m[1].replace(/<[^>]+>/g, ""));
  }

  return { summary, paramDocs, returns };
}
