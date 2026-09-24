// Parsing of documentation-style signatures such as
//   INT AlarmAckRec(LONG Record [, STRING ClusterName])
//   DspStr(nAN, sFont, sText [, iLength] [, iAlignMode])
// where "[" opens an optional group that may start on the previous parameter
// and nest, and "Tag1......Tag8" stands for a numbered run of parameters.

/** Return and argument types a signature can carry (the compiler's FUNC0 vocabulary). */
export const SIGNATURE_TYPES = new Set([
  "INT",
  "LONG",
  "REAL",
  "STRING",
  "OBJECT",
  "TIMESTAMP",
  "QUALITY",
  "VARIANT",
  "VOID",
]);

const RANGE_RE = /^(.*?)([A-Za-z_][A-Za-z_]*?)(\d+)\s*\.{2,}\s*(?:\2)?(\d+)$/;

/**
 * Split on commas outside strings (`^` escapes the next character) and
 * outside parentheses, so a default such as `TimestampCreate(1601,1,1)`
 * stays one item.
 */
export function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inStr = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      cur += ch;
      if (ch === "^" && i + 1 < s.length) cur += s[++i];
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Expand "Tag1......Tag8" / "sPriv1..sPriv8" into one parameter per number. */
function expandRange(p: string): string[] {
  const lead = /^[\s[]*/.exec(p)![0];
  const trail = /[\s\]]*$/.exec(p.slice(lead.length))![0];
  const core = p.slice(lead.length, p.length - trail.length);
  const m = RANGE_RE.exec(core);
  if (!m) return [p];
  const [, prefix, base, from, to] = m;
  const a = Number(from);
  const b = Number(to);
  if (!(b > a) || b - a > 64) return [p];
  const out: string[] = [];
  for (let i = a; i <= b; i++) out.push(`${prefix}${base}${i}`);
  out[0] = lead.trim() + out[0];
  out[out.length - 1] += trail.trim();
  return out;
}

/**
 * Split the text between a signature's parentheses into parameters, moving
 * each optional-group bracket onto the parameter it belongs to:
 * "a, b [, c] [, d [, e]]" gives ["a", "b", "[c]", "[d", "[e]]"].
 */
export function splitSignatureParams(inner: string): string[] {
  const out: string[] = [];
  let carry = "";
  for (const piece of splitTopLevelCommas(inner)) {
    let p = carry + piece;
    carry = "";
    const open = /\[[\s[]*$/.exec(p);
    if (open) {
      carry = open[0].replace(/\s+/g, "");
      p = p.slice(0, open.index);
    }
    p = p.replace(/\s+/g, " ").replace(/\[ /g, "[").replace(/ \]/g, "]").trim();
    if (!p.replace(/[[\]\s]/g, "")) {
      // A bare bracket: keep its openings for the next parameter.
      carry = p.replace(/[^[]/g, "") + carry;
      continue;
    }
    out.push(...expandRange(p));
  }
  return out;
}

/** The parameter name in a signature parameter ("[STRING sName = \"\"]" gives "sName"). */
export function paramName(p: string): string {
  let s = p.replace(/[[\]]/g, " ");
  const eq = s.indexOf("=");
  if (eq !== -1) s = s.slice(0, eq);
  const words = s.trim().split(/\s+/);
  while (
    words.length > 1 &&
    (SIGNATURE_TYPES.has(words[0].toUpperCase()) ||
      /^(VAR|FUNCTION)$/i.test(words[0]))
  )
    words.shift();
  const m = /^[A-Za-z_]\w*/.exec(words[0] || "");
  return m ? m[0] : "";
}

/** Split "NAME(...)" text: the part before the parenthesis and the parameters. */
export function parseCallText(
  text: string,
): { head: string; params: string[] } | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open === -1 || close < open) return null;
  let inner = text.slice(open + 1, close).trim();
  // A few topics wrap the whole list in a second pair: "F((a, b [, c]))".
  if (inner.startsWith("(") && splitTopLevelCommas(inner).length === 1)
    inner = inner.replace(/^\(|\)$/g, "");
  return {
    head: text.slice(0, open).trim(),
    params: splitSignatureParams(inner),
  };
}
