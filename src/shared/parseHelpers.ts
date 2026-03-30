import * as vscode from "vscode";
import { escapeRegExp } from "./utils";
import { BLOCK_OPENERS } from "./constants";
import type { FunctionRange } from "../core/indexer/types";

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
  inSQ: boolean;
  esc: boolean;
  /** True if we just jumped past ignored content (comment/string span) */
  jumped: boolean;
  /** Position we jumped from (valid when jumped=true) */
  jumpedFrom: number;
}

type ScanAction = "continue" | "stop" | { result: number };

/**
 * Scans text character by character, handling:
 * - Quote strings (single and double)
 * - Escape sequences (^ in Cicode)
 * - Parenthesis depth tracking
 * - Ignored spans (comments/strings from buildIgnoreSpans)
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
    inSQ: false,
    esc: false,
    jumped: false,
    jumpedFrom: 0,
  };

  while (state.pos < endPos) {
    // Skip ignored spans and flag that we jumped (content was present)
    const jumpedTo = advancePastIgnored(state.pos, ignore);
    if (jumpedTo !== state.pos) {
      state.jumped = true;
      state.jumpedFrom = state.pos;
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
    if (state.inDQ || state.inSQ) {
      if (ch === "^") {
        state.esc = true;
        state.pos++;
        continue;
      }
      if (state.inDQ && ch === '"') {
        state.inDQ = false;
        state.pos++;
        continue;
      }
      if (state.inSQ && ch === "'") {
        state.inSQ = false;
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
    if (ch === "'") {
      const action = onChar(ch, state);
      if (action === "stop") return state.pos;
      if (typeof action === "object") return action.result;
      state.inSQ = true;
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
 * Count the number of top-level arguments (comma-separated) in a range.
 */
export function countArgsTopLevel(
  text: string,
  startAbs: number,
  endAbs: number,
  ignore: Array<[number, number]>,
): number {
  let count = 0;
  let sawToken = false;

  const flush = () => {
    if (sawToken) {
      count++;
      sawToken = false;
    }
  };

  scanText(text, startAbs, endAbs, ignore, (ch, state) => {
    // Jumped past ignored content (like a string in ignore spans) counts as a token
    if (state.jumped) {
      sawToken = true;
      state.jumped = false;
    }
    // Parens and quotes count as tokens
    if (ch === "(" || ch === ")" || ch === '"' || ch === "'") {
      sawToken = true;
      return "continue";
    }
    if (ch === "," && state.depth === 0) {
      flush();
      return "continue";
    }
    if (!/\s/.test(ch)) sawToken = true;
    return "continue";
  });

  flush();
  return count;
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
    if (ch === "(" || ch === ")" || ch === '"' || ch === "'") {
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
 * string literals or nested parentheses. Use this instead of plain .split(",")
 * when default values may contain commas (e.g. `sCol = "A,B,C"`).
 */
export function splitParamsTopLevel(raw: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let inDQ = false;
  let inSQ = false;
  let esc = false;
  let start = 0;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "^") {
      esc = true;
      continue;
    }
    if (inDQ) {
      if (ch === '"') inDQ = false;
      continue;
    }
    if (inSQ) {
      if (ch === "'") inSQ = false;
      continue;
    }
    if (ch === '"') {
      inDQ = true;
      continue;
    }
    if (ch === "'") {
      inSQ = true;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      continue;
    }
    if (ch === "," && depth === 0) {
      result.push(raw.slice(start, i).trim());
      start = i + 1;
    }
  }

  const last = raw.slice(start).trim();
  if (last) result.push(last);
  return result;
}

// =============================================================================
// Definition Offset Utilities
// =============================================================================

/**
 * Build the set of text offsets where function names are *defined* (not
 * referenced). Used to exclude definition sites from reference/rename results.
 */
export function buildDefinitionOffsets(
  text: string,
  functionRanges: ReadonlyArray<{ name: string; headerIndex: number }>,
): Set<number> {
  const offsets = new Set<number>();
  for (const fr of functionRanges) {
    let parenPos = text.indexOf("(", fr.headerIndex);
    if (parenPos < 0) parenPos = fr.headerIndex;
    const headerRegion = text.slice(fr.headerIndex, parenPos);
    const nameRe = new RegExp(`\\b${escapeRegExp(fr.name)}\\b`, "i");
    const nm = nameRe.exec(headerRegion);
    if (nm) offsets.add(fr.headerIndex + nm.index);
  }
  return offsets;
}

/**
 * Returns the function body text and its absolute offsets within `text`.
 * Eliminates the repeated 3-line boilerplate across diagnostic rules.
 */
export function getFunctionBodyText(
  f: FunctionRange,
  text: string,
  doc: vscode.TextDocument,
): { body: string; bodyStartAbs: number; bodyEndAbs: number } {
  const bodyStartAbs = doc.offsetAt(f.bodyRange.start);
  const bodyEndAbs = doc.offsetAt(f.bodyRange.end);
  return {
    body: text.slice(bodyStartAbs, bodyEndAbs),
    bodyStartAbs,
    bodyEndAbs,
  };
}

/**
 * Maintains block nesting depth while TOKEN_RE iterates a function body.
 * Handles `END SELECT` / `END IF` / `END FOR` / `END WHILE` by skipping the
 * trailing keyword when it appears on the same line as END.
 *
 * Mutates `state.depth` and `state.endLine` in place.
 * Returns `"continue"` when the caller should skip the current token.
 */
export function trackBlockDepth(
  word: string,
  absPos: number,
  doc: vscode.TextDocument,
  state: { depth: number; endLine: number },
): "continue" | void {
  if (state.endLine !== -1) {
    const sameLine = doc.positionAt(absPos).line === state.endLine;
    state.endLine = -1;
    if (sameLine && BLOCK_OPENERS.has(word)) return "continue";
  }
  if (word === "END") {
    state.endLine = doc.positionAt(absPos).line;
    if (state.depth > 0) state.depth--;
  } else if (BLOCK_OPENERS.has(word)) {
    state.depth++;
  }
}
