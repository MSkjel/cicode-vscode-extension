import type { Indexer } from "../../../core/indexer/indexer";
import type { LabelRecord } from "../../../core/indexer/labelsReader";
import type { FunctionRange } from "../../../core/indexer/types";
import type { FunctionInfo } from "../../../shared/types";
import { CICODE_TYPES, RESERVED_WORDS } from "../../../shared/constants";
import {
  OPERATOR_WORDS,
  isNameChar,
  isNameStart,
  isSpace,
  numberEnd,
  scanIgnoreSpans,
  upperAscii,
} from "../../../shared/textUtils";
import { inCompile, unitComplete } from "../context";

// Tokens and statement structure of function bodies, read the way the
// compiler reads them (newlines and semicolons carry no meaning). Labels are
// not expanded.

// =============================================================================
// Tokens
// =============================================================================

/** w = name or keyword (text upper-cased; a field name glued after `Tag.`
 *  gets a leading '.', so `Tag.End` holds no keyword), n = number, s =
 *  string or `|...|` token, p = operator, punctuation or `#` format picture. */
export type TokenKind = "w" | "n" | "s" | "p";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Error the compiler's lexer reports, wherever it occurs. */
export interface LexError {
  /** E2054 string or `|` not closed, E2056 comment not closed, E2058
   *  integer over 32 bits. */
  readonly code: "E2054" | "E2056" | "E2058";
  readonly start: number;
  readonly end: number;
}

