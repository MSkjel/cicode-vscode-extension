import * as fs from "fs";
import { CICODE_TYPES_PATTERN } from "../../shared/constants";
import * as path from "path";
import * as vscode from "vscode";
import * as cheerio from "cheerio";
import { BuiltinFunction } from "./types";
import { error } from "../../shared/utils";

let builtinCache: Map<string, BuiltinFunction> = new Map();
const CACHE_FILE = "builtinFunctions.json";
const CACHE_VERSION = 6;

const CONTENT_FOLDER_NAME = "CicodeReferenceCitectHTML";

// Cached resolved paths
let resolvedContentPath: string | null = null;
let resolvedHelpRoot: string | null = null;

/**
 * Recursively search for the Cicode help content folder
 */
function findContentFolder(baseDir: string, maxDepth = 5): string | null {
  if (maxDepth <= 0 || !fs.existsSync(baseDir)) return null;

  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(baseDir, entry.name);

      // Check if this is the CicodeReferenceCitectHTML folder
      if (entry.name === CONTENT_FOLDER_NAME) {
        const contentPath = path.join(fullPath, "Content");
        if (fs.existsSync(contentPath)) {
          return contentPath;
        }
      }

      // Recurse into subdirectories
      const found = findContentFolder(fullPath, maxDepth - 1);
      if (found) return found;
    }
  } catch {
    // Permission denied or other error, skip this directory
  }
  return null;
}

/**
 * Find the help root folder (containing Default.htm)
 */
function findHelpRoot(baseDir: string, maxDepth = 5): string | null {
  if (maxDepth <= 0 || !fs.existsSync(baseDir)) return null;

  try {
    // Check if Default.htm exists in this folder
    if (fs.existsSync(path.join(baseDir, "Default.htm"))) {
      return baseDir;
    }

    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(baseDir, entry.name);
      const found = findHelpRoot(fullPath, maxDepth - 1);
      if (found) return found;
    }
  } catch {
    // Permission denied or other error, skip this directory
  }
  return null;
}

/**
 * Resolve the content path from user setting
 */
export function resolveContentPath(
  cfg: () => vscode.WorkspaceConfiguration,
): string | null {
  if (resolvedContentPath) return resolvedContentPath;

  const avevaPath =
    (cfg().get("cicode.avevaPath") as string | undefined)?.trim() || "";

  if (!avevaPath) return null;

  // If it already points to a Content folder with .htm files, use it directly
  if (fs.existsSync(avevaPath)) {
    try {
      const files = fs.readdirSync(avevaPath);
      if (files.some((f) => f.endsWith(".htm") || f.endsWith(".html"))) {
        resolvedContentPath = avevaPath;
        return avevaPath;
      }
    } catch {
      // Not a directory or permission error
    }
  }

  // Search within the path
  const found = findContentFolder(avevaPath);
  if (found) {
    resolvedContentPath = found;
    return found;
  }

  return null;
}

/**
 * Resolve the help root path (folder containing Default.htm)
 */
export function resolveHelpRoot(
  cfg: () => vscode.WorkspaceConfiguration,
): string | null {
  if (resolvedHelpRoot) return resolvedHelpRoot;

  const avevaPath =
    (cfg().get("cicode.avevaPath") as string | undefined)?.trim() || "";

  if (!avevaPath) return null;

  const found = findHelpRoot(avevaPath);
  if (found) {
    resolvedHelpRoot = found;
    return found;
  }

  return null;
}

/**
 * Clear cached paths (call when settings change)
 */
export function clearPathCache(): void {
  resolvedContentPath = null;
  resolvedHelpRoot = null;
}

function asMap(
  obj: Record<string, BuiltinFunction> | undefined | null,
): Map<string, BuiltinFunction> {
  const m = new Map<string, BuiltinFunction>();
  for (const k of Object.keys(obj || {}))
    m.set(k, (obj as Record<string, BuiltinFunction>)[k]);
  return m;
}

