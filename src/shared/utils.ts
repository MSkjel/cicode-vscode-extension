import * as vscode from "vscode";
import type { ScopeType } from "./types";

// ============================================================================
// Timing Utilities
// ============================================================================

export type Debounced<T extends (...args: any[]) => void> = T & {
  /** Drop the pending call, if any. */
  cancel(): void;
};

export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  ms: number,
): Debounced<T> {
  let t: NodeJS.Timeout | undefined;
  const debounced = ((...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = undefined;
      fn(...args);
    }, ms);
  }) as Debounced<T>;
  debounced.cancel = () => {
    if (t) clearTimeout(t);
    t = undefined;
  };
  return debounced;
}

export type PerKeyDebounced<T extends (...args: any[]) => void> = T & {
  /** Drop the pending call for one key, if any. */
  cancel(key: string): void;
  cancelAll(): void;
};

/** Debounce with an independent timer per key, so calls for different keys
 *  don't cancel each other's pending work. */
export function debouncePerKey<T extends (...args: any[]) => void>(
  fn: T,
  ms: number,
  keyOf: (...args: Parameters<T>) => string,
): PerKeyDebounced<T> {
  const timers = new Map<string, NodeJS.Timeout>();
  const debounced = ((...args: Parameters<T>) => {
    const key = keyOf(...args);
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        fn(...args);
      }, ms),
    );
  }) as PerKeyDebounced<T>;
  debounced.cancel = (key: string) => {
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.delete(key);
  };
  debounced.cancelAll = () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
  return debounced;
}

// ============================================================================
// Encoding Utilities
// ============================================================================

// windows-1252 bytes 0x80-0x9F; every other byte maps to the same Latin-1
// code point. Undefined bytes decode to U+FFFD, matching the iconv-lite
// decoder VS Code uses for TextDocuments.
const CP1252_80_9F =
  "\u20ac\ufffd\u201a\u0192\u201e\u2026\u2020\u2021" +
  "\u02c6\u2030\u0160\u2039\u0152\ufffd\u017d\ufffd" +
  "\ufffd\u2018\u2019\u201c\u201d\u2022\u2013\u2014" +
  "\u02dc\u2122\u0161\u203a\u0153\ufffd\u017e\u0178";

/** Decodes windows-1252 bytes (the ANSI code page of Cicode sources and DBF tables). */
export function decodeWindows1252(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString("latin1")
    .replace(/[\x80-\x9f]/g, (c) => CP1252_80_9F[c.charCodeAt(0) - 0x80]);
}

/**
 * Line breaks as VS Code's text buffer stores them: CRLF when more than half
 * of the breaks contain a CR, otherwise LF, and every `\r\n`, `\r` and `\n`
 * rewritten to that one sequence. Text with a single kind is unchanged.
 */
function normalizeEolLikeTextBuffer(text: string): string {
  let cr = 0;
  let lf = 0;
  let crlf = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  const total = cr + lf + crlf;
  if (total === 0) return text;
  const eol = cr + crlf > total / 2 ? "\r\n" : "\n";
  const mixed = eol === "\r\n" ? cr > 0 || lf > 0 : cr > 0 || crlf > 0;
  return mixed ? text.replace(/\r\n|\r|\n/g, eol) : text;
}

/**
 * Decode file bytes the way VS Code decodes the same file into a
 * TextDocument, so text read from disk hashes and offsets identically to an
 * open editor: a BOM wins, otherwise the effective `files.encoding` for
 * Cicode (windows1252 by default, see package.json) is used, and mixed line
 * endings are normalised like the editor's text buffer. Common encodings are
 * decoded locally (synchronous, no renderer round trip); others go through
 * `workspace.decode` (VS Code 1.101+) or fall back to UTF-8.
 */
export async function decodeFileBytes(
  uri: vscode.Uri,
  bytes: Uint8Array,
): Promise<string> {
  return normalizeEolLikeTextBuffer(await decodeBytes(uri, bytes));
}