interface Lexed {
  readonly tokens: Token[];
  readonly errors: LexError[];
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

/** True for an integer literal over 32 bits (E2058); leading zeros don't
 *  count, reals never overflow. */
function intTooBig(s: string): boolean {
  const m = /^0*([bBoOxX])0*(\w*)$/.exec(s);
  if (m) {
    const d = m[2];
    const r = m[1].toLowerCase();
    if (r === "x") return d.length > 8;
    if (r === "b") return d.length > 32;
    return d.length > 11 || (d.length === 11 && d[0] > "3");
  }
  if (!/^\d+$/.test(s)) return false;
  const d = s.replace(/^0+/, "");
  return d.length > 10 || (d.length === 10 && d > "4294967295");
}

/** True when the string token at `s` has its closing quote (`^` escapes the
 *  next character). */
function stringClosed(text: string, s: number, e: number): boolean {
  for (let i = s + 1; i < e; i++) {
    if (text[i] === "^") i++;
    else if (text[i] === '"') return true;
  }
  return false;
}

/** Tokenizes `text` like the compiler's lexer, on the spans of
 *  scanIgnoreSpans (comments, strings, `|...|`, format pictures). Input ends
 *  at a NUL or Ctrl-Z. */
function lexText(text: string): Lexed {
  const tokens: Token[] = [];
  const errors: LexError[] = [];
  const eof = text.search(/[\0\x1a]/);
  const n = eof === -1 ? text.length : eof;
  const spans = scanIgnoreSpans(text);
  let k = 0;
  let i = 0;
  while (i < n) {
    while (k < spans.length && spans[k][0] < i) k++;
    if (k < spans.length && spans[k][0] === i) {
      const [s, e] = spans[k++];
      const c = text[s];
      if (c === '"' || c === "|") {
        tokens.push({ kind: "s", text: text.slice(s, e), start: s, end: e });
        const closed =
          c === '"'
            ? stringClosed(text, s, e)
            : e - s > 1 && text[e - 1] === "|";
        if (!closed) errors.push({ code: "E2054", start: s, end: s + 1 });
      } else if (c === "#") {
        tokens.push({ kind: "p", text: text.slice(s, e), start: s, end: e });
      } else if (c === "/" && text[s + 1] === "*") {
        if (e - s < 4 || text[e - 2] !== "*" || text[e - 1] !== "/") {
          errors.push({ code: "E2056", start: s, end: s + 2 });
        }
      }
      i = e;
      continue;
    }
    const c = text[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    let j = i + 1;
    let kind: TokenKind = "p";
    if (isNameStart(c)) {
      while (j < n && isNameChar(text[j])) j++;
      kind = "w";
    } else if (isDigit(c)) {
      j = numberEnd(text, i);
      kind = "n";
    } else if (
      (c === "<" || c === ">") &&
      (text[j] === "=" || (c === "<" && text[j] === ">"))
    ) {
      j++;
    }
    const raw = text.slice(i, j);
    tokens.push({
      kind,
      text:
        kind !== "w"
          ? raw
          : isField(tokens, i)
            ? `.${upperAscii(raw)}`
            : upperAscii(raw),
      start: i,
      end: j,
    });
    if (kind === "n" && intTooBig(raw)) {
      errors.push({ code: "E2058", start: i, end: j });
    }
    i = j;
  }
  return { tokens, errors };
}

/** True when a name at `i` is a field: glued after a '.' that is glued
 *  after a name or a closing bracket (`Tag.Field`, `Area.Unit.Item`). Such
 *  a name is part of the tag reference, keywords included (`Tag.End`). */
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

/** Tokens of a fragment such as a label's text (not memoized). */
export function lexTokens(text: string): Token[] {
  return lexText(text).tokens;
}

/** Is `t` a name that is not a reserved word? */
export function isIdentifier(t: Token | undefined): t is Token {
  return t !== undefined && t.kind === "w" && !RESERVED_WORDS.has(t.text);
}

/** Is `t` the keyword or punctuation `text` (keywords upper-case)? */
export function isToken(t: Token | undefined, text: string): boolean {
  return t !== undefined && t.kind !== "s" && t.text === text;
}

/** Upper-case text of a name or keyword token, "" otherwise. */
export function word(t: Token | undefined): string {
  return t !== undefined && t.kind === "w" ? t.text : "";
}

let memo:
  | { text: string; lexed: Lexed; bodies: Map<number, FunctionBody> }
  | undefined;

function lexedOf(text: string): Lexed {
  if (memo?.text !== text) {
    memo = { text, lexed: lexText(text), bodies: new Map() };
  }
  return memo.lexed;
}

/** Tokens of `text` without comments. The last text is memoized, so the
 *  rules of one diagnostics run lex the document once. */
export function tokensOf(text: string): Token[] {
  return lexedOf(text).tokens;
}

/** Lexer errors of `text` (memoized with the tokens). */
export function lexErrorsOf(text: string): LexError[] {
  return lexedOf(text).errors;
}

/** Index of the first token starting at or after `offset`. */
export function tokenAt(T: readonly Token[], offset: number): number {
  let lo = 0;
  let hi = T.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (T[mid].start < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// =============================================================================
// Expressions
// =============================================================================

const BINARY_OPS = new Set([
  "*",
  "/",
  "MOD",
  ":",
  "+",
  "-",
  "<",
  "<=",
  ">",
  ">=",
  "=",
  "<>",
  "AND",
  "OR",
  "BITAND",
  "BITOR",
  "BITXOR",
]);

const RELATIONAL_OPS = new Set(["<", "<=", ">", ">=", "=", "<>"]);

export const SCOPE_WORDS = new Set(["GLOBAL", "MODULE", "PUBLIC", "PRIVATE"]);

// Reserved words without a meaning in Cicode functions (E2041, CiVBA
// E2074); they don't start or end statements.
const MEANINGLESS_WORDS = new Set(["NOP", "VAR", "CICODE", "CIVBA"]);

/** Reserved word that cannot occur inside an expression. */
export function isStatementWord(t: Token | undefined): boolean {
  const w = word(t);
  return (
    w !== "" &&
    RESERVED_WORDS.has(w) &&
    !OPERATOR_WORDS.has(w) &&
    !MEANINGLESS_WORDS.has(w)
  );
}

/** Token after the bracket closing the one at `i`. An unclosed bracket ends
 *  at a `;` or statement keyword (valid code has none inside brackets). */
export function closeEnd(T: readonly Token[], i: number, end: number): number {
  let depth = 0;
  for (; i < end; i++) {
    const t = T[i];
    if (isStatementWord(t)) return i;
    if (t.kind !== "p") continue;
    if (t.text === "(" || t.text === "[") depth++;
    else if (t.text === ")" || t.text === "]") {
      if (--depth === 0) return i + 1;
    } else if (t.text === ";") return i;
  }
  return end;
}

/** End of the operand at `i` (after unary NOT, - and +), or -1 when none
 *  starts there. A name may be followed by call arguments, array indexes
 *  and `.Field` parts (tag extensions, equipment references). */
export function operandEnd(
  T: readonly Token[],
  i: number,
  end: number,
): number {
  while (
    i < end &&
    (isToken(T[i], "NOT") || isToken(T[i], "-") || isToken(T[i], "+"))
  ) {
    i++;
  }
  if (i >= end) return -1;
  const t = T[i];
  if (isToken(t, "(")) return closeEnd(T, i, end);
  if (t.kind === "n" || t.kind === "s") return i + 1;
  if (!isIdentifier(t)) return -1;
  i++;
  for (;;) {
    if (i < end && (isToken(T[i], "(") || isToken(T[i], "["))) {
      i = closeEnd(T, i, end);
    } else if (
      i + 1 < end &&
      isToken(T[i], ".") &&
      T[i + 1].kind === "w" &&
      T[i - 1].end === T[i].start &&
      T[i].end === T[i + 1].start
    ) {
      // `Tag.Field`, written without spaces.
      i += 2;
    } else {
      return i;
    }
  }
}

/** End of the format specifier after the ':' before `i`: a `#` picture, a
 *  width such as 5, -5 or 3.2, or `~`. */
export function formatEnd(T: readonly Token[], i: number, end: number): number {
  if (i >= end) return i;
  const t = T[i];
  if (t.kind === "p" && t.text.startsWith("#")) return i + 1;
  const j = isToken(t, "-") ? i + 1 : i;
  if (j < end && (T[j].kind === "n" || (j === i && isToken(T[j], "~")))) {
    return j + 1;
  }
  return i;
}

/** End of the expression starting at `i` (`i` itself when no operand
 *  starts there): operands joined by binary operators, `:` taking a format
 *  specifier. Like the compiler, it stops at the first token that cannot
 *  continue the expression, so `a b` is two expressions. */
export function expressionEnd(
  T: readonly Token[],
  i: number,
  end: number,
): number {
  let j = operandEnd(T, i, end);
  if (j < 0) return i;
  for (;;) {
    if (j >= end) return j;
    const op = T[j];
    if (op.kind === "s" || op.kind === "n" || !BINARY_OPS.has(op.text)) {
      return j;
    }
    if (op.text === ":") {
      j = formatEnd(T, j + 1, end);
      continue;
    }
    const k = operandEnd(T, j + 1, end);
    if (k < 0) return j + 1;
    j = k;
  }
}

// =============================================================================
// Statements
// =============================================================================

export type StmtKind =
  | "if"
  | "while"
  | "for"
  | "select"
  | "return"
  | "decl"
  | "expr"
  | "empty"
  | "stray";

export interface DeclaredName {
  /** Name token. */
  readonly tok: number;
  /** '[' token of each array dimension. */
  readonly dims: number[];
  /** '=' token of the initializer, -1 when there is none. */
  readonly init: number;
}

export interface Stmt {
  readonly kind: StmtKind;
  /** First token, and the token after the statement. */
  readonly start: number;
  readonly end: number;
  /** Number of enclosing IF/WHILE/FOR/SELECT blocks. */
  readonly depth: number;
  /** Nested statements: IF then/else, WHILE/FOR body, one list per SELECT clause. */
  readonly blocks: Stmt[][];
  /** THEN (IF), DO (WHILE, FOR) or CASE (SELECT) token; -1 when missing. */
  readonly opener: number;
  /** Condition of IF/WHILE, selector of SELECT: [first, end) token range. */
  readonly cond?: readonly [number, number];
  /** Block-closing END, -1 when missing (then `end` is the token the block
   *  stopped at: ELSE, CASE or the end of the body). */
  readonly close: number;
  /** SELECT: its END is followed by SELECT. */
  readonly endSelect?: boolean;
  /** FOR: the token after FOR (its variable when a name), -1 when no name follows. */
  readonly forVar?: number;
  /** FOR: TO token (-1 without TO: no loop) and the token after the TO bound. */
  readonly forTo?: number;
  readonly forBoundEnd?: number;
  /** Declaration: scope keyword token (-1 when none), type token, names. */
  readonly scopeTok?: number;
  readonly typeTok?: number;
  readonly names?: DeclaredName[];
  /** Errors the compiler reports inside the statement (SELECT clauses). */
  readonly issues?: StmtIssue[];
  /** Stray ELSE or CASE at the start of a block. */
  readonly blockStart?: boolean;
}

export interface StmtIssue {
  readonly tok: number;
  readonly code: string;
  readonly message: string;
}

export interface FunctionBody {
  readonly tokens: readonly Token[];
  /** Top-level statements. */
  readonly stmts: Stmt[];
  /** Token range of the body, without the function's END. */
  readonly start: number;
  readonly end: number;
}

// Keywords that end a block's statement list.
const BLOCK_END = new Set(["END", "ELSE", "CASE", "FUNCTION"]);

// Keywords the indexer stops at when deciding whether FOR opens a block.
const FOR_STOP = new Set([
  "CASE",
  "DO",
  "ELSE",
  "END",
  "FOR",
  "FUNCTION",
  "GLOBAL",
  "IF",
  "MODULE",
  "PRIVATE",
  "PUBLIC",
  "RETURN",
  "SELECT",
  "THEN",
  "WHILE",
  ...CICODE_TYPES,
]);

function stmt(
  kind: StmtKind,
  start: number,
  end: number,
  depth: number,
  extra: Partial<Stmt> = {},
): Stmt {
  return {
    kind,
    start,
    end,
    depth,
    blocks: [],
    opener: -1,
    close: -1,
    ...extra,
  };
}

class BodyParser {
  constructor(
    private readonly T: readonly Token[],
    private readonly end: number,
    private readonly typed: boolean,
  ) {}

  /** Top-level statements up to the end of the body. */
  body(i: number): Stmt[] {
    const out: Stmt[] = [];
    while (i < this.end) {
      const t = this.T[i];
      if (isToken(t, "END") || isToken(t, "FUNCTION")) break;
      const s =
        isToken(t, "ELSE") || isToken(t, "CASE")
          ? stmt("stray", i, i + 1, 0)
          : this.statement(i, 0);
      out.push(s);
      i = s.end;
    }
    return out;
  }

  /** Statements from `i` up to END, ELSE, CASE or FUNCTION. */
  private block(i: number, depth: number): { stmts: Stmt[]; next: number } {
    const stmts: Stmt[] = [];
    // A block takes one statement before ELSE or CASE can end it, so an
    // ELSE or CASE right at its start is a stray token (E2041); END is not.
    if (
      i < this.end &&
      (isToken(this.T[i], "ELSE") || isToken(this.T[i], "CASE"))
    ) {
      stmts.push(stmt("stray", i, i + 1, depth, { blockStart: true }));
      i++;
    }
    while (i < this.end && !BLOCK_END.has(word(this.T[i]))) {
      const s = this.statement(i, depth);
      stmts.push(s);
      i = s.end;
    }
    return { stmts, next: i };
  }

  private statement(i: number, depth: number): Stmt {
    const T = this.T;
    const w = word(T[i]);
    switch (w) {
      case "IF":
        return this.conditional(i, depth, "if", "THEN");
      case "WHILE":
        return this.conditional(i, depth, "while", "DO");
      case "FOR":
        return this.forLoop(i, depth);
      case "SELECT":
        return this.select(i, depth);
      case "RETURN":
        // A typed function's RETURN takes the expression after it, on any
        // line; in a void function RETURN ends at once.
        return stmt(
          "return",
          i,
          this.typed ? expressionEnd(T, i + 1, this.end) : i + 1,
          depth,
        );
    }
    if (SCOPE_WORDS.has(w) && CICODE_TYPES.has(word(T[i + 1]))) {
      return this.declaration(i, i, i + 1, depth);
    }
    if (CICODE_TYPES.has(w)) return this.declaration(i, -1, i, depth);
    if (isToken(T[i], ";")) return stmt("empty", i, i + 1, depth);
    const e = expressionEnd(T, i, this.end);
    return e > i ? stmt("expr", i, e, depth) : stmt("stray", i, i + 1, depth);
  }

  /** First `keyword` ahead of `from` before a `;` or another statement
   *  keyword, or -1. */
  private findAhead(from: number, keyword: string): number {
    for (let k = from; k < this.end; k++) {
      const t = this.T[k];
      if (isToken(t, ";")) return -1;
      if (isStatementWord(t)) return t.text === keyword ? k : -1;
    }
    return -1;
  }

  private closeBlock(j: number): { close: number; next: number } {
    return j < this.end && isToken(this.T[j], "END")
      ? { close: j, next: j + 1 }
      : { close: -1, next: j };
  }

  private conditional(
    i: number,
    depth: number,
    kind: "if" | "while",
    openerWord: string,
  ): Stmt {
    const T = this.T;
    const condEnd = expressionEnd(T, i + 1, this.end);
    const opener =
      condEnd < this.end && isToken(T[condEnd], openerWord)
        ? condEnd
        : this.findAhead(i + 1, openerWord);
    const blocks: Stmt[][] = [];
    let b = this.block(opener >= 0 ? opener + 1 : condEnd, depth + 1);
    blocks.push(b.stmts);
    if (kind === "if" && b.next < this.end && isToken(T[b.next], "ELSE")) {
      b = this.block(b.next + 1, depth + 1);
      blocks.push(b.stmts);
    }
    const { close, next } = this.closeBlock(b.next);
    return stmt(kind, i, next, depth, {
      blocks,
      opener,
      cond: [i + 1, opener >= 0 ? opener : condEnd],
      close,
    });
  }

  private forLoop(i: number, depth: number): Stmt {
    const T = this.T;
    // The compiler ignores a FOR that is not followed by a name.
    if (i + 1 >= this.end || !isIdentifier(T[i + 1])) {
      return stmt("for", i, i + 1, depth, { forVar: -1 });
    }
    // Only `FOR var = ... TO` opens a block (the indexer decides the same
    // way); `FOR i = 5;` is an assignment and `FOR i` just the name.
    let to = -1;
    for (let k = i + 2, d = 0; k < this.end && k < i + 500; k++) {
      const t = T[k];
      if (isToken(t, "(")) d++;
      else if (isToken(t, ")")) d--;
      else if (d <= 0) {
        if (isToken(t, "TO")) {
          to = k;
          break;
        }
        if (isToken(t, ";") || FOR_STOP.has(word(t))) break;
      }
    }
    if (to < 0) {
      const e = isToken(T[i + 2], "=")
        ? expressionEnd(T, i + 3, this.end)
        : i + 2;
      return stmt("for", i, e, depth, { forVar: i + 1, forTo: -1 });
    }
    const boundEnd = expressionEnd(T, to + 1, this.end);
    const opener =
      boundEnd < this.end && isToken(T[boundEnd], "DO")
        ? boundEnd
        : this.findAhead(boundEnd, "DO");
    const b = this.block(opener >= 0 ? opener + 1 : boundEnd, depth + 1);
    const { close, next } = this.closeBlock(b.next);
    return stmt("for", i, next, depth, {
      blocks: [b.stmts],
      opener,
      close,
      forVar: i + 1,
      forTo: to,
      forBoundEnd: boundEnd,
    });
  }

  /** End of a CASE item list: expressions, `a TO b` and `IS <op> a`,
   *  separated by commas. */
  private caseItemsEnd(j: number, issues: StmtIssue[]): number {
    const T = this.T;
    for (;;) {
      if (isToken(T[j], "IS")) {
        j++;
        if (T[j] && T[j].kind === "p" && RELATIONAL_OPS.has(T[j].text)) j++;
        else {
          issues.push({
            tok: j - 1,
            code: "E2024",
            message:
              "Incompatible types: IS must be followed by a comparison operator (=, <>, <, <=, > or >=).",
          });
        }
      }
      j = expressionEnd(T, j, this.end);
      if (isToken(T[j], "TO")) j = expressionEnd(T, j + 1, this.end);
      if (!isToken(T[j], ",")) return j;
      j++;
    }
  }

  private select(i: number, depth: number): Stmt {
    const T = this.T;
    const opener = isToken(T[i + 1], "CASE") ? i + 1 : -1;
    const selStart = opener >= 0 ? i + 2 : i + 1;
    let j = expressionEnd(T, selStart, this.end);
    const cond: [number, number] = [selStart, j];
    const blocks: Stmt[][] = [];
    const issues: StmtIssue[] = [];
    if (opener >= 0 && j === selStart) {
      issues.push({
        tok: opener,
        code: "E2041",
        message: "Operand expected: SELECT CASE needs the value to select on.",
      });
    }
    if (j < this.end && !isToken(T[j], "CASE") && !isToken(T[j], "END")) {
      const b = this.block(j, depth + 1);
      blocks.push(b.stmts);
      j = b.next;
    }
    let caseElse = false;
    while (j < this.end && isToken(T[j], "CASE")) {
      if (caseElse) {
        issues.push({
          tok: j,
          code: "E2034",
          message:
            "END expected: CASE ELSE must be the last clause of a SELECT CASE.",
        });
      }
      j++;
      if (isToken(T[j], "ELSE")) {
        caseElse = true;
        j++;
      } else {
        j = this.caseItemsEnd(j, issues);
        if (isToken(T[j], "DO")) j++;
      }
      const b = this.block(j, depth + 1);
      blocks.push(b.stmts);
      j = b.next;
    }
    const { close, next } = this.closeBlock(j);
    const endSelect =
      close >= 0 && next < this.end && isToken(T[next], "SELECT");
    return stmt("select", i, endSelect ? next + 1 : next, depth, {
      blocks,
      opener,
      cond,
      close,
      endSelect,
      issues,
    });
  }

  /** `[scope] type name [dims] [= expr] {, name ...}`; a type after a comma
   *  starts a new declaration. */
  private declaration(
    i: number,
    scopeTok: number,
    typeTok: number,
    depth: number,
  ): Stmt {
    const T = this.T;
    const names: DeclaredName[] = [];
    let j = typeTok + 1;
    while (j < this.end && isIdentifier(T[j])) {
      const tok = j++;
      const dims: number[] = [];
      while (j < this.end && isToken(T[j], "[")) {
        dims.push(j);
        j = closeEnd(T, j, this.end);
      }
      let init = -1;
      if (j < this.end && isToken(T[j], "=")) {
        init = j;
        j = expressionEnd(T, j + 1, this.end);
      }
      names.push({ tok, dims, init });
      if (j >= this.end || !isToken(T[j], ",")) break;
      j++;
      const next = word(T[j]);
      if (CICODE_TYPES.has(next) || SCOPE_WORDS.has(next)) break;
    }
    return stmt("decl", i, j, depth, { scopeTok, typeTok, names });
  }
}

/** Parsed body of function `f` of `text` (memoized with the tokens). */
export function functionBody(text: string, f: FunctionRange): FunctionBody {
  const T = tokensOf(text);
  const bodies = memo!.bodies;
  const cached = bodies.get(f.headerIndex);
  if (cached) return cached;
  const start = tokenAt(T, f.startOffset);
  let end = tokenAt(T, f.endOffset);
  if (f.closed && end > start && isToken(T[end - 1], "END")) end--;
  const typed = f.returnType !== "VOID";
  const body: FunctionBody = {
    tokens: T,
    stmts: new BodyParser(T, end, typed).body(start),
    start,
    end,
  };
  bodies.set(f.headerIndex, body);
  return body;
}

/** Calls `visit` for every statement, nested ones included, in order. */
export function walkStatements(
  stmts: readonly Stmt[],
  visit: (s: Stmt) => void,
): void {
  for (const s of stmts) {
    visit(s);
    for (const b of s.blocks) walkStatements(b, visit);
  }
}

// =============================================================================
// Call arguments
// =============================================================================

export interface ArgSlot {
  /** Name token of the called function. */
  readonly callee: number;
  /** Position of the argument (0-based). */
  readonly index: number;
  /** The name is the whole argument, e.g. `Fn` in `OnEvent(5, Fn)`. */
  readonly whole: boolean;
}

/** For each name token in [start, end) inside the arguments of a call: the
 *  innermost call and which of its arguments holds the name. */
export function nameArguments(
  T: readonly Token[],
  start: number,
  end: number,
): Map<number, ArgSlot> {
  const out = new Map<number, ArgSlot>();
  // One frame per open bracket; callee -1 for grouping parens and indexes.
  const stack: Array<{ callee: number; index: number }> = [];
  for (let k = start; k < end; k++) {
    const t = T[k];
    if (isStatementWord(t) || isToken(t, ";")) {
      stack.length = 0;
    } else if (isToken(t, "(") || isToken(t, "[")) {
      const call = t.text === "(" && k > start && isIdentifier(T[k - 1]);
      stack.push({ callee: call ? k - 1 : -1, index: 0 });
    } else if (isToken(t, ")") || isToken(t, "]")) {
      stack.pop();
    } else if (isToken(t, ",")) {
      if (stack.length) stack[stack.length - 1].index++;
    } else if (isIdentifier(t)) {
      let f = stack.length - 1;
      while (f >= 0 && stack[f].callee < 0) f--;
      if (f < 0) continue;
      const whole =
        f === stack.length - 1 &&
        (isToken(T[k - 1], "(") || isToken(T[k - 1], ",")) &&
        (isToken(T[k + 1], ",") || isToken(T[k + 1], ")"));
      out.set(k, { callee: stack[f].callee, index: stack[f].index, whole });
    }
  }
  return out;
}

/**
 * How the compiler takes a bare name as argument `index` of a call to
 * `name`: "function" for a FUNCTION parameter of a built-in (a callback,
 * the name of an INT Cicode function without parameters), "vararg" for the
 * variable part of a VARARG built-in, "value" for any other parameter;
 * undefined when not known. A function-like label is followed into its
 * text when it passes the parameter on as a whole argument of one call.
 */
export function argumentKind(
  indexer: Indexer,
  name: string,
  index: number,
  file: string,
  nested = false,
): "function" | "vararg" | "value" | undefined {
  const fn = indexer.getFunctionFor(name, file);
  if (!fn) return undefined;
  if (fn.origin === "label") {
    if (nested) return undefined;
    const raw = fn.params[index]?.split("=")[0].trim();
    if (!raw) return undefined;
    const param = upperAscii(raw);
    const L = lexTokens(fn.expr ?? "");
    if (
      !isIdentifier(L[0]) ||
      !isToken(L[1], "(") ||
      closeEnd(L, 1, L.length) !== L.length
    ) {
      return undefined;
    }
    const at = nameArguments(L, 0, L.length);
    for (let k = 2; k < L.length; k++) {
      const slot = at.get(k);
      if (slot?.callee === 0 && slot.whole && L[k].text === param) {
        return argumentKind(indexer, L[0].text, slot.index, file, true);
      }
    }
    return undefined;
  }
  if (fn.origin === "cicode") return "value";
  const types = fn.argTypes;
  if (!types?.length) return undefined;
  const last = types[types.length - 1].toUpperCase();
  const t =
    index < types.length
      ? types[index].toUpperCase()
      : last === "VARARG"
        ? last
        : undefined;
  if (t === "FUNCTION") return "function";
  if (t === "VARARG") return "vararg";
  return t ? "value" : undefined;
}

// =============================================================================
// Compile units
// =============================================================================

/**
 * The definitions a call to `name` in `file` reaches, getFunctionFor's
 * first, then one per other compile unit of the file that reaches another
 * (a project compiled by several roots). Empty when none is defined.
 */
export function reachedFunctions(
  indexer: Indexer,
  name: string,
  file: string,
  perUnit = indexer.getFunctionsByUnit(name, file),
): FunctionInfo[] {
  const out: FunctionInfo[] = [];
  for (const { fn } of perUnit) {
    if (fn && !out.includes(fn)) out.push(fn);
  }
  return out;
}

/** True when every project compiled with `file` is known: every include row
 *  of its units resolved and each project is indexed (the workspace's, or
 *  read from disk for an opened file's project), so a name none of them
 *  defines is unknown to the compiler. A folder no project owns, or one
 *  inside a project's folder (an overlay: the compiler reads <PATH>\*.ci
 *  only), is compiled by no root, so nothing is certain. */
export function unitsKnown(indexer: Indexer, file: string): boolean {
  return !indexer.projects.projectOf(file).stray && unitComplete(indexer, file);
}

// =============================================================================
// Labels
// =============================================================================

export interface LabelDef {
  /** Replacement text. */
  readonly expr: string;
  /** Function-like label with a parameter that has no default: expanding
   *  it without arguments is E2057 (Label argument error). */
  readonly needsArgs: boolean;
  /** The replacement is a single name (the label renames). */
  readonly isName: boolean;
  /** labels.DBF it comes from ("" for the shipped Include labels). */
  readonly file: string;
  /** Include project label (every project compiles with it). */
  readonly include: boolean;
}

/** The label `name` expands in `file` (the compiler replaces every name
 *  that is a label of its compile, declarations included), or undefined. */
export function labelOf(
  indexer: Indexer,
  name: string,
  file: string,
): LabelDef | undefined {
  if (!indexer.isKnownLabel(name, file)) return undefined;
  const fn = indexer.getFunctionFor(name, file);
  if (fn?.origin === "label") {
    const expr = fn.expr ?? "";
    return {
      expr,
      needsArgs: (fn.minArgs ?? 0) > 0,
      isName: isSingleName(expr),
      file: fn.file ?? "",
      include: fn.library?.toLowerCase() === "include",
    };
  }
  const c = indexer.getLabel(name, file);
  if (!c) return undefined;
  return {
    expr: c.expr,
    needsArgs: false,
    isName: isSingleName(c.expr),
    file: c.file,
    include: false,
  };
}

const exprInfo = new Map<string, { single: boolean; structural: boolean }>();

function infoOf(expr: string): { single: boolean; structural: boolean } {
  let r = exprInfo.get(expr);
  if (r === undefined) {
    const T = lexTokens(expr);
    r = {
      single: T.length === 1 && isIdentifier(T[0]),
      structural: structural(T),
    };
    if (exprInfo.size > 5000) exprInfo.clear();
    exprInfo.set(expr, r);
  }
  return r;
}

function isSingleName(expr: string): boolean {
  return infoOf(expr).single;
}

/** True when label text holds block keywords that are not whole statements
 *  (such as `ENDIF = END` or `FOREVER = WHILE 1 DO`): code using it has a
 *  block structure the text doesn't show. */
function structural(T: readonly Token[]): boolean {
  if (!T.some((t) => isStatementWord(t) && !CICODE_TYPES.has(t.text))) {
    return false;
  }
  const stmts = new BodyParser(T, T.length, true).body(0);
  if (!stmts.length || stmts[stmts.length - 1].end !== T.length) return true;
  let broken = false;
  walkStatements(stmts, (s) => {
    const block =
      s.kind === "if" ||
      s.kind === "while" ||
      s.kind === "select" ||
      (s.kind === "for" && (s.forTo ?? -1) >= 0);
    if (s.kind === "stray" || (block && (s.close < 0 || s.opener < 0))) {
      broken = true;
    }
  });
  return broken;
}

/** True when `name` is a label of `file`'s compile whose text changes the
 *  block structure, or one named like a reserved word (it replaces the
 *  keyword). */
export function isStructuralLabel(
  indexer: Indexer,
  name: string,
  file: string,
): boolean {
  const lab = labelOf(indexer, name, file);
  if (!lab) return false;
  return RESERVED_WORDS.has(name.toUpperCase()) || infoOf(lab.expr).structural;
}

/** True when a label used in tokens [start, end) of `file` changes the
 *  block structure, so the parsed statements may not be the compiler's. */
export function usesStructuralLabel(
  indexer: Indexer,
  file: string,
  text: string,
  T: readonly Token[],
  start: number,
  end: number,
): boolean {
  for (let k = start; k < end; k++) {
    const t = T[k];
    if (
      t.kind === "w" &&
      isStructuralLabel(indexer, text.slice(t.start, t.end), file)
    ) {
      return true;
    }
  }
  return false;
}

/** Is `lab` certainly compiled with `file`? True for the shipped Include
 *  labels (every project includes Include) and a labels.DBF of a project
 *  sharing a compile unit with the file, the only ones labelOf finds. */
export function labelCertain(
  indexer: Indexer,
  lab: LabelDef,
  file: string,
): boolean {
  if (lab.include) return true;
  return !!lab.file && inCompile(indexer, file, lab.file);
}

// Per visible label set (getAllLabels, rebuilt on any change): whether a
// label expands to a type.
const typeLabelSets = new WeakMap<ReadonlyMap<string, LabelRecord>, boolean>();

/** True when some label of `file`'s compile expands to a type:
 *  declarations and headers written with it are not indexed as such. */
export function hasTypeLabels(indexer: Indexer, file: string): boolean {
  const labels = indexer.getAllLabels(file);
  let has = typeLabelSets.get(labels);
  if (has === undefined) {
    has = false;
    for (const rec of labels.values()) {
      if (CICODE_TYPES.has(rec.expr.trim().toUpperCase())) {
        has = true;
        break;
      }
    }
    typeLabelSets.set(labels, has);
  }
  return has;
}

/** Upper-case type the label `name` of `file`'s compile expands to, when it
 *  is one of the six types. */
export function typeLabel(
  indexer: Indexer,
  name: string,
  file: string,
): string | undefined {
  const e = indexer.getLabel(name, file)?.expr.trim().toUpperCase();
  return e && CICODE_TYPES.has(e) ? e : undefined;
}

/** Short form of a label's text for messages. */
export function shortExpr(expr: string): string {
  const s = expr.replace(/\s+/g, " ").trim();
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}