export async function initBuiltins(
  context: vscode.ExtensionContext,
  cfg: () => vscode.WorkspaceConfiguration,
): Promise<void> {
  const file = path.join(context.globalStorageUri.fsPath, CACHE_FILE);

  const loadFromDisk = (): boolean => {
    try {
      if (!fs.existsSync(file)) return false;
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data?.v !== CACHE_VERSION || !data?.functions) return false;
      builtinCache = asMap(data.functions as Record<string, BuiltinFunction>);
      return builtinCache.size > 0;
    } catch {
      return false;
    }
  };

  const loadFromShipped = (): boolean => {
    try {
      const packaged = context.asAbsolutePath(
        path.join("builtins", "builtinFunctions.json"),
      );
      if (!fs.existsSync(packaged)) return false;
      const obj = JSON.parse(fs.readFileSync(packaged, "utf8"));
      const functions = (obj?.functions ?? obj) as
        | Record<string, BuiltinFunction>
        | undefined;
      if (!functions) return false;
      builtinCache = asMap(functions);
      return builtinCache.size > 0;
    } catch {
      return false;
    }
  };

  if (loadFromDisk()) {
    applySignatureOverrides(cfg);
    return;
  }

  try {
    await rebuildBuiltins(context, cfg);
  } catch (e) {
    error("Cicode: Failed to rebuild builtins from help files:", e);
  }
  if (loadFromDisk()) {
    applySignatureOverrides(cfg);
    return;
  }

  loadFromShipped();
  applySignatureOverrides(cfg);
}

function squish(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim();
}

function extractSummary($: cheerio.CheerioAPI): string {
  const meta = $('meta[name="description"]').attr("content");
  if (meta && squish(meta)) return squish(meta);

  const firstBody = $(".pBody").first().text();
  return squish(firstBody);
}

function extractReturnType($: cheerio.CheerioAPI): string {
  const retText = $("p.SubHeading:contains('Return Value')").next("p").text();
  if (!retText) return "UNKNOWN";
  const first = squish(retText).split(/\s+/)[0] || "";
  return new RegExp(`^(${CICODE_TYPES_PATTERN})$`, "i").test(first)
    ? first.toUpperCase()
    : "UNKNOWN";
}

function extractReturnsDoc($: cheerio.CheerioAPI): string | undefined {
  const node = $("p.SubHeading:contains('Return Value')").next("p");
  const text = squish(node.text());
  return text || undefined;
}

function extractParamDocs($: cheerio.CheerioAPI): Record<string, string> {
  const paramDocs: Record<string, string> = {};
  const add = (rawName: string | undefined, rawDesc: string | undefined) => {
    const name = squish((rawName || "").replace(/[:：]\s*$/, ""));
    const desc = squish(rawDesc || "");
    if (!name || !desc) return;
    if (!paramDocs[name]) paramDocs[name] = desc;
  };

  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  $("p").each((_, el) => {
    const $p = $(el);

    if ($p.hasClass("pArgBody")) {
      const em = $p.find("em.cEmphasis, i").first();
      if (em.length) {
        const paramName = em.text();
        const label = new RegExp(
          "^\\s*" + escapeRe(paramName) + "\\s*[:\\-–—]?\\s*",
          "i",
        );
        add(paramName, squish($p.text().replace(label, "")));
        return;
      }
    }

    if ($p.hasClass("pBody")) {
      const em = $p.find("em.cEmphasis, i").first();
      if (em.length) {
        const paramName = em.text();
        const stripped = squish($p.text().replace(/[\s\S]*?\b:\s*/, ""));
        if (stripped) {
          add(paramName, stripped);
        } else {
          const next = $p.next("p");
          if (next.length) add(paramName, next.text());
        }
      }
    }
  });

  return paramDocs;
}

