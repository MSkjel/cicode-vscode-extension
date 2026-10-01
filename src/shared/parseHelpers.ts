import { escapeRegExp } from "./utils";
import { NAME_CHARS } from "./constants";
import {
  isCommentStart,
  isNameChar,
  nameKey,
  scanIgnoreSpans,
  skipBlank,
} from "./textUtils";

// =============================================================================
// Span Utilities
// =============================================================================

function spanLowerBound(spans: Array<[number, number]>, pos: number): number {
  let lo = 0,
    hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid][1] <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function advancePastIgnored(
  pos: number,
  spans: Array<[number, number]>,
): number {
  if (!spans.length) return pos;
  const idx = spanLowerBound(spans, pos);
  if (idx < spans.length) {
    const [s, e] = spans[idx];
    if (pos >= s && pos < e) return e;
  }
  return pos;
}

// =============================================================================
// Character Scanner - shared quote/escape/paren handling
// =============================================================================

interface ScanState {
  pos: number;
  depth: number;
  inDQ: boolean;
  esc: boolean;
  /** True if we just jumped past a token span (string, `|...|`, format
   *  picture); comments are skipped like whitespace. */
  jumped: boolean;
  /** Start of the first token span jumped (valid when jumped=true) */
  jumpedFrom: number;
}

type ScanAction = "continue" | "stop" | { result: number };

/**
 * Scans text character by character, handling:
 * - Double-quoted strings (Cicode has no single-quoted strings)
 * - Escape sequences (^ in Cicode, only inside strings)
 * - Parenthesis depth tracking
 * - Ignored spans (from buildIgnoreSpans)
 *
 * The callback receives the current character and state, and returns an action.
 */
function scanText(
  text: string,
  startPos: number,
  endPos: number,
  ignore: Array<[number, number]>,
  onChar: (ch: string, state: ScanState) => ScanAction,
): number {
  const state: ScanState = {
    pos: startPos,
    depth: 0,
    inDQ: false,
    esc: false,
    jumped: false,
    jumpedFrom: 0,
  };

  while (state.pos < endPos) {
    // Skip ignored spans and flag that we jumped past a token
    const jumpedTo = advancePastIgnored(state.pos, ignore);
    if (jumpedTo !== state.pos) {
      if (!state.jumped && !isCommentStart(text, state.pos)) {
        state.jumped = true;
        state.jumpedFrom = state.pos;
      }
      state.pos = jumpedTo;
      continue;
    }

    const ch = text[state.pos];

    // Handle escape sequences
    if (state.esc) {
      state.esc = false;
      state.pos++;
      continue;
    }

    // Inside a quoted string
    if (state.inDQ) {
      if (ch === "^") {
        state.esc = true;
        state.pos++;
        continue;
      }
      if (ch === '"') {
        state.inDQ = false;
        state.pos++;
        continue;
      }
      state.pos++;
      continue;
    }

    // Enter quoted string - call callback first so it can track token start
    if (ch === '"') {
      const action = onChar(ch, state);
      if (action === "stop") return state.pos;
      if (typeof action === "object") return action.result;
      state.inDQ = true;
      state.pos++;
      continue;
    }

    // Track parenthesis depth and call callback
    if (ch === "(") {
      state.depth++;
      const action = onChar(ch, state);
      if (action === "stop") return state.pos;
      if (typeof action === "object") return action.result;
      state.pos++;
      continue;
    }
    if (ch === ")") {
      state.depth--;
      const action = onChar(ch, state);
      if (action === "stop") return state.pos;
      if (typeof action === "object") return action.result;
      state.pos++;
      continue;
    }

    // Let callback handle other characters
    const action = onChar(ch, state);
    if (action === "stop") return state.pos;
    if (typeof action === "object") return action.result;
    state.pos++;
  }

  // If we jumped right to endPos, notify callback so it can handle the pending content
  if (state.jumped) {
    onChar("", state);
  }

  return -1;
}

// =============================================================================
// Exported Functions
// =============================================================================

/**
 * Find the matching closing parenthesis for an opening paren.
 */
export function findMatchingParen(
  text: string,
  openPos: number,
  ignore: Array<[number, number]>,
): number {
  let depth = 1;

  return scanText(text, openPos + 1, text.length, ignore, (ch, state) => {
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) return { result: state.pos };
    }
    return "continue";
  });
}

