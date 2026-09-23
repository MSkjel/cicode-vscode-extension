import * as vscode from "vscode";
import type { ScopeType } from "./types";

// ============================================================================
// Timing Utilities
// ============================================================================

export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  ms: number,
): T {
  let t: NodeJS.Timeout | undefined;
  return ((...args: any[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
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
