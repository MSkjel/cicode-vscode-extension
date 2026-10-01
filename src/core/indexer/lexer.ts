import { RESERVED_WORDS } from "../../shared/constants";
import {
  isCommentStart,
  isNameChar,
  isNameStart,
  isSpace,
  numberEnd,
  scanIgnoreSpans,
  upperAscii,
} from "../../shared/textUtils";

/** w = name or keyword, n = number, s = string or `|...|`, p = operator,
 *  punctuation or format picture (`#...`). */
export type TokenKind = "w" | "n" | "s" | "p";

export interface Token {
  readonly kind: TokenKind;
  /** Source text; for names with ASCII letters upper-cased, the only case
   *  the compiler ignores (see nameKey). A tag field (`Field` in
   *  `Tag.Field`) is prefixed with '.'. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface LexResult {
  readonly tokens: Token[];
  /** Comment spans `[start, end)`, sorted. */
  readonly comments: Array<[number, number]>;
}

/** The compiler's reserved words (case-insensitive). */
export const KEYWORDS: ReadonlySet<string> = RESERVED_WORDS;

/**
 * Tokenizes Cicode source the way the compiler's lexer does. Comments,
 * strings, `|...|` tokens, format pictures and the end of input (NUL or
 * Ctrl-Z) come from scanIgnoreSpans, names and numbers from isNameStart,
 * isNameChar and numberEnd, so this and textUtils share one set of lexical
 * rules. `<=`, `<>` and `>=` are single tokens; any other character that is
 * not whitespace is a token of its own. Labels are not expanded.
 */
export function lex(text: string): LexResult {
  const tokens: Token[] = [];
  const comments: Array<[number, number]> = [];
  const spans = scanIgnoreSpans(text);
  const N = text.length;
  let k = 0;
  let i = 0;

  while (i < N) {
    // Span starts ('"', '!', '/', '|', '#', NUL, Ctrl-Z) never occur inside
    // the names, numbers and operators read below.
    if (k < spans.length && spans[k][0] === i) {
      const [s, e] = spans[k++];
      const c = text[s];
      if (c === "\0" || c === "\x1a") break;
      if (isCommentStart(text, s)) comments.push([s, e]);
      else {
        const kind = c === "#" ? "p" : "s";
        tokens.push({ kind, text: text.slice(s, e), start: s, end: e });
      }
      i = e;
      continue;
    }

    const ch = text[i];
    if (isSpace(ch)) {
      i++;
      continue;
    }
    let j = i + 1;
    let kind: TokenKind = "p";
    if (isNameStart(ch)) {
      while (j < N && isNameChar(text[j])) j++;
      kind = "w";
    } else if (ch >= "0" && ch <= "9") {
      j = numberEnd(text, i);
      kind = "n";
    } else if (
      (ch === "<" && (text[j] === "=" || text[j] === ">")) ||
      (ch === ">" && text[j] === "=")
    ) {
      j++;
    }
    const src = text.slice(i, j);
    tokens.push({
      kind,
      text:
        kind !== "w"
          ? src
          : isField(tokens, i)
            ? `.${upperAscii(src)}`
            : upperAscii(src),
      start: i,
      end: j,
    });
    i = j;
  }
  return { tokens, comments };
}

/** True when a name at `i` is a field: glued after a '.' that is glued
 *  after a name or a closing bracket (`Tag.Field`, `Area.Unit.Item`). It is
 *  part of the tag reference, keywords included (`Tag.End`), so its token
 *  text starts with '.'. */
function isField(tokens: readonly Token[], i: number): boolean {
  const dot = tokens[tokens.length - 1];
  const before = tokens[tokens.length - 2];
  return (
    dot?.kind === "p" &&
    dot.text === "." &&
    dot.end === i &&
    before !== undefined &&
    before.end === dot.start &&
    (before.kind === "w" || before.text === ")" || before.text === "]")
  );
}

/** Is `t` a name token that is not a reserved word? */
export function isIdentifier(t: Token | undefined): t is Token {
  return t !== undefined && t.kind === "w" && !KEYWORDS.has(t.text);
}

/** Is `t` the keyword or punctuation `text` (keywords are upper-case)? */
export function isToken(t: Token | undefined, text: string): boolean {
  return t !== undefined && t.kind !== "s" && t.text === text;
}