/**
 * Slice argument spans at top level (for inlay hints).
 */
export function sliceTopLevelArgSpans(
  text: string,
  argsStartAbs: number,
  argsEndAbs: number,
  ignore: Array<[number, number]>,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let tokStart = -1;

  const pushTok = (endPos: number) => {
    if (tokStart >= 0) {
      const raw = text.slice(tokStart, endPos);
      if (raw.trim().length) out.push({ start: tokStart, end: endPos });
      tokStart = -1;
    }
  };

  scanText(text, argsStartAbs, argsEndAbs, ignore, (ch, state) => {
    // Jumped past ignored content - use the jump start position as token start
    if (state.jumped) {
      if (tokStart < 0) tokStart = state.jumpedFrom;
      state.jumped = false;
    }
    // Parens and quotes start tokens
    if (ch === "(" || ch === ")" || ch === '"') {
      if (tokStart < 0) tokStart = state.pos;
      return "continue";
    }
    if (ch === "," && state.depth === 0) {
      pushTok(state.pos);
      return "continue";
    }
    if (!/\s/.test(ch) && tokStart < 0) tokStart = state.pos;
    return "continue";
  });

  pushTok(argsEndAbs);
  return out;
}

/**
 * Splits a raw parameter string on top-level commas, ignoring commas inside
 * string literals, comments or nested parentheses. Use this instead of plain
 * .split(",") when default values may contain commas (e.g. `sCol = "A,B,C"`).
 * Comments (allowed anywhere in a header) are dropped from the results.
 */
export function splitParamsTopLevel(raw: string): string[] {
  const result: string[] = [];
  const spans = scanIgnoreSpans(raw);
  let k = 0;
  let depth = 0;
  let cur = "";
  // A removed comment leaves one space; whitespace after it is dropped.
  let afterComment = false;

  for (let i = 0; i < raw.length; ) {
    while (k < spans.length && spans[k][1] <= i) k++;
    if (k < spans.length && spans[k][0] === i) {
      const [s, e] = spans[k];
      if (isCommentStart(raw, s)) {
        cur = cur.trimEnd() + " ";
        afterComment = true;
      } else {
        cur += raw.slice(s, e);
        afterComment = false;
      }
      i = e;
      continue;
    }
    const ch = raw[i++];
    if (afterComment && /\s/.test(ch)) continue;
    afterComment = false;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      result.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }

  const last = cur.trim();
  if (last) result.push(last);
  return result;
}

// =============================================================================
// Definition Offset Utilities
// =============================================================================

/**
 * Build the set of text offsets where function names are *defined* (not
 * referenced): the indexer's `nameOffset` when given, else the name found
 * after FUNCTION. Used to exclude definition sites from reference/rename
 * results.
 */
export function buildDefinitionOffsets(
  text: string,
  functionRanges: ReadonlyArray<{
    name: string;
    headerIndex: number;
    nameOffset?: number;
  }>,
): Set<number> {
  const offsets = new Set<number>();
  for (const fr of functionRanges) {
    if (fr.nameOffset !== undefined) {
      offsets.add(fr.nameOffset);
      continue;
    }
    // The name is the token after FUNCTION; comments may sit between them.
    // nameKey keeps offsets (it only changes the case of ASCII letters).
    const name = nameKey(fr.name);
    let at = fr.headerIndex;
    if (nameKey(text.slice(at, at + 8)) === "function") {
      at = skipBlank(text, at + 8);
    }
    if (
      nameKey(text.slice(at, at + name.length)) === name &&
      !isNameChar(text[at + name.length])
    ) {
      offsets.add(at);
      continue;
    }
    let parenPos = text.indexOf("(", fr.headerIndex);
    if (parenPos < 0) parenPos = fr.headerIndex;
    const headerRegion = nameKey(text.slice(fr.headerIndex, parenPos));
    // \b is ASCII-only; names may hold cp1252 letters and '\'.
    const nameRe = new RegExp(
      `(?<![${NAME_CHARS}])${escapeRegExp(name)}(?![${NAME_CHARS}])`,
    );
    const nm = nameRe.exec(headerRegion);
    if (nm) offsets.add(fr.headerIndex + nm.index);
  }
  return offsets;
}