async function decodeBytes(
  uri: vscode.Uri,
  bytes: Uint8Array,
): Promise<string> {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes);
  }

  const encoding = vscode.workspace
    .getConfiguration("files", { uri, languageId: "cicode" })
    .get<string>("encoding", "utf8");
  switch (encoding) {
    case "windows1252":
      return decodeWindows1252(bytes);
    case "iso88591":
      return Buffer.from(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ).toString("latin1");
    case "utf8":
    case "utf8bom":
      return new TextDecoder("utf-8").decode(bytes);
    case "utf16le":
      return new TextDecoder("utf-16le").decode(bytes);
    case "utf16be":
      return new TextDecoder("utf-16be").decode(bytes);
  }

  const ws = vscode.workspace as unknown as {
    decode?(
      content: Uint8Array,
      options?: { uri: vscode.Uri },
    ): Thenable<string>;
  };
  if (typeof ws.decode === "function") {
    try {
      return await ws.decode(bytes, { uri });
    } catch {
      /* unknown encoding label etc.: fall back to UTF-8 */
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

// ============================================================================
// String Utilities
// ============================================================================

/** Escape special regex characters in a string */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================================
// Document Utilities
// ============================================================================

/** Check if a document is a Cicode file */
export function isCicodeDocument(doc: vscode.TextDocument): boolean {
  return (
    doc.languageId === "cicode" || doc.uri.fsPath.toLowerCase().endsWith(".ci")
  );
}

// ============================================================================
// Scope Utilities
// ============================================================================

export interface ScopeFormatOptions {
  includeType?: boolean;
  type?: string;
  scopeId?: string;
}

/** Format scope type for display */
export function formatScopeType(
  scopeType: ScopeType,
  options: ScopeFormatOptions = {},
): string {
  const { includeType = false, type = "", scopeId = "" } = options;
  const typeStr = includeType && type ? ` ${type}` : "";

  switch (scopeType) {
    case "global":
      return `Global${typeStr}`;
    case "module":
      return `Module${typeStr}`;
    case "local":
      const localName = scopeId ? scopeId.split("::").pop() : "";
      return localName ? `Local${typeStr} (${localName})` : `Local${typeStr}`;
    default:
      return `Unknown${typeStr}`;
  }
}

// ============================================================================
// Parameter Utilities
// ============================================================================

export interface ParamBounds {
  min: number;
  /** Infinity for a variadic list. */
  max: number;
  normalized: string[];
}

interface ParamShape {
  /** Parameter text without its optional-group brackets; "" for a bare bracket. */
  core: string;
  optional: boolean;
  variadic: boolean;
}

/**
 * Classify parameter strings. A parameter is optional when it has a default
 * (`INT a = 1`) or its text starts inside a `[...]` group. Groups may open on
 * the previous parameter (`sText [`, `iLength] [`) and nest (`[a [, b]]`).
 * `...` or a range such as `Tag1......Tag8` stands for any number of args.
 */
function paramShapes(params: string[]): ParamShape[] {
  let depth = 0;
  return (params || []).map((raw) => {
    let core = "";
    let coreDepth = -1;
    let inStr = false;
    for (let i = 0; i < (raw || "").length; i++) {
      const ch = raw[i];
      if (inStr) {
        core += ch;
        if (ch === "^" && i + 1 < raw.length) core += raw[++i];
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === "[") depth++;
      else if (ch === "]") depth = Math.max(0, depth - 1);
      else {
        if (coreDepth < 0 && !/\s/.test(ch)) coreDepth = depth;
        if (ch === '"') inStr = true;
        core += ch;
      }
    }
    core = core.replace(/\s+/g, " ").trim();
    const eq = core.indexOf("=");
    const decl = eq === -1 ? core : core.slice(0, eq);
    const variadic = /\.\./.test(decl);
    return {
      core,
      optional: !core || coreDepth > 0 || eq !== -1 || variadic,
      variadic,
    };
  });
}

/**
 * Argument count bounds for a parameter list. Every argument up to the last
 * required one must be passed, even when an earlier one has a default: the
 * compiler binds arguments by position (W1004 / E2022 / E2057 otherwise).
 */
export function computeParamBounds(params: string[]): ParamBounds {
  let min = 0;
  let count = 0;
  let variadic = false;
  const normalized: string[] = [];
  for (const s of paramShapes(params)) {
    if (!s.core) continue;
    normalized.push(s.core);
    if (s.variadic) {
      variadic = true;
      continue;
    }
    count++;
    if (!s.optional) min = count;
  }
  return { min, max: variadic ? Infinity : count, normalized };
}

/** Per-parameter flag: has a default, is bracketed as optional, or is variadic. */
export function getOptionalParamFlags(params: string[]): boolean[] {
  return paramShapes(params).map((s) => s.optional);
}

// ============================================================================
// Logging
// ============================================================================

export const log = (...a: unknown[]) => console.log("[cicode]", ...a);
export const warn = (...a: unknown[]) => console.warn("[cicode]", ...a);
export const error = (...a: unknown[]) => console.error("[cicode]", ...a);
