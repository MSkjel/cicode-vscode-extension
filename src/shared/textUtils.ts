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

function normalizeDocText(s: string): string {
  const lines = String(s).replace(/\r\n?/g, "\n").split("\n");

  // Compute common indent across non-empty lines
  let common = Infinity;
  for (const L of lines) {
    if (!L.trim()) continue;
    const m = L.match(/^[ \t]*/)!;
    common = Math.min(common, m ? m[0].replace(/\t/g, "    ").length : 0);
  }
  if (!isFinite(common)) common = 0;

  // Strip indent and collapse spaces per line
  const stripped = lines.map((L) => {
    if (!L.trim()) return ""; // keep blank lines as paragraph separators
    // Remove up to `common` worth of spaces/tabs from the left
    let i = 0,
      width = 0;
    while (i < L.length && (L[i] === " " || L[i] === "\t") && width < common) {
      width += L[i] === "\t" ? 4 : 1;
      i++;
    }
    // Collapse runs of spaces to single
    return L.slice(i)
      .replace(/[ \t]{2,}/g, " ")
      .trimEnd();
  });

  const out: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) {
      out.push(buf.join(" ").trim());
      buf = [];
    }
  };
  for (const L of stripped) {
    if (L === "") flush();
    else buf.push(L.trim());
  }
  flush();

  return out.join("\n\n").trim();
}

export function extractLeadingTripleSlashDoc(
  text: string,
  headerStart: number,
): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  // Find the header line index from the absolute offset
  let idx = 0,
    off = 0;
  while (idx < lines.length && off + lines[idx].length + 1 <= headerStart) {
    off += lines[idx].length + 1; // + '\n'
    idx++;
  }
  const headerLine = Math.max(0, Math.min(lines.length - 1, idx));

  const isBlank = (s: string) => /^\s*$/.test(s);
  const isTriple = (s: string) => /^\s*\/\/\//.test(s); // <-- no \b !

  // Walk upward over blanks, then collect a contiguous doc block of /// lines
  const out: string[] = [];
  let i = headerLine - 1;

  // skip trailing blanks just before the header
  while (i >= 0 && isBlank(lines[i])) i--;

  // require at least one triple-slash to start
  if (i < 0 || !isTriple(lines[i])) return [];

  // collect upward until a non-blank, non-/// line
  const collected: number[] = [];
  while (i >= 0 && (isTriple(lines[i]) || isBlank(lines[i]))) {
    collected.push(i);
    i--;
  }
  collected.reverse();

  // keep only the triple-slash lines, but preserve single blank lines as paragraph breaks
  let pendingBlank = false;
  for (const k of collected) {
    const L = lines[k];
    if (isTriple(L)) {
      if (pendingBlank && out.length && out[out.length - 1] !== "")
        out.push("");
      pendingBlank = false;
      out.push(L.replace(/^\s*\/\/\/\s?/, ""));
    } else if (isBlank(L)) {
      pendingBlank = true;
    }
  }

  while (out.length && out[0] === "") out.shift();
  while (out.length && out[out.length - 1] === "") out.pop();

  return out;
}

export function parseXmlDocLines(lines: string[]): {
  summary: string;
  paramDocs: Record<string, string>;
  returns?: string;
} {
  const raw = lines.join("\n");

  // <summary>...</summary>
  let summary = "";
  {
    const m = /<summary>([\s\S]*?)<\/summary>/i.exec(raw);
    const body = m ? m[1] : raw;
    summary = normalizeDocText(body.replace(/<[^>]+>/g, ""));
  }

  // <param name="...">...</param>
  const paramDocs: Record<string, string> = {};
  {
    const re = /<param\s+name\s*=\s*"(.*?)"\s*>([\s\S]*?)<\/param>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      const name = (m[1] || "").trim();
      const body = (m[2] || "").replace(/<[^>]+>/g, "");
      if (name) paramDocs[name] = normalizeDocText(body);
    }
  }

  // <returns>...</returns>
  let returns: string | undefined;
  {
    const m = /<returns>([\s\S]*?)<\/returns>/i.exec(raw);
    if (m) returns = normalizeDocText(m[1].replace(/<[^>]+>/g, ""));
  }
  console.log(raw);
  return { summary, paramDocs, returns };
}
