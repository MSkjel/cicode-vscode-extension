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
