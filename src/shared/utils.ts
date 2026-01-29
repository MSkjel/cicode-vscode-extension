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
  max: number;
  normalized: string[];
}

/** Compute min/max argument counts from parameter list, handling optional params */
export function computeParamBounds(params: string[]): ParamBounds {
  let min = 0;
  let max = 0;
  let inOptional = false;
  const normalized: string[] = [];

  for (const raw of params || []) {
    if (!raw) continue;

    const hasOpen = raw.includes("[");
    const hasClose = raw.includes("]");
    const fullyBracketed = hasOpen && hasClose;
    const core = raw.replace(/[\[\]]/g, "").trim();

    if (!core.length && (hasOpen || hasClose)) {
      if (hasOpen && !hasClose) inOptional = true;
      if (hasClose && !hasOpen) inOptional = false;
      continue;
    }

    normalized.push(core);
    max++;

    const hasDefault = /=/.test(raw);
    const isOptional = inOptional || hasDefault || fullyBracketed;
    if (!isOptional) min++;

    if (hasOpen && !hasClose) inOptional = true;
    if (hasClose && !hasOpen) inOptional = false;
  }

  return { min, max, normalized };
}

/** Get array of boolean flags indicating which params are optional */
export function getOptionalParamFlags(params: string[]): boolean[] {
  let inOptional = false;
  return params.map((p) => {
    const hasOpen = p.includes("[");
    const hasClose = p.includes("]");
    const hasDefault = /=/.test(p);
    const isOptional = inOptional || hasDefault || (hasOpen && hasClose);
    if (hasOpen && !hasClose) inOptional = true;
    if (hasClose && !hasOpen) inOptional = false;
    return isOptional;
  });
}

// ============================================================================
// Logging
// ============================================================================

export const log = (...a: unknown[]) => console.log("[cicode]", ...a);
export const warn = (...a: unknown[]) => console.warn("[cicode]", ...a);
export const error = (...a: unknown[]) => console.error("[cicode]", ...a);
