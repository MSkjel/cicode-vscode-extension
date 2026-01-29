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

  function stripLineCommentOnce(s: string) {
    // Handle // comments
    const slashIdx = s.indexOf("//");
    // Handle ! comments - only valid at line start or after whitespace/punctuation
    // Must check it's not part of != operator
    let bangIdx = -1;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "!") {
        // Check if this is != operator
        if (i + 1 < s.length && s[i + 1] === "=") continue;
        // Check if preceded by whitespace, punctuation, or start of string
        if (i === 0 || /[\s,;:()[\]{}]/.test(s[i - 1])) {
          bangIdx = i;
          break;
        }
      }
    }
    const idx =
      slashIdx >= 0 && bangIdx >= 0
        ? Math.min(slashIdx, bangIdx)
        : slashIdx >= 0
          ? slashIdx
          : bangIdx;
    return idx >= 0 ? s.slice(0, idx) : s;
  }

  function parenDelta(line: string) {
    const safe = stripLineCommentOnce(line);
    // Cicode uses ^ as escape character, not backslash
    const parts = safe.split(/(".*?(?<!\^)"|'.*?(?<!\^)')/);
    let opens = 0,
      closes = 0;
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) continue; // skip quoted strings
      const seg = parts[i];
      opens += (seg.match(/\(/g) || []).length;
      closes += (seg.match(/\)/g) || []).length;
    }
    return opens - closes;
  }

  // Only space standalone assignment '=' (not <=, >=, etc.)
  const ASSIGN_EQ = /(?<![<>=!:+\-*/%&|^])\s*=\s*(?![=])/g;

  function findCommentStart(s: string): number {
    const slashIdx = s.indexOf("//");
    let bangIdx = -1;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "!") {
        if (i + 1 < s.length && s[i + 1] === "=") continue;
        if (i === 0 || /[\s,;:()[\]{}]/.test(s[i - 1])) {
          bangIdx = i;
          break;
        }
      }
    }
    if (slashIdx >= 0 && bangIdx >= 0) return Math.min(slashIdx, bangIdx);
    if (slashIdx >= 0) return slashIdx;
    return bangIdx;
  }

  function normalizeOutsideParens(line: string) {
    if (!/[=,]/.test(line)) return line;

    // Separate first line comment so we don't reformat comments
    const commentIdx = findCommentStart(line);
    const code = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
    const commentTail = commentIdx >= 0 ? line.slice(commentIdx) : "";

    // Cicode uses ^ as escape character, not backslash
    const normalizedCode = code
      .split(/(".*?(?<!\^)"|'.*?(?<!\^)')/)
      .map((seg, idx) => {
        if (idx % 2 === 1) return seg; // keep strings intact

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
              : ch.text
                  .replace(ASSIGN_EQ, " = ")
                  // tidy commas (code portions only)
                  .replace(/\s*,\s*/g, ", "),
          )
          .join("");
      })
      .join("");

    return normalizedCode + commentTail;
  }

  return {
    provideDocumentFormattingEdits(doc) {
      if (!cfg().get("cicode.format.enable", true)) return [];
      const maxBlank = Math.max(
        0,
        cfg().get("cicode.format.maxConsecutiveBlankLines", 1),
      );

      const start = new vscode.Position(0, 0);
      const end = doc.lineAt(Math.max(0, doc.lineCount - 1)).range.end;

      const out: string[] = [];
      let depth = 0;
      let parenBalance = 0;
      let blankCount = 0;
      // Track SELECT CASE blocks: each entry = whether a CASE is currently open
      const selectStack: boolean[] = [];

      for (let i = 0; i < doc.lineCount; i++) {
        let raw = doc.lineAt(i).text;
        let line = raw.replace(/\s+$/, "");
        const trimmed = line.trim();
        const delta = parenDelta(line);

        // collapse blank lines
        if (trimmed.length === 0 && parenBalance === 0) {
          blankCount++;
          if (blankCount <= maxBlank) out.push("");
          continue;
        } else blankCount = 0;

        // Comment-only line? (trimmed already has leading whitespace removed)
        if (/^(\/\/|!)/.test(trimmed)) {
          if (parenBalance > 0) out.push(line);
          else {
            const base = "\t".repeat(depth);
            const commentBody = raw.replace(/^\s*/, "");
            out.push(base + commentBody.trimEnd());
          }
          parenBalance += delta;
          continue;
        }

        // Inside multi-line paren block? preserve as-is
        if (parenBalance > 0) {
          out.push(line);
          parenBalance += delta; // always update
          continue;
        }

        // Detect SELECT CASE related patterns
        const isSelectCase = /^\s*select\s+case\b/i.test(trimmed);
        const isCaseLine = /^\s*case\b/i.test(trimmed) && !isSelectCase;
        const isEndSelect = /^\s*end\s+select\b/i.test(trimmed);

        // Handle CASE: close previous CASE block if one is open
        if (
          isCaseLine &&
          selectStack.length > 0 &&
          selectStack[selectStack.length - 1]
        ) {
          depth = Math.max(0, depth - 1);
          selectStack[selectStack.length - 1] = false;
        }

        // Handle END SELECT: close any open CASE first
        if (
          isEndSelect &&
          selectStack.length > 0 &&
          selectStack[selectStack.length - 1]
        ) {
          depth = Math.max(0, depth - 1);
        }

        const isCloser = isAny(trimmed, CLOSERS);
        const isMiddle = isAny(trimmed, MIDDLES);
        const isOpener = isAny(trimmed, OPENERS) || isCaseLine;

        if (isCloser) depth = Math.max(0, depth - 1);

        const baseDepth = isMiddle ? Math.max(0, depth - 1) : depth;

        let normalized = normalizeOutsideParens(line).trim();
        const indent = "\t".repeat(baseDepth);
        const rebuilt = normalized.length ? indent + normalized : "";
        out.push(rebuilt);

        if (isOpener && !isCloser) depth++;

        // Track SELECT CASE state
        if (isSelectCase) {
          selectStack.push(false);
        }
        if (isCaseLine && selectStack.length > 0) {
          selectStack[selectStack.length - 1] = true;
        }
        if (isEndSelect && selectStack.length > 0) {
          selectStack.pop();
        }

        parenBalance += delta;
      }

      if (out.length === 0 || out[out.length - 1] !== "") out.push("");
      return [
        vscode.TextEdit.replace(new vscode.Range(start, end), out.join("\n")),
      ];
    },
  };
}
