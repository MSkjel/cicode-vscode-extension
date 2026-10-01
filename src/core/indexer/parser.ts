import { CICODE_TYPES, TAG_ONLY_TYPES } from "../../shared/constants";
import { OPERATOR_WORDS } from "../../shared/textUtils";
import { isIdentifier, isToken, lex, type Token } from "./lexer";

export interface ParsedParam {
  /** Parameter source with comments removed and whitespace collapsed. */
  readonly text: string;
  /** Upper-case type word ("UNKNOWN" when untyped), plus "[..]" for arrays. */
  readonly type: string;
  readonly name: string;
  readonly nameStart: number;
  readonly hasDefault: boolean;
}

export interface ParsedFunction {
  /** Offset of the first header token (scope, type or FUNCTION). */
  readonly itemStart: number;
  readonly keywordStart: number;
  readonly name: string;
  readonly nameStart: number;
  readonly nameEnd: number;
  /** Scope keyword in front of the header, upper-case. */
  readonly scope?: string;
  /** Explicit return type word, upper-case. */
  readonly returnType?: string;
  readonly hasParens: boolean;
  /** Parameter list span (inside the parentheses). */
  readonly paramsStart: number;
  readonly paramsEnd: number;
  readonly params: ParsedParam[];
  /** End of the header: after ')' or, without parentheses, after the name. */
  readonly headerEnd: number;
  /** End of the body: after its END, or where the next header starts. */
  readonly bodyEnd: number;
  /** False when the body has no END. */
  readonly closed: boolean;
}

export interface ParsedDecl {
  /** GLOBAL/MODULE keyword of a file-scope declaration. */
  readonly scope?: "GLOBAL" | "MODULE";
  /** Upper-case type word. */
  readonly type: string;
  readonly name: string;
  readonly nameStart: number;
  /** Array dimension texts, e.g. ["5", "2"] for [5][2]. */
  readonly dims: string[];
  /** Index of the enclosing function in `functions`, or -1 at file scope. */
  readonly fn: number;
}

export interface ParsedFile {
  readonly functions: ParsedFunction[];
  readonly declarations: ParsedDecl[];
  /** Comment spans `[start, end)`, sorted. */
  readonly comments: Array<[number, number]>;
}

/** `text[start, end)` with comment characters (not line breaks) replaced by
 *  spaces, so offsets are preserved. */
export function blankComments(
  text: string,
  start: number,
  end: number,
  comments: Array<[number, number]>,
): string {
  let lo = 0;
  let hi = comments.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (comments[mid][1] <= start) lo = mid + 1;
    else hi = mid;
  }
  let out = "";
  let pos = start;
  for (let k = lo; k < comments.length && comments[k][0] < end; k++) {
    const a = Math.max(pos, comments[k][0]);
    const b = Math.min(end, comments[k][1]);
    out += text.slice(pos, a) + text.slice(a, b).replace(/[^\r\n]/g, " ");
    pos = b;
  }
  return out + text.slice(pos, end);
}

const SCOPES = new Set(["GLOBAL", "MODULE", "PUBLIC", "PRIVATE"]);

// Tag data types and BOOLEAN are not Cicode types; declarations using them
// are still collected so the invalid-type rule can report them.
const PSEUDO_TYPES = new Set([...TAG_ONLY_TYPES, "BOOLEAN"]);

const isType = (t: Token | undefined): boolean =>
  t !== undefined &&
  t.kind === "w" &&
  (CICODE_TYPES.has(t.text) || PSEUDO_TYPES.has(t.text));

const isCicodeType = (t: Token | undefined): boolean =>
  t !== undefined && t.kind === "w" && CICODE_TYPES.has(t.text);

const isScope = (t: Token | undefined): boolean =>
  t !== undefined && t.kind === "w" && SCOPES.has(t.text);

