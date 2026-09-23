import * as vscode from "vscode";
import { RESERVED_WORDS } from "../../shared/constants";
import {
  buildIgnoreSpans,
  isCommentStart,
  isNameChar,
  isNameStart,
  numberEnd,
} from "../../shared/textUtils";

/** A block as the compiler nests it: FUNCTION, IF, WHILE, FOR or SELECT. */
export interface CicodeBlock {
  kind: string;
  /** Line of the opening keyword. */
  openLine: number;
  /** Lines where a clause starts (a leading ELSE or CASE) or a nested IF of
   *  an ELSE IF chain ends (a leading END). */
  splitLines: number[];
  /** Line of the closing END, -1 when the block is never closed. */
  closeLine: number;
}

export interface BlockScan {
  /** Per line: the indent level of the line's first token, or the depth
   *  between tokens for a line without any. */
  level: number[];
  /** Per line: its first token continues the statement of an earlier line. */
  cont: boolean[];
  /** Per line: a token starts on it. */
  code: boolean[];
  blocks: CicodeBlock[];
}

// A line break is only whitespace: a statement goes on after these tokens...
const CONT_AFTER_CHARS = "+-*/:<>=,([";
const CONT_AFTER_WORDS = new Set([
  "AND",
  "OR",
  "NOT",
  "MOD",
  "BITAND",
  "BITOR",
  "BITXOR",
  "IS",
  "TO",
  "IF",
  "WHILE",
  "FOR",
  "CASE",
]);
// ...and when the next line starts with one of these.
const CONT_BEFORE_CHARS = "+-*/:<>=,)]";
const CONT_BEFORE_WORDS = new Set([
  "AND",
  "OR",
  "MOD",
  "BITAND",
  "BITOR",
  "BITXOR",
  "IS",
  "TO",
  "THEN",
  "DO",
]);

/**
 * Block structure of a document as the compiler parses it, from the token
 * stream (line breaks carry no meaning). `spans` are the document's ignore
 * spans (comments, strings, format pictures).
 *
 * - END closes the innermost block. When that is a SELECT, the next token is
 *   the SELECT of END SELECT, on the same line or a later one; after any
 *   other block a SELECT opens a new SELECT CASE. END IF, END WHILE and
 *   END FOR are not closers: the keyword after END starts a new block.
 * - FOR opens a block only when a name follows; `END FOR` directly followed
 *   by END is an ignored FOR.
 * - Cicode has no ELSE IF: "ELSE IF c THEN" is an ELSE holding a nested IF
 *   that needs its own END. Such chains are indented flat, so a block opened
 *   on a line that starts with ELSE or CASE opens no level of its own; the
 *   END that closes it prints at the enclosing block's level.
 * - The word after FUNCTION is the name, whatever it is (keywords compile
 *   as function names).
 */
