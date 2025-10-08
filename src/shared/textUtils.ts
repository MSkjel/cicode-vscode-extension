import * as vscode from "vscode";

export const TYPE_RE =
  /^(INT|REAL|STRING|OBJECT|BOOL|BOOLEAN|LONG|ULONG|UNKNOWN|VOID)$/i;

export function mergeSpans(
  spans: Array<[number, number]>,
): Array<[number, number]> {
  if (!spans.length) return [];
  spans.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of spans) {
    if (!out.length || s > out[out.length - 1][1]) out.push([s, e]);
    else out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
  }
  return out;
}

export function inSpan(pos: number, spans: Array<[number, number]>): boolean {
  for (const [s, e] of spans) {
    if (pos >= s && pos < e) return true;
    if (pos < s) break;
  }
  return false;
}

function scanCommentAndStringSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const N = text.length;

  let i = 0;
  let lineStart = 0;

  const isWsOrPunct = (c: string) =>
    c === " " ||
    c === "\t" ||
    c === "\r" ||
    c === "\n" ||
    c === "," ||
    c === ";" ||
    c === ":" ||
    c === "(" ||
    c === ")" ||
    c === "[" ||
    c === "]" ||
    c === "{" ||
    c === "}" ||
    c === ".";

  const push = (s: number, e: number) => {
    if (e > s) spans.push([s, Math.min(e, N)]);
  };

  while (i < N) {
    const ch = text[i];

    if (ch === "\n") {
      lineStart = i + 1;
      i++;
      continue;
    }
    if (ch === "\r") {
      if (i + 1 < N && text[i + 1] === "\n") i++;
      lineStart = i + 1;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i++;
      while (i < N) {
        const c = text[i];
        if (c === "^") {
          i += Math.min(2, N - i);
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }

        if (c === "\n" || c === "\r") break;
        i++;
      }
      push(start, i);
      continue;
    }

    if (ch === "/" && i + 1 < N && text[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < N) {
        if (text[i] === "\n") lineStart = i + 1;
        if (text[i] === "*" && i + 1 < N && text[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      push(start, i);
      continue;
    }

    if (ch === "/" && i + 1 < N && text[i + 1] === "/") {
      const start = i;
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? N : nl;
      push(start, i);
      continue;
    }

    if (ch === "!") {
      let isFirstNonWs = true;
      for (let k = lineStart; k < i; k++) {
        const c = text[k];
        if (c !== " " && c !== "\t" && c !== "\r") {
          isFirstNonWs = false;
          break;
        }
      }
      const prev = i > 0 ? text[i - 1] : "\n";
      if (isFirstNonWs || isWsOrPunct(prev)) {
        const start = i;
        const nl = text.indexOf("\n", i);
        i = nl === -1 ? N : nl;
        push(start, i);
        continue;
      }
    }

    i++;
  }

  return mergeSpans(spans);
}

export function buildIgnoreSpans(
  text: string,
  opts: { includeFunctionHeaders?: boolean } = {},
): Array<[number, number]> {
  const { includeFunctionHeaders = true } = opts;

  const spans = scanCommentAndStringSpans(text);

  if (includeFunctionHeaders) {
    const re =
      /(^|\n)\s*(?:[A-Za-z_]\w*\s+)*function\b\s*([A-Za-z_]\w*)?\s*\([\s\S]*?\)/gim;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index + (m[1] ? m[1].length : 0);
      const end = m.index + m[0].length;
      if (!inSpan(start, spans)) spans.push([start, end]);
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }

  return mergeSpans(spans);
}

export function stripLineComments(s: string): string {
  const spans = scanCommentAndStringSpans(s);

  const pieces: string[] = [];
  let pos = 0;
  for (const [a, b] of spans) {
    const isDoubleSlash = s[a] === "/" && a + 1 < s.length && s[a + 1] === "/";
    const isTripleSlash = isDoubleSlash && a + 2 < s.length && s[a + 2] === "/";

    const isLine = s[a] === "!" || (isDoubleSlash && !isTripleSlash);
    if (isLine) {
      pieces.push(s.slice(pos, a));
      pos = b;
    }
  }
  pieces.push(s.slice(pos));
  return pieces.join("");
}

export function stripBlockComments(s: string): string {
  const spans = scanCommentAndStringSpans(s);
  const pieces: string[] = [];
  let pos = 0;
  for (const [a, b] of spans) {
    const isBlock = s[a] === "/" && a + 1 < s.length && s[a + 1] === "*";
    if (isBlock) {
      pieces.push(s.slice(pos, a));
      pos = b;
    }
  }
  pieces.push(s.slice(pos));
  return pieces.join("");
}

export function stripStrings(s: string): string {
  const spans = scanCommentAndStringSpans(s);
  const pieces: string[] = [];
  let pos = 0;
  for (const [a, b] of spans) {
    const ch = s[a];
    if (ch === '"' || ch === "'") {
      pieces.push(s.slice(pos, a));
      pos = b;
    }
  }
  pieces.push(s.slice(pos));
  return pieces.join("");
}

export function stripFunctionHeaders(s: string): string {
  const ignore = scanCommentAndStringSpans(s);
  const re =
    /(^|\n)\s*(?:[A-Za-z_]\w*\s+)*function\b\s*([A-Za-z_]\w*)?\s*\([\s\S]*?\)/gim;
  let out = "";
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + (m[1] ? m[1].length : 0);
    const end = m.index + m[0].length;
    if (!inSpan(start, ignore)) {
      out += s.slice(pos, start);
      pos = end;
    }
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  out += s.slice(pos);
  return out;
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

export function leftWordRangeAt(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): vscode.Range | undefined {
  const line = doc.lineAt(pos.line).text;
  let s = pos.character;
  const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);
  const isWordStart = (ch: string) => /[A-Za-z_]/.test(ch);
  if (pos.character > 0 && isWord(line[pos.character - 1])) {
    while (s > 0 && isWord(line[s - 1])) s--;
    if (!isWordStart(line[s])) return undefined;
    return new vscode.Range(pos.line, s, pos.line, pos.character);
  }
  return undefined;
}

export function wordRangeAt(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): vscode.Range | undefined {
  const line = doc.lineAt(pos.line).text;
  let s = pos.character,
    e = pos.character;
  const isWord = (ch: string) => /[A-Za-z_]/.test(ch);
  while (s > 0 && isWord(line[s - 1])) s--;
  while (e < line.length && /[A-Za-z0-9_]/.test(line[e])) e++;
  if (s === e) return undefined;
  return new vscode.Range(pos.line, s, pos.line, e);
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

  let common = Infinity;
  for (const L of lines) {
    if (!L.trim()) continue;
    const m = L.match(/^[ \t]*/);
    common = Math.min(common, m ? m[0].replace(/\t/g, "    ").length : 0);
  }
  if (!isFinite(common)) common = 0;

  const stripped = lines.map((L) => {
    if (!L.trim()) return "";
    let i = 0,
      width = 0;
    while (i < L.length && (L[i] === " " || L[i] === "\t") && width < common) {
      width += L[i] === "\t" ? 4 : 1;
      i++;
    }
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
  // normalize once
  const norm = text.replace(/\r\n?/g, "\n");
  // adjust headerStart to the normalized string
  const normHeaderStart = text
    .slice(0, headerStart)
    .replace(/\r\n?/g, "\n").length;

  const lines = norm.split("\n");

  let idx = 0,
    off = 0;
  while (idx < lines.length && off + lines[idx].length + 1 <= normHeaderStart) {
    off += lines[idx].length + 1;
    idx++;
  }
  const headerLine = Math.max(0, Math.min(lines.length - 1, idx));

  const isBlank = (s: string) => /^\s*$/.test(s);
  const isTriple = (s: string) => /^\s*\/\/\//.test(s);

  const out: string[] = [];
  let i = headerLine - 1;

  while (i >= 0 && isBlank(lines[i])) i--;
  if (i < 0 || !isTriple(lines[i])) return [];

  const collected: number[] = [];
  while (i >= 0 && (isTriple(lines[i]) || isBlank(lines[i]))) {
    collected.push(i);
    i--;
  }
  collected.reverse();

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

  let summary = "";
  {
    const m = /<summary>([\s\S]*?)<\/summary>/i.exec(raw);
    const body = m ? m[1] : raw;
    summary = normalizeDocText(body.replace(/<[^>]+>/g, ""));
  }

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

  let returns: string | undefined;
  {
    const m = /<returns>([\s\S]*?)<\/returns>/i.exec(raw);
    if (m) returns = normalizeDocText(m[1].replace(/<[^>]+>/g, ""));
  }

  return { summary, paramDocs, returns };
}
