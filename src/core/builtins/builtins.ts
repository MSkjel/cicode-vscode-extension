import * as fs from "fs";
import { CICODE_TYPES_PATTERN } from "../../shared/constants";
import * as path from "path";
import * as vscode from "vscode";
import * as cheerio from "cheerio";
import { BuiltinFunction } from "./types";
import { error } from "../../shared/utils";

let builtinCache: Map<string, BuiltinFunction> = new Map();
const CACHE_FILE = "builtinFunctions.json";
const CACHE_VERSION = 8;

const CONTENT_FOLDER_NAME = "CicodeReferenceCitectHTML";

// AVEVA Product Documentation portal (2023 R2+). The HelpDocumentationViewer
// service serves this content over https://localhost:28808/<Product>/, and the
// per-function topics live as numeric-id files under <Product>\content\en\.
const PORTAL_DOCS_SUBPATH = ["AVEVA", "Product Documentation"];
const PORTAL_PRODUCT = "Plant SCADA";

// Cached resolved paths
let resolvedContentPath: string | null = null;
let resolvedPortalPath: string | null = null;
let resolvedHelpRoot: string | null = null;

/**
 * Does this directory directly contain Cicode help topic files (.htm/.html)?
 */
function dirHasTopics(dir: string): boolean {
  try {
    return fs
      .readdirSync(dir)
      .some((f) => f.endsWith(".htm") || f.endsWith(".html"));
  } catch {
    return false;
  }
}

/**
 * Recursively search for the Cicode help content folder.
 *
 * Handles both layouts:
 *   - 2023+ (MadCap Flare WebHelp): ...\Help\SCADA Help\Content\Cicode\*.html
 *   - 2020  (legacy):              ...\CicodeReferenceCitectHTML\Content\*.htm
 *
 * In 2023 a `CicodeReferenceCitectHTML` folder still exists, but only as an
 * empty Flare subsystem stub, so we require the candidate folder to actually
 * contain topic files before accepting it.
 */
function findContentFolder(baseDir: string, maxDepth = 7): string | null {
  if (maxDepth <= 0 || !fs.existsSync(baseDir)) return null;

  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(baseDir, entry.name);

      // 2023+: a `Cicode` folder containing the function topic files.
      if (entry.name.toLowerCase() === "cicode" && dirHasTopics(fullPath)) {
        return fullPath;
      }

      // 2020: `CicodeReferenceCitectHTML\Content` containing topic files.
      if (entry.name === CONTENT_FOLDER_NAME) {
        const contentPath = path.join(fullPath, "Content");
        if (dirHasTopics(contentPath)) return contentPath;
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

  // Prefer a discovered Cicode topic folder within the path. This runs before
  // the direct-folder check so that pointing avevaPath at a broad content
  // folder (e.g. ...\SCADA Help\Content) still narrows to its `Cicode`
  // subfolder instead of scraping every unrelated topic.
  const found = findContentFolder(avevaPath);
  if (found) {
    resolvedContentPath = found;
    return found;
  }

  // Fallback: avevaPath itself is a folder of topic files (e.g. the user
  // pointed it straight at ...\Content\Cicode or the legacy Content folder).
  if (fs.existsSync(avevaPath) && dirHasTopics(avevaPath)) {
    resolvedContentPath = avevaPath;
    return avevaPath;
  }

  return null;
}

/**
 * Does this directory look like the Author-it portal's Cicode content, i.e. a
 * `content\en` folder with numeric-id topic files, at least one of which is a
 * Cicode function reference (has a Syntax section)?
 */
function portalDirHasCicode(dir: string): boolean {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".html"));
    if (files.length < 50) return false; // not the full doc set
    // Sample a bounded number of files for the function-reference signature.
    let checked = 0;
    for (const f of files) {
      if (checked >= 200) break;
      checked++;
      const html = fs.readFileSync(path.join(dir, f), "utf8");
      if (
        html.includes('class="subheading">Syntax') &&
        /class="strong">\s*[A-Za-z_][\w]*\s*<\/span>\(/.test(html)
      ) {
        return true;
      }
    }
  } catch {
    // Permission or read error
  }
  return false;
}

/**
 * Resolve the Author-it portal content folder (`...\content\en`) for the
 * Cicode reference. Prefers the "Plant SCADA" product under %ProgramData%,
 * then scans the other registered products. Returns null when the portal
 * documentation is not installed.
 */
