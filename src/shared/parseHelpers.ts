import { inSpan } from "./textUtils";

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

export function findMatchingParen(
  text: string,
  openPos: number,
  ignore: Array<[number, number]>,
): number {
  let i = openPos + 1;
  let depth = 1;
  let inDQ = false,
    inSQ = false,
    esc = false;
  while (i < text.length) {
    const jumped = advancePastIgnored(i, ignore);
    if (jumped !== i) {
      i = jumped;
      continue;
    }
    const ch = text[i];
    if (inDQ || inSQ) {
      if (esc) {
        esc = false;
        i++;
        continue;
      }
      if (ch === "^") {
        esc = true;
        i++;
        continue;
      }
      if (inDQ && ch === '"') {
        inDQ = false;
        i++;
        continue;
      }
      if (inSQ && ch === "'") {
        inSQ = false;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inDQ = true;
      i++;
      continue;
    }
    if (ch === "'") {
      inSQ = true;
      i++;
      continue;
    }
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

export function countArgsTopLevel(
  text: string,
  startAbs: number,
  endAbs: number,
  ignore: Array<[number, number]>,
): number {
  let depth = 0;
  let i = startAbs;
  let count = 0;
  let sawToken = false;
  let inDQ = false,
    inSQ = false,
    esc = false;
  const flush = () => {
    if (sawToken) {
      count++;
      sawToken = false;
    }
  };
  while (i < endAbs) {
    const jumped = advancePastIgnored(i, ignore);
    if (jumped !== i) {
      sawToken = true;
      i = jumped;
      continue;
    }
    const ch = text[i];
    if (inDQ || inSQ) {
      if (esc) {
        esc = false;
        i++;
        continue;
      }
      if (ch === "^") {
        esc = true;
        i++;
        continue;
      }
      if (inDQ && ch === '"') {
        inDQ = false;
        i++;
        continue;
      }
      if (inSQ && ch === "'") {
        inSQ = false;
        i++;
        continue;
      }
      sawToken = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inDQ = true;
      sawToken = true;
      i++;
      continue;
    }
    if (ch === "'") {
      inSQ = true;
      sawToken = true;
      i++;
      continue;
    }
    if (ch === "(") {
      depth++;
      sawToken = true;
      i++;
      continue;
    }
    if (ch === ")") {
      if (depth > 0) depth--;
      sawToken = true;
      i++;
      continue;
    }
    if (ch === "," && depth === 0) {
      flush();
      i++;
      continue;
    }
    if (!/\s/.test(ch)) sawToken = true;
    i++;
  }
  flush();
  return count;
}

export function sliceTopLevelArgSpans(
  text: string,
  argsStartAbs: number,
  argsEndAbs: number,
  ignore: Array<[number, number]>,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let i = argsStartAbs;
  let depth = 0;
  let tokStart = -1;
  let inDQ = false,
    inSQ = false,
    esc = false;
  const pushTok = (endPos: number) => {
    if (tokStart >= 0) {
      const raw = text.slice(tokStart, endPos);
      if (raw.trim().length) out.push({ start: tokStart, end: endPos });
      tokStart = -1;
    }
  };
  while (i < argsEndAbs) {
    const jumped = advancePastIgnored(i, ignore);
    if (jumped !== i) {
      if (tokStart < 0) tokStart = i;
      i = jumped;
      continue;
    }
    const ch = text[i];
    if (inDQ || inSQ) {
      if (esc) {
        esc = false;
        i++;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        i++;
        continue;
      }
      if (inDQ && ch === '"') {
        inDQ = false;
        i++;
        continue;
      }
      if (inSQ && ch === "'") {
        inSQ = false;
        i++;
        continue;
      }
      if (tokStart < 0) tokStart = i;
      i++;
      continue;
    }
    if (ch === '"') {
      inDQ = true;
      if (tokStart < 0) tokStart = i;
      i++;
      continue;
    }
    if (ch === "'") {
      inSQ = true;
      if (tokStart < 0) tokStart = i;
      i++;
      continue;
    }
    if (ch === "(") {
      depth++;
      if (tokStart < 0) tokStart = i;
      i++;
      continue;
    }
    if (ch === ")") {
      if (depth > 0) depth--;
      if (tokStart < 0) tokStart = i;
      i++;
      continue;
    }
    if (ch === "," && depth === 0) {
      pushTok(i);
      i++;
      continue;
    }
    if (!/\s/.test(ch) && tokStart < 0) tokStart = i;
    i++;
  }
  pushTok(argsEndAbs);
  return out;
}
