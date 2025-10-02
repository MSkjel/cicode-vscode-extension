/** Regex for known Cicode base types (for declaration recognition). */
export const TYPE_RE =
  /^(INT|REAL|STRING|OBJECT|BOOL|BOOLEAN|LONG|ULONG|UNKNOWN|VOID)$/i;

export function stripLineComments(s: string): string {
  return s.replace(/\/\/.*$/gm, "");
}
export function stripBlockComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "");
}
export function stripStrings(s: string): string {
  return s.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
}

export function stripFunctionHeaders(s: string): string {
  return s.replace(/(^|\n)\s*(?:[\w]+\s+)*function\s+\w+\s*\([^)]*\)/gim, "");
}

export function mergeSpans(
  spans: Array<[number, number]>,
): Array<[number, number]> {
  if (!spans.length) return [];
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of spans) {
    if (!merged.length || s > merged[merged.length - 1][1]) merged.push([s, e]);
    else
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
  }
  return merged;
}

export function buildIgnoreSpans(
  text: string,
  opts: { includeFunctionHeaders?: boolean } = {},
): Array<[number, number]> {
  const { includeFunctionHeaders = true } = opts;
  const spans: Array<[number, number]> = [];

  const pushAll = (re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      spans.push([m.index, m.index + m[0].length]);
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  };

  pushAll(/\/\/.*$/gm);
  pushAll(/\/\*[\s\S]*?\*\//g);
  pushAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g);

  if (includeFunctionHeaders) {
    const re = /(^|\n)\s*(?:[\w]+\s+)*function\s+\w+\s*\([^)]*\)/gim;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index + (m[1] ? m[1].length : 0);
      spans.push([start, m.index + m[0].length]);
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  return mergeSpans(spans);
}

export function inSpan(pos: number, spans: Array<[number, number]>): boolean {
  for (const [s, e] of spans) {
    if (pos >= s && pos < e) return true;
    if (pos < s) break;
  }
  return false;
}

export function cleanParamName(param?: string | null): string {
  let p = String(param ?? "").trim();
  p = p.replace(/[\[\]]/g, " ").trim();
  p = p.replace(/\s*=\s*[^,)]+$/, "").trim();
  p = p.replace(/^(GLOBAL|LOCAL|CONST|PUBLIC|PRIVATE)\s+/i, "");
  p = p.replace(
    /^(INT|REAL|STRING|OBJECT|BOOL|BOOLEAN|LONG|ULONG|UNKNOWN|VOID)\s+/i,
    "",
  );
  p = p.replace(
    /:\s*(INT|REAL|STRING|OBJECT|BOOL|BOOLEAN|LONG|ULONG|UNKNOWN|VOID)\b/i,
    "",
  );
  p = p.replace(/:$/, "");
  p = p.replace(/\s+/g, " ").trim();
  const m = p.match(/^[A-Za-z_]\w*/);
  return m ? m[0] : p || "?";
}

export function argLooksNamed(argText: string): boolean {
  return /^\s*[A-Za-z_]\w*\s*:\s*/.test(argText);
}
export function splitDeclNames(namesPart: string): string[] {
  return namesPart
    .split(",")
    .map((s) => s.trim())
    .map((s) => s.replace(/\s*=\s*.+$/, ""))
    .filter(Boolean);
}