export function resolvePortalContentPath(
  cfg: () => vscode.WorkspaceConfiguration,
): string | null {
  if (resolvedPortalPath) return resolvedPortalPath;

  // Allow an explicit override: avevaPath may itself point at a portal folder.
  const override =
    (cfg().get("cicode.avevaPath") as string | undefined)?.trim() || "";

  const bases: string[] = [];
  const programData = process.env.ProgramData || "C:\\ProgramData";
  bases.push(path.join(programData, ...PORTAL_DOCS_SUBPATH));
  if (override) bases.push(override);

  for (const base of bases) {
    if (!fs.existsSync(base)) continue;

    // Preferred: the Plant SCADA product folder.
    const preferred = path.join(base, PORTAL_PRODUCT, "content", "en");
    if (fs.existsSync(preferred) && portalDirHasCicode(preferred)) {
      resolvedPortalPath = preferred;
      return preferred;
    }

    // Otherwise scan all product folders for one carrying Cicode topics.
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(base, entry.name, "content", "en");
        if (fs.existsSync(dir) && portalDirHasCicode(dir)) {
          resolvedPortalPath = dir;
          return dir;
        }
      }
    } catch {
      // Permission error, try next base
    }
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
  resolvedPortalPath = null;
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse a single Author-it portal topic (2023 R2+). Returns null when the
 * topic is not a Cicode function reference (e.g. a concept/overview page).
 *
 * Portal topic shape (classes differ from Flare but the data is the same):
 *   <div data-aitid="1033446">
 *     <h5>AlarmAckRec</h5>
 *     <p class="paragraph">summary...</p>
 *     <p class="subheading">Syntax</p>
 *     <p class="paragraph">INT AlarmAckRec(LONG Record [, STRING ClusterName])</p>
 *     <p class="parameterterm">Record</p>
 *     <p class="parameterdefinition">The alarm record number...</p>
 *     <p class="subheading">Return Value</p>
 *     <p class="paragraph">0 if successful...</p>
 */
function parsePortalTopic(
  $: cheerio.CheerioAPI,
  idFromFile: string,
): BuiltinFunction | null {
  const root = $("div[data-aitid]").first();
  const scope = root.length ? root : $("body");

  const name = scope.find("h5").first().text().trim();
  if (!name) return null;

  const helpId = (root.attr("data-aitid") || idFromFile).trim();

  // Walk the topic's children in document order, tracking the current
  // subheading so paragraphs land in the right bucket.
  let section = "";
  let summary = "";
  let sigText = "";
  let returnsDoc = "";
  const paramDocs: Record<string, string> = {};
  let pendingTerm: string | null = null;

  scope.children().each((_, el) => {
    const $el = $(el);
    if ($el.is("h5")) return;

    if ($el.hasClass("subheading")) {
      section = squish($el.text()).toLowerCase();
      return;
    }
    if ($el.hasClass("parameterterm")) {
      // Some topics suffix the term with a colon ("Record:"); drop it so the
      // key matches the parameter name used elsewhere.
      pendingTerm = squish($el.text()).replace(/[:：]\s*$/, "");
      return;
    }
    if ($el.hasClass("parameterdefinition")) {
      if (pendingTerm) {
        const desc = squish($el.text());
        if (desc && !paramDocs[pendingTerm]) paramDocs[pendingTerm] = desc;
        pendingTerm = null;
      }
      return;
    }
    if ($el.hasClass("paragraph")) {
      const txt = squish($el.text());
      if (!txt) return;
      if (!section && !summary)
        summary = txt; // before the first subheading
      else if (section === "syntax" && !sigText) sigText = txt;
      else if (section === "return value" && !returnsDoc) returnsDoc = txt;
    }
  });

  // A real Cicode function topic has a signature "NAME(...)" (optionally
  // prefixed by a return type). Anything else is a concept/overview page.
  if (
    !sigText ||
    !new RegExp("\\b" + escapeRegExp(name) + "\\s*\\(").test(sigText)
  )
    return null;

  let params: string[] = [];
  const m = sigText.match(/\((.*)\)/);
  if (m) {
    params = m[1]
      .split(",")
      .map((p) => squish(p.replace(/\s+/g, " ")))
      .filter(Boolean);
  }

  // Return type: a type token preceding the function name in the signature.
  let returnType = "UNKNOWN";
  const head = sigText.slice(0, sigText.indexOf("(")).trim();
  const tokens = head.split(/\s+/).filter(Boolean);
  if (
    tokens.length >= 2 &&
    new RegExp(`^(${CICODE_TYPES_PATTERN})$`, "i").test(tokens[0])
  ) {
    returnType = tokens[0].toUpperCase();
  }

  return {
    name,
    returnType,
    params,
    doc: summary,
    returns: returnsDoc || undefined,
    paramDocs,
    helpId,
  };
}

/** Scrape Cicode builtins from the Author-it portal content folder. */
function scrapePortal(inputDir: string): Record<string, BuiltinFunction> {
  const out: Record<string, BuiltinFunction> = {};
  for (const file of fs.readdirSync(inputDir)) {
    if (path.extname(file).toLowerCase() !== ".html") continue;
    try {
      const html = fs.readFileSync(path.join(inputDir, file), "utf8");
      // Cheap pre-filter to skip the thousands of non-function topics.
      if (!html.includes('class="subheading">Syntax')) continue;
      const $ = cheerio.load(html);
      const fn = parsePortalTopic($, path.basename(file, path.extname(file)));
      if (fn) out[fn.name.toLowerCase()] = fn;
    } catch (e) {
      error("portal builtin parse fail", file, e);
    }
  }
  return out;
}

export async function rebuildBuiltins(
  context: vscode.ExtensionContext,
  cfg: () => vscode.WorkspaceConfiguration,
): Promise<Map<string, BuiltinFunction>> {
  // Clear cache to force re-resolution
  clearPathCache();

  // Prefer the 2023 R2+ Author-it web portal content: it is the copy that is
  // reliably installed and yields topic ids for the help-server deep-link.
  const portalDir = resolvePortalContentPath(cfg);
  if (portalDir) {
    const portalOut = scrapePortal(portalDir);
    if (Object.keys(portalOut).length) return save(context, portalOut);
  }

  // Fallback: legacy MadCap Flare help files.
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