export function scanBlocks(
  text: string,
  spans: ReadonlyArray<[number, number]>,
): BlockScan {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  const level = new Array<number>(lineStarts.length).fill(0);
  const cont = new Array<boolean>(lineStarts.length).fill(false);
  const code = new Array<boolean>(lineStarts.length).fill(false);
  const blocks: CicodeBlock[] = [];
  const stack: { block: CicodeBlock; nested: string[] }[] = [];

  let headerName = false; // FUNCTION seen, its name comes next
  let expectSelect = false; // END closed a SELECT, the SELECT of END SELECT comes next
  let afterSelect = false; // SELECT opened, its CASE comes next
  let pendingFor: { line: number; flat: boolean } | null = null;

  let curLine = -1; // line of the previous token
  let filled = 0; // lines before this one have their level
  let lineMiddle = false; // the current line starts with ELSE or CASE
  let leading = false; // the current line holds only END / END SELECT so far
  // The previous token: an upper-case word ("" for the field of a
  // `Tag.Field`), or null and its character ("" for a string or number).
  let prevWord: string | null = null;
  let prevChar = "";

  const top = () => stack[stack.length - 1];
  const outer = () => Math.max(0, stack.length - 1);

  const open = (kind: string, line: number, flat: boolean) => {
    const t = top();
    if (flat && t) {
      t.nested.push(kind);
      return;
    }
    const block: CicodeBlock = {
      kind,
      openLine: line,
      splitLines: [],
      closeLine: -1,
    };
    blocks.push(block);
    stack.push({ block, nested: [] });
  };

  const close = (line: number) => {
    const t = top();
    if (!t) return;
    let kind: string | undefined;
    if (t.nested.length) {
      kind = t.nested.pop();
      if (leading) t.block.splitLines.push(line);
    } else {
      stack.pop();
      t.block.closeLine = line;
      kind = t.block.kind;
    }
    if (kind === "SELECT") expectSelect = true;
  };

  const startLine = (word: string | null, char: string, line: number) => {
    // Lines without tokens sit at the depth between the tokens around them.
    const between = Math.max(0, stack.length - (headerName ? 1 : 0));
    while (filled < line) level[filled++] = between;
    filled = line + 1;
    const firstToken = curLine === -1;
    curLine = line;
    code[line] = true;
    level[line] = stack.length;
    lineMiddle = false;
    leading = true;
    if (firstToken || headerName) return;
    const after =
      prevWord === null
        ? prevChar !== "" && CONT_AFTER_CHARS.includes(prevChar)
        : CONT_AFTER_WORDS.has(prevWord);
    const before =
      word === null
        ? char !== "" &&
          (CONT_BEFORE_CHARS.includes(char) ||
            // The argument list or index of the name before
            ((char === "(" || char === "[") &&
              prevWord !== null &&
              !RESERVED_WORDS.has(prevWord)))
        : CONT_BEFORE_WORDS.has(word);
    cont[line] =
      (after || before) &&
      word !== "END" &&
      word !== "ELSE" &&
      (word !== "CASE" || afterSelect);
  };

  /** One token: an upper-case word, or null and its character. */
  const handle = (word: string | null, char: string, line: number) => {
    const first = line !== curLine;
    if (first) startLine(word, char, line);

    if (pendingFor) {
      const pf = pendingFor;
      pendingFor = null;
      if (word !== null && !RESERVED_WORDS.has(word))
        open("FOR", pf.line, pf.flat);
    }
    if (headerName) {
      headerName = false;
      if (word !== null) {
        if (first) level[line] = outer();
        leading = false;
        return;
      }
    }
    if (expectSelect) {
      expectSelect = false;
      if (word === "SELECT") return;
    }
    if (afterSelect) {
      afterSelect = false;
      if (word === "CASE") {
        if (first) level[line] = outer();
        leading = false;
        return;
      }
    }

    switch (word) {
      case "END":
        if (leading) level[line] = outer();
        close(line);
        return;
      case "ELSE":
      case "CASE":
        if (first) {
          level[line] = outer();
          lineMiddle = true;
          top()?.block.splitLines.push(line);
        }
        break;
      case "FUNCTION":
        open(word, line, lineMiddle);
        headerName = true;
        break;
      case "IF":
      case "WHILE":
        open(word, line, lineMiddle);
        break;
      case "SELECT":
        open(word, line, lineMiddle);
        afterSelect = true;
        break;
      case "FOR":
        pendingFor = { line, flat: lineMiddle };
        break;
    }
    leading = false;
  };

  const token = (word: string | null, char: string, line: number) => {
    handle(word, char, line);
    prevWord = word;
    prevChar = char;
  };

  let line = 0;
  const lineOf = (pos: number) => {
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= pos) line++;
    return line;
  };

  const n = text.length;
  let si = 0;
  let pos = 0;
  while (pos < n) {
    while (si < spans.length && spans[si][1] <= pos) si++;
    if (si < spans.length && spans[si][0] <= pos) {
      // Comments are whitespace; strings and format pictures are operands.
      if (!isCommentStart(text, spans[si][0])) token(null, "", lineOf(pos));
      pos = spans[si][1];
      continue;
    }
    const c = text[pos];
    if (
      c === " " ||
      c === "\t" ||
      c === "\n" ||
      c === "\r" ||
      c === "\v" ||
      c === "\f"
    ) {
      pos++;
      continue;
    }
    const at = pos;
    if (isNameStart(c)) {
      pos++;
      while (pos < n && isNameChar(text[pos])) pos++;
      // The field of a `Tag.Field` reference is never a keyword.
      const word =
        text[at - 1] === "." ? "" : text.slice(at, pos).toUpperCase();
      token(word, "", lineOf(at));
    } else if (c >= "0" && c <= "9") {
      // A keyword may follow a number directly (`1THEN`, `0x1FIF`)
      pos = Math.min(n, Math.max(pos + 1, numberEnd(text, pos)));
      token(null, "", lineOf(at));
    } else {
      pos++;
      token(null, c, lineOf(at));
    }
  }
  const between = Math.max(0, stack.length - (headerName ? 1 : 0));
  while (filled < level.length) level[filled++] = between;
  return { level, cont, code, blocks };
}