export async function rebuildBuiltins(
  context: vscode.ExtensionContext,
  cfg: () => vscode.WorkspaceConfiguration,
): Promise<Map<string, BuiltinFunction>> {
  // Clear cache to force re-resolution
  clearPathCache();

  const inputDir = resolveContentPath(cfg);
  const out: Record<string, BuiltinFunction> = {};
  if (!inputDir || !fs.existsSync(inputDir)) return save(context, out);

  for (const file of fs.readdirSync(inputDir)) {
    const ext = path.extname(file).toLowerCase();
    if (ext !== ".htm" && ext !== ".html") continue;

    try {
      const html = fs.readFileSync(path.join(inputDir, file), "utf8");
      const $ = cheerio.load(html);
      const name = $(".pFunctionName").first().text().trim();
      if (!name) continue;

      let syntaxLine = $("p:contains('Syntax')").next("p").text().trim();
      if (!syntaxLine)
        syntaxLine = $("p:contains('Syntax')").next("pre").text().trim();

      let params: string[] = [];
      const m = syntaxLine.match(/\((.*)\)/);
      if (m) {
        params = m[1]
          .split(",")
          .map((p) => squish(p.replace(/\s+/g, " ")))
          .filter(Boolean);
      }

      const summary = extractSummary($);
      const returnsDoc = extractReturnsDoc($);
      const returnType = extractReturnType($);
      const paramDocs = extractParamDocs($);

      out[name.toLowerCase()] = {
        name,
        returnType,
        params,
        doc: summary,
        returns: returnsDoc,
        paramDocs,
        helpPath: file, // Just store filename, construct full path at runtime
      };
    } catch (e) {
      error("builtin parse fail", file, e);
    }
  }

  return save(context, out);
}

function save(
  context: vscode.ExtensionContext,
  obj: Record<string, BuiltinFunction>,
): Map<string, BuiltinFunction> {
  const file = path.join(context.globalStorageUri.fsPath, CACHE_FILE);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ v: CACHE_VERSION, functions: obj }),
    );
  } catch (e) {
    error("Cicode: Failed to save builtin cache:", file, e);
  }
  builtinCache = asMap(obj);
  return builtinCache;
}

export function getBuiltins(): Map<string, BuiltinFunction> {
  return builtinCache;
}

/**
 * Parse a Cicode function signature string like:
 *   STRING BlaBla(STRING sLol, [STRING sOptional])
 * Returns a BuiltinFunction or null if the string can't be parsed.
 * Needed because the docs are full of shit :3
 */
function parseSignature(sig: string): BuiltinFunction | null {
  const m = sig.trim().match(/^(\w+)\s+(\w+)\s*\((.*)\)\s*$/is);
  if (!m) return null;
  const [, returnType, name, rawParams] = m;

  // Normalize "[, param]" → ", [param]" so commas are always at depth-0,
  // then also ensure adjacent optional groups separated by space get a comma.
  const normalized = rawParams
    .replace(/\[,\s*/g, ", [") // [, X] → , [X]
    .replace(/\]\s*\[/g, "], ["); // ] [X] → ], [X]

  const params: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of normalized) {
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    if (ch === "," && depth === 0) {
      const p = cur.trim();
      if (p) params.push(p);
      cur = "";
    } else {
      cur += ch;
    }
  }
  const last = cur.trim();
  if (last) params.push(last);

  return {
    name,
    returnType: returnType.toUpperCase(),
    params: params.filter(Boolean),
    doc: "",
  };
}

/** Apply cicode.signatureOverrides from settings over the current builtinCache. */
export function applySignatureOverrides(
  cfg: () => vscode.WorkspaceConfiguration,
): void {
  const overrides: string[] = cfg().get("cicode.signatureOverrides", []);
  for (const sig of overrides) {
    const entry = parseSignature(sig);
    if (!entry) continue;
    const key = entry.name.toLowerCase();
    const existing = builtinCache.get(key);
    builtinCache.set(
      key,
      existing
        ? { ...existing, returnType: entry.returnType, params: entry.params }
        : entry,
    );
  }
}