// Keywords that cannot occur inside an expression.
const STATEMENT_KEYWORDS = new Set([
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

const isStatementKeyword = (t: Token | undefined): boolean =>
  t !== undefined && t.kind === "w" && STATEMENT_KEYWORDS.has(t.text);

/** A name (not a word operator), number or string. `(` is not counted: after
 *  a name it makes a call. */
const startsOperand = (t: Token): boolean =>
  t.kind === "n" ||
  t.kind === "s" ||
  (t.kind === "w" && !OPERATOR_WORDS.has(t.text));

const endsOperand = (t: Token): boolean =>
  startsOperand(t) ||
  isToken(t, ")") ||
  isToken(t, "]") ||
  (t.kind === "p" && t.text[0] === "#");

/**
 * Parses the item structure of a Cicode file the way the compiler reads it:
 * `[scope] [type] FUNCTION name [(params)] body END` and
 * `[scope] type name ...` at file scope, block nesting, and local
 * declarations at the top level of bodies. Newlines and semicolons carry no
 * meaning. Labels are not expanded, so labels that supply block keywords
 * or types are not modelled.
 */
export function parseCicode(text: string): ParsedFile {
  const { tokens: T, comments } = lex(text);
  const n = T.length;
  const functions: ParsedFunction[] = [];
  const declarations: ParsedDecl[] = [];

  const src = (t: Token) => text.slice(t.start, t.end);

  /** Source of [start, end) without comments, whitespace collapsed. */
  const cleanSlice = (start: number, end: number): string =>
    blankComments(text, start, end, comments).replace(/\s+/g, " ").trim();

  const readDims = (i: number): { dims: string[]; next: number } => {
    const dims: string[] = [];
    while (isToken(T[i], "[")) {
      let j = i + 1;
      while (j < n && !isToken(T[j], "]")) j++;
      dims.push(j > i + 1 ? cleanSlice(T[i + 1].start, T[j - 1].end) : "");
      i = Math.min(j + 1, n);
    }
    return { dims, next: i };
  };

  /** File-scope declarator list; initializers are single literals. */
  const parseFileDecl = (
    i: number,
    type: string,
    scope: "GLOBAL" | "MODULE" | undefined,
  ): number => {
    for (;;) {
      const nameTok = T[i];
      if (!isIdentifier(nameTok)) return i;
      const { dims, next } = readDims(i + 1);
      declarations.push({
        scope,
        type,
        name: src(nameTok),
        nameStart: nameTok.start,
        dims,
        fn: -1,
      });
      i = next;
      if (isToken(T[i], "=")) {
        // One value per element; the comma after the last value ends the
        // declaration, so `MODULE INT a = 1, b = 2;` declares only a.
        const size = dims.reduce((p, d) => p * (Number(d) || 1), 1);
        i++;
        for (let values = 1; ; values++) {
          if (isToken(T[i], "-") || isToken(T[i], "+")) i++;
          if (i < n) i++;
          if (!isToken(T[i], ",")) return i;
          i++;
          if (values >= size) return i;
        }
      }
      if (!isToken(T[i], ",")) return i;
      i++;
      // `INT a, INT b` declares b in a new declaration, without the scope
      // keyword of the first. Only the six types start one: `INT a, LONG b`
      // declares a name LONG.
      if (isCicodeType(T[i])) return i;
    }
  };

  /** Local declarator list; initializers are expressions. */
  const parseLocalDecl = (
    i: number,
    type: string,
    fn: number,
    record: boolean,
  ): number => {
    for (;;) {
      const nameTok = T[i];
      if (!isIdentifier(nameTok)) return i;
      const { dims, next } = readDims(i + 1);
      if (record) {
        declarations.push({
          type,
          name: src(nameTok),
          nameStart: nameTok.start,
          dims,
          fn,
        });
      }
      i = next;
      if (isToken(T[i], "=")) {
        // The expression also ends where an operand follows an operand:
        // in `INT a = 1` + line break + `LONG b;`, `LONG b` are statements.
        let depth = 0;
        let afterOperand = false;
        for (i++; i < n; i++) {
          const t = T[i];
          if (depth <= 0 && afterOperand && startsOperand(t)) break;
          if (isToken(t, "(") || isToken(t, "[")) depth++;
          else if (isToken(t, ")") || isToken(t, "]")) depth--;
          else if (
            depth <= 0 &&
            (isToken(t, ",") || isToken(t, ";") || isStatementKeyword(t))
          ) {
            break;
          }
          afterOperand = endsOperand(t);
        }
      }
      if (!isToken(T[i], ",")) return i;
      i++;
      if (isCicodeType(T[i])) return i;
    }
  };

  /** Does the FOR at `i` open a block? Only `FOR var = ... TO` does. */
  const forOpensBlock = (i: number): boolean => {
    if (!isIdentifier(T[i + 1])) return false;
    let depth = 0;
    for (let j = i + 2; j < n && j < i + 500; j++) {
      const t = T[j];
      if (isToken(t, "(")) depth++;
      else if (isToken(t, ")")) depth--;
      else if (depth <= 0) {
        if (isToken(t, "TO")) return true;
        if (isToken(t, ";") || isStatementKeyword(t)) return false;
      }
    }
    return false;
  };

  const startsLine = (i: number): boolean =>
    i === 0 ||
    isToken(T[i - 1], ";") ||
    text.slice(T[i - 1].end, T[i].start).includes("\n");

  /** Parses a body from token `i` up to its END. */
  const parseBody = (
    i: number,
    fn: number,
  ): { next: number; bodyEnd: number; closed: boolean } => {
    const first = i;
    const blocks: string[] = [];
    while (i < n) {
      const t = T[i];
      if (t.kind !== "w") {
        i++;
        continue;
      }
      switch (t.text) {
        case "FUNCTION": {
          // Missing END (E2076): the next header starts here, together with
          // the scope and type words in front of it.
          let k = i;
          while (k > first && (isType(T[k - 1]) || isScope(T[k - 1]))) k--;
          return {
            next: k,
            bodyEnd: k > first ? T[k - 1].end : T[i].start,
            closed: false,
          };
        }
        case "END": {
          const kind = blocks.pop();
          if (kind === undefined) {
            return { next: i + 1, bodyEnd: t.end, closed: true };
          }
          // Only END SELECT pairs up; after END IF, END WHILE or END FOR
          // the keyword starts a new statement.
          if (kind === "SELECT" && isToken(T[i + 1], "SELECT")) i++;
          i++;
          continue;
        }
        case "IF":
        case "WHILE":
        case "SELECT":
          blocks.push(t.text);
          i++;
          continue;
        case "FOR":
          if (forOpensBlock(i)) blocks.push("FOR");
          i++;
          continue;
      }
      // Declarations exist only at the top level of the body; inside a
      // block, and after GLOBAL or MODULE, they are errors (E2041) and are
      // read past without being recorded.
      if (
        isCicodeType(t) ||
        (blocks.length === 0 &&
          isType(t) &&
          startsLine(i) &&
          isIdentifier(T[i + 1]))
      ) {
        const record = blocks.length === 0 && !(i > first && isScope(T[i - 1]));
        i = parseLocalDecl(i + 1, t.text, fn, record);
        continue;
      }
      i++;
    }
    return { next: n, bodyEnd: text.length, closed: false };
  };

  /** Parameters between the '(' at `open` and the token at `close`. */
  const parseParams = (open: number, close: number): ParsedParam[] => {
    const params: ParsedParam[] = [];
    let start = open + 1;
    let depth = 0;
    for (let j = open + 1; j <= close; j++) {
      if (j < close) {
        const t = T[j];
        if (isToken(t, "(") || isToken(t, "[")) depth++;
        else if (isToken(t, ")") || isToken(t, "]")) depth--;
        if (depth > 0 || !isToken(t, ",")) continue;
      }
      if (j > start) {
        const toks = T.slice(start, j);
        const eq = toks.findIndex((x) => isToken(x, "="));
        const head = eq === -1 ? toks : toks.slice(0, eq);
        const words = head.filter((x) => x.kind === "w");
        const typed = words.length >= 2;
        const nameTok = typed ? words[1] : words[0];
        if (nameTok) {
          const bracket = head.findIndex((x) => isToken(x, "["));
          const arr =
            bracket === -1
              ? ""
              : `[${head
                  .slice(bracket + 1)
                  .filter((x) => !isToken(x, "]"))
                  .map((x) => x.text)
                  .join("")}]`;
          params.push({
            text: cleanSlice(toks[0].start, toks[toks.length - 1].end),
            type: (typed ? words[0].text : "UNKNOWN") + arr,
            name: src(nameTok),
            nameStart: nameTok.start,
            hasDefault: eq !== -1,
          });
        }
      }
      start = j + 1;
    }
    return params;
  };

  /** Index of the ')' closing the '(' at `open`, or of the token where an
   *  unclosed list stops (the first keyword that cannot be in a list). */
  const findParamsClose = (
    open: number,
  ): { close: number; closed: boolean } => {
    let depth = 0;
    for (let k = open; k < n; k++) {
      const x = T[k];
      if (isToken(x, "(")) depth++;
      else if (isToken(x, ")")) {
        if (--depth === 0) return { close: k, closed: true };
      } else if (isStatementKeyword(x) && !isType(x) && !isScope(x)) {
        return { close: k, closed: false };
      }
    }
    return { close: n, closed: false };
  };

  let i = 0;
  let pendingStart = -1;
  let scope: string | undefined;
  let type: string | undefined;

  while (i < n) {
    const t = T[i];
    if (isScope(t)) {
      if (pendingStart === -1) pendingStart = t.start;
      scope ??= t.text;
      i++;
      continue;
    }
    if (type !== undefined && isIdentifier(t)) {
      i = parseFileDecl(
        i,
        type,
        scope === "GLOBAL" || scope === "MODULE" ? scope : undefined,
      );
      pendingStart = -1;
      scope = type = undefined;
      continue;
    }
    if (isType(t)) {
      if (type !== undefined) {
        // A second type word starts a new item.
        pendingStart = -1;
        scope = undefined;
      }
      if (pendingStart === -1) pendingStart = t.start;
      type = t.text;
      i++;
      continue;
    }
    if (isToken(t, "FUNCTION")) {
      const nameTok = T[i + 1];
      const parens = isToken(T[i + 2], "(");
      // The compiler takes any word after FUNCTION as the name (even a
      // keyword); without parentheses only a plain name is accepted here
      // so half-typed headers don't swallow the next item.
      if (
        !nameTok ||
        nameTok.kind !== "w" ||
        (!parens && !isIdentifier(nameTok))
      ) {
        pendingStart = -1;
        scope = type = undefined;
        i++;
        continue;
      }
      let j = i + 2;
      let paramsStart = nameTok.end;
      let paramsEnd = nameTok.end;
      let headerEnd = nameTok.end;
      let params: ParsedParam[] = [];
      if (parens) {
        const { close, closed } = findParamsClose(j);
        paramsStart = T[j].end;
        paramsEnd = closed
          ? T[close].start
          : close > j + 1
            ? T[close - 1].end
            : paramsStart;
        params = parseParams(j, close);
        headerEnd = closed ? T[close].end : paramsEnd;
        j = closed ? close + 1 : close;
      }
      const fn = functions.length;
      const body = parseBody(j, fn);
      functions.push({
        itemStart: pendingStart === -1 ? t.start : pendingStart,
        keywordStart: t.start,
        name: src(nameTok),
        nameStart: nameTok.start,
        nameEnd: nameTok.end,
        scope,
        returnType: type,
        hasParens: parens,
        paramsStart,
        paramsEnd,
        params,
        headerEnd,
        bodyEnd: Math.max(body.bodyEnd, headerEnd),
        closed: body.closed,
      });
      pendingStart = -1;
      scope = type = undefined;
      i = body.next;
      continue;
    }
    // Anything else at file scope is an error (E2031).
    pendingStart = -1;
    scope = type = undefined;
    i++;
  }

  return { functions, declarations, comments };
}