/** Indent width of a line in columns, tab stops every 4. */
function indentWidth(line: string): number {
  let w = 0;
  for (const c of line) {
    if (c === "\t") w += 4 - (w % 4);
    else if (c === " ") w++;
    else break;
  }
  return w;
}

export function makeFormatter(
  cfg: () => vscode.WorkspaceConfiguration,
): vscode.DocumentFormattingEditProvider {
  function parenDelta(effective: string) {
    let delta = 0;
    for (let i = 0; i < effective.length; i++) {
      const c = effective[i];
      if (c === "(") delta++;
      else if (c === ")") delta--;
    }
    return delta;
  }

  // A standalone '=' (assignment or comparison), not the '=' of <= or >=
  const ASSIGN_EQ = /(?<![<>=])\s*=\s*(?![=])/g;

  return {
    provideDocumentFormattingEdits(doc) {
      if (!cfg().get("cicode.format.enable", true)) return [];
      const maxBlank = Math.max(
        0,
        cfg().get("cicode.format.maxConsecutiveBlankLines", 1),
      );

      const start = new vscode.Position(0, 0);
      const end = doc.lineAt(Math.max(0, doc.lineCount - 1)).range.end;

      // Comment/string spans for the whole document. Used to derive each
      // line's "effective code" so that comments (including /* */ blocks)
      // and string contents never affect paren/keyword/depth counting.
      const text = doc.getText();
      const ignoreSpans = buildIgnoreSpans(text, {
        includeFunctionHeaders: false,
      });
      const { level, cont, code } = scanBlocks(text, ignoreSpans);

      const firstSpanEndingAfter = (pos: number): number => {
        let lo = 0,
          hi = ignoreSpans.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (ignoreSpans[mid][1] <= pos) lo = mid + 1;
          else hi = mid;
        }
        return lo;
      };

      const spanContaining = (pos: number): [number, number] | null => {
        const idx = firstSpanEndingAfter(pos);
        if (idx < ignoreSpans.length && ignoreSpans[idx][0] <= pos)
          return ignoreSpans[idx];
        return null;
      };

      const lineStartOf = (i: number) =>
        doc.offsetAt(new vscode.Position(i, 0));

      /** Line starts inside a comment or literal opened on an earlier line. */
      const startsInSpan = (lineStart: number): [number, number] | null => {
        const span = spanContaining(lineStart);
        return span !== null && span[0] < lineStart ? span : null;
      };

      // Strings may span lines, and every character of one is part of its
      // value, so whitespace inside a literal (string, `|...|`, picture or
      // the text after an end-of-input character) is never touched.
      const isLiteral = (span: [number, number] | null) =>
        span !== null && !isCommentStart(text, span[0]);

      // Next line holding a token, for comment lines.
      const nextCode = new Array<number>(doc.lineCount).fill(-1);
      for (let i = doc.lineCount - 2; i >= 0; i--) {
        nextCode[i] = code[i + 1] ? i + 1 : nextCode[i + 1];
      }

      /** Line text with comment/string span contents blanked out. */
      const effectiveLine = (raw: string, lineStart: number): string => {
        const lineEnd = lineStart + raw.length;
        let idx = firstSpanEndingAfter(lineStart);
        if (idx >= ignoreSpans.length || ignoreSpans[idx][0] >= lineEnd)
          return raw;
        const chars = raw.split("");
        for (
          ;
          idx < ignoreSpans.length && ignoreSpans[idx][0] < lineEnd;
          idx++
        ) {
          const s = Math.max(ignoreSpans[idx][0], lineStart);
          const e = Math.min(ignoreSpans[idx][1], lineEnd);
          for (let p = s; p < e; p++) chars[p - lineStart] = " ";
        }
        return chars.join("");
      };

      /** Normalize spacing around assignment '=' and commas in the code
       *  portions of a line. Comment/string span contents are emitted
       *  verbatim (using the shared document spans, so the string/comment
       *  model matches the rest of the extension), and paren depth carries
       *  across them so commas inside call argument lists stay untouched. */
      const normalizeOutsideParens = (
        line: string,
        lineStart: number,
      ): string => {
        if (!/[=,]/.test(line)) return line;

        const lineEnd = lineStart + line.length;
        let result = "";
        let buf = "";
        let depth = 0;

        const normalizeChunk = (t: string) =>
          t
            .replace(ASSIGN_EQ, " = ")
            // tidy commas (code portions only)
            .replace(/\s*,\s*/g, ", ");
        const flushBuf = () => {
          if (!buf) return;
          result += depth > 0 ? buf : normalizeChunk(buf);
          buf = "";
        };
        const emitCode = (seg: string) => {
          for (let i = 0; i < seg.length; i++) {
            const c = seg[i];
            if (c === "(") {
              if (depth === 0) flushBuf();
              depth++;
              buf += c;
            } else if (c === ")") {
              buf += c;
              depth = Math.max(0, depth - 1);
              if (depth === 0) {
                result += buf;
                buf = "";
              }
            } else {
              buf += c;
            }
          }
        };

        let pos = 0;
        for (
          let idx = firstSpanEndingAfter(lineStart);
          idx < ignoreSpans.length && ignoreSpans[idx][0] < lineEnd;
          idx++
        ) {
          const s = Math.max(ignoreSpans[idx][0] - lineStart, 0);
          const e = Math.min(ignoreSpans[idx][1] - lineStart, line.length);
          if (pos < s) emitCode(line.slice(pos, s));
          flushBuf();
          result += line.slice(s, e); // comment/string content verbatim
          pos = e;
        }
        if (pos < line.length) emitCode(line.slice(pos));
        flushBuf();
        return result;
      };

      const out: string[] = [];
      let parenBalance = 0;
      let blankCount = 0;
      // Indent change (columns) of the line the current statement started
      // on. Its continuation lines (inside parens, or after an operator)
      // keep their own layout and move by the same amount.
      let shift = 0;
      const shifted = (raw: string, line: string): string => {
        const body = line.replace(/^\s+/, "");
        if (shift === 0 || body === "") return line;
        const w = Math.max(0, indentWidth(raw) + shift);
        return "\t".repeat(Math.floor(w / 4)) + " ".repeat(w % 4) + body;
      };

      for (let i = 0; i < doc.lineCount; i++) {
        const raw = doc.lineAt(i).text;
        const lineStart = lineStartOf(i);
        const lineEnd = lineStart + raw.length;
        // The line break is inside a literal: trailing blanks are its value.
        const endSpan = spanContaining(lineEnd);
        const endsInLiteral =
          endSpan !== null && endSpan[0] < lineEnd && isLiteral(endSpan);
        const line = endsInLiteral ? raw : raw.replace(/\s+$/, "");
        // Normalizing may leave a blank after a final comma
        const tidy = (s: string) => (endsInLiteral ? s : s.replace(/\s+$/, ""));
        const trimmed = line.trim();
        const effective = effectiveLine(raw, lineStart);
        const effTrimmed = effective.trim();
        const delta = parenDelta(effective);
        const indent = "\t".repeat(level[i] ?? 0);
        const openSpan = startsInSpan(lineStart);

        // Line starts inside a literal opened above: its start is part of
        // the value, so it is kept as is (also when blank); only code after
        // the literal's end is normalized, and not inside parentheses.
        if (openSpan !== null && isLiteral(openSpan)) {
          const cut = Math.min(openSpan[1] - lineStart, line.length);
          out.push(
            parenBalance > 0 || cut >= line.length
              ? line
              : tidy(
                  line.slice(0, cut) +
                    normalizeOutsideParens(line.slice(cut), lineStart + cut),
                ),
          );
          blankCount = 0;
          parenBalance += delta;
          continue;
        }

        // Line continues a /* */ block comment opened on a previous line and
        // has no code of its own: emit verbatim (no reindent, no blank-line
        // collapse) so commented-out code keeps its original layout.
        if (effTrimmed.length === 0 && openSpan !== null) {
          out.push(line);
          blankCount = 0;
          continue;
        }

        // collapse blank lines
        if (trimmed.length === 0 && parenBalance === 0) {
          blankCount++;
          if (blankCount <= maxBlank) out.push("");
          continue;
        } else blankCount = 0;

        // Comment-only line (a string or picture on its own is code)
        if (!code[i] && trimmed.length > 0) {
          if (parenBalance > 0) {
            out.push(shifted(raw, line));
            continue;
          }
          // A /* */ comment that continues onto later lines is emitted
          // unchanged, like its continuation lines, so its layout is
          // preserved. Comments that all close on this line (//, !, and
          // single-line /* */) are reindented with the code.
          const nextLineStart =
            i + 1 < doc.lineCount ? lineStartOf(i + 1) : text.length;
          const lastSpan = spanContaining(lineStart + line.length - 1);
          const next = nextCode[i];
          if (lastSpan !== null && lastSpan[1] > nextLineStart) {
            out.push(line);
          } else if (next !== -1 && cont[next]) {
            // Inside a statement that goes on below
            out.push(shifted(raw, line));
          } else if (
            next !== -1 &&
            level[next] < level[i] &&
            startsInSpan(lineStartOf(next)) === null &&
            indentWidth(raw) <= indentWidth(doc.lineAt(next).text)
          ) {
            // Written at or left of the ELSE, CASE or END below: a heading
            // for that clause, so it takes the clause's level.
            out.push("\t".repeat(level[next]) + trimmed);
          } else {
            out.push(indent + trimmed);
          }
          continue;
        }

        // Inside multi-line paren block: layout kept, moved with its statement
        if (parenBalance > 0) {
          out.push(shifted(raw, line));
          parenBalance += delta; // always update
          continue;
        }

        // Line begins inside a /* */ comment opened on a previous line but
        // has code after the closing */: keep everything through */ verbatim
        // (no reindent, no trim) and only normalize the code that follows.
        if (openSpan !== null) {
          const cut = Math.min(openSpan[1] - lineStart, line.length);
          out.push(
            tidy(
              line.slice(0, cut) +
                normalizeOutsideParens(line.slice(cut), lineStart + cut),
            ),
          );
          shift = 0;
        } else if (cont[i]) {
          // Continues the statement of the line above (a line break is
          // only whitespace): laid out like lines inside parens.
          out.push(shifted(raw, line));
        } else {
          const normalized = tidy(
            normalizeOutsideParens(line, lineStart).replace(/^\s+/, ""),
          );
          out.push(normalized.length ? indent + normalized : "");
          shift = 4 * (level[i] ?? 0) - indentWidth(raw);
        }
        parenBalance += delta;
      }

      if (out.length === 0 || out[out.length - 1] !== "") out.push("");
      const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
      const newText = out.join(eol);
      const fullRange = new vscode.Range(start, end);
      if (newText === doc.getText(fullRange)) return [];
      return [vscode.TextEdit.replace(fullRange, newText)];
    },
  };
}
