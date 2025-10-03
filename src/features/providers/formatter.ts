import * as vscode from "vscode";

export function makeFormatter(
  cfg: () => vscode.WorkspaceConfiguration,
): vscode.DocumentFormattingEditProvider {
  const OPENERS: RegExp[] = [
    /^\s*(?:\w+\s+)*function\b/i,
    /^\s*if\b/i,
    /^\s*for\b/i,
    /^\s*while\b/i,
    /^\s*try\b/i,
    /^\s*repeat\b/i,
    /^\s*select\s+case\b/i,
  ];
  const MIDDLES: RegExp[] = [
    /^\s*else\b/i,
    /^\s*elseif\b/i,
    /^\s*case\b/i,
    /^\s*except\b/i,
    /^\s*finally\b/i,
  ];
  const CLOSERS: RegExp[] = [
    /^\s*end\s+select\b/i,
    /^\s*end(\s+\w+)?\b/i,
    /^\s*until\b/i,
  ];
  const isAny = (line: string, patterns: RegExp[]) =>
    patterns.some((re) => re.test(line));

  function parenDelta(line: string) {
    const parts = line.split(/(".*?(?<!\\)"|'.*?(?<!\\)')/);
    let opens = 0,
      closes = 0;
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) continue;
      const seg = parts[i];
      opens += (seg.match(/\(/g) || []).length;
      closes += (seg.match(/\)/g) || []).length;
    }
    return opens - closes;
  }

  function normalizeOutsideParens(line: string) {
    if (!/[=,]/.test(line)) return line;
    return line
      .split(/(".*?(?<!\\)"|'.*?(?<!\\)')/)
      .map((seg, idx) => {
        if (idx % 2 === 1) return seg;
        const chunks: { type: "code" | "paren"; text: string }[] = [];
        let buf = "";
        let depth = 0;
        for (let i = 0; i < seg.length; i++) {
          const c = seg[i];
          if (c === "(") {
            if (depth === 0 && buf) {
              chunks.push({ type: "code", text: buf });
              buf = "";
            }
            depth++;
            buf += c;
          } else if (c === ")") {
            buf += c;
            depth = Math.max(0, depth - 1);
            if (depth === 0) {
              chunks.push({ type: "paren", text: buf });
              buf = "";
            }
          } else {
            buf += c;
          }
        }
        if (buf) chunks.push({ type: depth > 0 ? "paren" : "code", text: buf });
        return chunks
          .map((ch) =>
            ch.type === "paren"
              ? ch.text
              : ch.text.replace(/\s*=\s*/g, " = ").replace(/\s*,\s*/g, ", "),
          )
          .join("");
      })
      .join("");
  }

  return {
    provideDocumentFormattingEdits(doc) {
      if (!cfg().get("cicode.format.enable", true)) return [];
      const maxBlank = Math.max(
        0,
        cfg().get("cicode.format.maxConsecutiveBlankLines", 1),
      );
      const convertTabs = !!cfg().get("cicode.format.convertTabs", false);

      const start = new vscode.Position(0, 0);
      const end = doc.lineAt(Math.max(0, doc.lineCount - 1)).range.end;

      const out: string[] = [];
      let depth = 0;
      let parenBalance = 0;
      let blankCount = 0;

      for (let i = 0; i < doc.lineCount; i++) {
        let raw = doc.lineAt(i).text;
        let line = raw.replace(/\s+$/, "");
        const trimmed = line.trim();
        const delta = parenDelta(line);

        if (trimmed.length === 0 && parenBalance === 0) {
          blankCount++;
          if (blankCount <= maxBlank) out.push("");
          continue;
        } else blankCount = 0;

        if (/^\s*(\/\/|!)/.test(trimmed)) {
          if (parenBalance > 0) out.push(line);
          else {
            let base = "    ".repeat(depth);
            if (convertTabs) base = base.replace(/\t/g, "    ");
            out.push(base + trimmed);
          }
          parenBalance += delta;
          continue;
        }

        if (parenBalance > 0) {
          out.push(line);
          parenBalance += delta;
          continue;
        }

        if (isAny(trimmed, CLOSERS)) depth = Math.max(0, depth - 1);
        const isMiddle = isAny(trimmed, MIDDLES);
        const baseDepth = isMiddle ? Math.max(0, depth - 1) : depth;
        let normalized = normalizeOutsideParens(line).trim();
        let indent = "    ".repeat(baseDepth);
        if (convertTabs) indent = indent.replace(/\t/g, "    ");
        const rebuilt = normalized.length ? indent + normalized : "";
        out.push(rebuilt);
        if (isAny(trimmed, OPENERS)) depth++;
        if (delta > 0) parenBalance += delta;
      }

      if (out.length === 0 || out[out.length - 1] !== "") out.push("");
      return [
        vscode.TextEdit.replace(new vscode.Range(start, end), out.join("\n")),
      ];
    },
  };
}
