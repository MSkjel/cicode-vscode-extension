import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import * as cheerio from "cheerio";
import { BuiltinFunction } from "./types";
import { computeParamBounds, error, escapeRegExp } from "../../shared/utils";
import { NAME_PATTERN } from "../../shared/constants";
import { nameKey } from "../../shared/textUtils";
import { Func0Row, findFunc0, func0Entry, readFunc0 } from "./func0";
import {
  SIGNATURE_TYPES,
  paramName,
  parseCallText,
  splitSignatureParams,
} from "./signature";

// Built-in functions are assembled from three sources:
//   - the compiler's own table, Bin\FUNC0.DBF of the installation (names,
//     return and argument types, exact argument bounds, obsolete flags), or
//     the copy shipped in builtins\builtinFunctions.json without an install;
//   - the shipped list of documented functions that are really Cicode in
//     AVEVA library projects or Include label macros (not compiler builtins);
//   - help text scraped from the local AVEVA documentation (cached in global
//     storage), with the shipped help text as the fallback.

let builtinCache: Map<string, BuiltinFunction> = new Map();
const CACHE_FILE = "builtinFunctions.json";
const CACHE_VERSION = 11;

const CONTENT_FOLDER_NAME = "CicodeReferenceCitectHTML";

// AVEVA Product Documentation portal (2023 R2+). The HelpDocumentationViewer
// service serves this content over https://localhost:28808/<Product>/, and the
// per-function topics live as numeric-id files under <Product>\content\en\.
const PORTAL_DOCS_SUBPATH = ["AVEVA", "Product Documentation"];
const PORTAL_PRODUCT = "Plant SCADA";

// The portal's content\en folder holds every Plant SCADA topic, including the
// CitectVBA function reference and the Graphics Builder Automation interface,
// whose topics look exactly like Cicode function topics (and reuse names such
// as Time, Date, SendKeys and CreateObject). Only topics listed under the
// "Cicode Reference" node of content\en\toc.json are scraped.
const PORTAL_TOC_FILE = "toc.json";
const CICODE_REFERENCE_TOC_ID = "1060490";
const CICODE_REFERENCE_TOC_NAME = "cicode reference";
// Fallback when the Cicode Reference node can't be found: skip these subtrees
// ("VBA Function Reference", "Graphics Builder Automation Interface").
const NON_CICODE_TOC_IDS = new Set(["1218011", "1152714"]);
const NON_CICODE_TOC_NAME_RE = /\bVBA\b|Graphics Builder Automation/i;

// Cached resolved paths
let resolvedContentPath: string | null = null;
let resolvedPortalPath: string | null = null;
// Whether resolvedPortalPath came from the user's cicode.avevaPath rather than
// the %ProgramData% auto-discovery.
let portalViaOverride = false;

// Product folder name the portal scrape resolved (e.g. "Plant SCADA").
// Persisted in the help cache so help URLs route to the right product.
let portalProductName: string | null = null;

// Help text from the last scrape (or the cache), keyed by lower-case name.
let helpDocs: Record<string, BuiltinFunction> = {};

// FUNC0.DBF the current builtins were read from; null = the shipped copy.
let func0Path: string | null = null;

// Assembled entries before signature overrides.
let pristineBuiltins: Map<string, BuiltinFunction> | null = null;

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
async function portalDirHasCicode(dir: string): Promise<boolean> {
  try {
    const files = (await fs.promises.readdir(dir)).filter((f) =>
      f.endsWith(".html"),
    );
    if (files.length < 50) return false; // not the full doc set
    // Sample a bounded number of files, reading only the head of each, for
    // the function-reference signature.
    const head = Buffer.alloc(8192);
    let checked = 0;
    for (const f of files) {
      if (checked >= 100) break;
      checked++;
      let fh: fs.promises.FileHandle | undefined;
      try {
        fh = await fs.promises.open(path.join(dir, f), "r");
        const { bytesRead } = await fh.read(head, 0, head.length, 0);
        const html = head.toString("utf8", 0, bytesRead);
        if (
          html.includes('class="subheading">Syntax') &&
          /class="strong">\s*[A-Za-z_][\w]*\s*<\/span>\(/.test(html)
        ) {
          return true;
        }
      } finally {
        await fh?.close();
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
export async function resolvePortalContentPath(
  cfg: () => vscode.WorkspaceConfiguration,
): Promise<string | null> {
  if (resolvedPortalPath) return resolvedPortalPath;

  // Allow an explicit override: avevaPath may point at the portal docs root,
  // at a portal product folder, or directly at its content\en folder.
  const override =
    (cfg().get("cicode.avevaPath") as string | undefined)?.trim() || "";

  const accept = (dir: string, viaOverride: boolean): string => {
    resolvedPortalPath = dir;
    portalViaOverride = viaOverride;
    // Layout is <Product>\content\en, so the product folder is the
    // grandparent of the accepted directory.
    portalProductName = path.basename(path.dirname(path.dirname(dir)));
    return dir;
  };

  if (override) {
    // The override itself is a content\en folder.
    if (await portalDirHasCicode(override)) return accept(override, true);

    // The override is a product folder containing content\en.
    const direct = path.join(override, "content", "en");
    if (fs.existsSync(direct) && (await portalDirHasCicode(direct)))
      return accept(direct, true);
  }

  // The user's override takes precedence over the %ProgramData% default.
  const bases: { dir: string; viaOverride: boolean }[] = [];
  if (override) bases.push({ dir: override, viaOverride: true });
  const programData = process.env.ProgramData || "C:\\ProgramData";
  bases.push({
    dir: path.join(programData, ...PORTAL_DOCS_SUBPATH),
    viaOverride: false,
  });

  for (const { dir: base, viaOverride } of bases) {
    if (!fs.existsSync(base)) continue;

    // Preferred: the Plant SCADA product folder.
    const preferred = path.join(base, PORTAL_PRODUCT, "content", "en");
    if (fs.existsSync(preferred) && (await portalDirHasCicode(preferred))) {
      return accept(preferred, viaOverride);
    }

    // Otherwise scan all product folders for one carrying Cicode topics.
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(base, entry.name, "content", "en");
        if (fs.existsSync(dir) && (await portalDirHasCicode(dir))) {
          return accept(dir, viaOverride);
        }
      }
    } catch {
      // Permission error, try next base
    }
  }

  return null;
}

/** Product folder name resolved by the portal scrape (e.g. "Plant SCADA"). */
export function getPortalProduct(): string | null {
  return portalProductName;
}

/** FUNC0.DBF the builtins were read from, or null when the shipped copy is used. */
export function getFunc0Path(): string | null {
  return func0Path;
}

/**
 * Clear cached paths (call when settings change)
 */
export function clearPathCache(): void {
  resolvedContentPath = null;
  resolvedPortalPath = null;
  portalViaOverride = false;
}

/**
 * Did the user set cicode.avevaPath themselves (at any scope), as opposed to
 * relying on the package.json default?
 */
function avevaPathIsExplicit(
  cfg: () => vscode.WorkspaceConfiguration,
): boolean {
  const i = cfg().inspect<string>("cicode.avevaPath");
  const v = i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
  return typeof v === "string" && v.trim() !== "";
}

/** Data shipped in builtins\builtinFunctions.json. */
interface ShippedBuiltins {
  /** FUNC0.DBF rows of the Plant SCADA release the file was generated from. */
  func0: Func0Row[];
  /** Documented functions that are library Cicode or label macros, with their real signatures. */
  library: Record<string, BuiltinFunction>;
  /** Help text per lower-case name. */
  docs: Record<string, BuiltinFunction>;
  /** Help topic names that differ from the function they document (lower-case). */
  docAliases: Record<string, string>;
  /** Documented names that are not callable (lower-case). */
  excluded: string[];
}

function readShipped(context: vscode.ExtensionContext): ShippedBuiltins {
  const empty: ShippedBuiltins = {
    func0: [],
    library: {},
    docs: {},
    docAliases: {},
    excluded: [],
  };
  try {
    const packaged = context.asAbsolutePath(
      path.join("builtins", "builtinFunctions.json"),
    );
    const obj = JSON.parse(fs.readFileSync(packaged, "utf8"));
    return {
      func0: Array.isArray(obj?.func0) ? obj.func0 : [],
      library: obj?.library ?? {},
      docs: obj?.docs ?? {},
      docAliases: obj?.docAliases ?? {},
      excluded: Array.isArray(obj?.excluded) ? obj.excluded : [],
    };
  } catch (e) {
    error("Cicode: Failed to read the shipped builtin list:", e);
    return empty;
  }
}

/**
 * Copy help text (not the signature) from a scraped or shipped doc entry.
 * Topics often name a parameter differently in the signature and in its
 * description ("AN" vs "nAN"); with one description per parameter they are
 * matched by position.
 */
function withHelp(
  fn: BuiltinFunction,
  help: BuiltinFunction | undefined,
): BuiltinFunction {
  if (!help) return fn;
  let paramDocs = help.paramDocs ?? fn.paramDocs;
  if (paramDocs) {
    const keys = Object.keys(paramDocs);
    const names = fn.params.filter((p) => p !== "...").map(paramName);
    if (keys.length === names.length && !names.every((n) => n in paramDocs!))
      paramDocs = Object.fromEntries(
        names.map((n, i) => [n, paramDocs![keys[i]]]),
      );
  }
  return {
    ...fn,
    doc: help.doc || fn.doc || "",
    returns: help.returns ?? fn.returns,
    paramDocs,
    helpId: help.helpId ?? fn.helpId,
    helpPath: help.helpPath ?? fn.helpPath,
  };
}

/**
 * Assemble the builtin list. FUNC0 rows are the compiler's builtins; shipped
 * library and label entries fill in documented names FUNC0 lacks; any other
 * documented name is kept without an origin (it may come from a library
 * project the extension doesn't know), except the known non-callable ones.
 */
function assemble(
  rows: Func0Row[],
  shipped: ShippedBuiltins,
  scraped: Record<string, BuiltinFunction>,
): Record<string, BuiltinFunction> {
  const docs: Record<string, BuiltinFunction> = { ...scraped };
  for (const [from, to] of Object.entries(shipped.docAliases)) {
    if (scraped[from] && !scraped[to]) docs[to] = scraped[from];
    delete docs[from];
  }
  const helpFor = (key: string) => docs[key] ?? shipped.docs[key];

  const out: Record<string, BuiltinFunction> = {};
  for (const row of rows) {
    const key = row[0].toLowerCase();
    const help = helpFor(key);
    out[key] = withHelp(func0Entry(row, help?.params), help);
  }
  for (const [key, fn] of Object.entries(shipped.library)) {
    if (!out[key]) out[key] = withHelp({ ...fn }, helpFor(key));
  }
  const excluded = new Set(shipped.excluded);
  for (const [key, fn] of Object.entries(docs)) {
    if (!out[key] && !excluded.has(key)) out[key] = { ...fn };
  }
  return out;
}

/** Rebuild builtinCache from FUNC0, the shipped data and the help cache. */
function assembleBuiltins(
  context: vscode.ExtensionContext,
  cfg: () => vscode.WorkspaceConfiguration,
): void {
  const shipped = readShipped(context);
  const avevaPath =
    (cfg().get("cicode.avevaPath") as string | undefined)?.trim() || "";
  const file = findFunc0(avevaPath);
  const live = file ? readFunc0(file) : null;
  func0Path = live ? file : null;
  builtinCache = new Map(
    Object.entries(assemble(live ?? shipped.func0, shipped, helpDocs)),
  );
  pristineBuiltins = null;
  applySignatureOverrides(cfg);
}

function loadHelpCache(context: vscode.ExtensionContext): boolean {
  const file = path.join(context.globalStorageUri.fsPath, CACHE_FILE);
  try {
    if (!fs.existsSync(file)) return false;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data?.v !== CACHE_VERSION || !data?.docs) return false;
    if (!Object.keys(data.docs).length) return false;
    helpDocs = data.docs;
    portalProductName =
      typeof data.product === "string" && data.product ? data.product : null;
    return true;
  } catch {
    return false;
  }
}

function saveHelpCache(context: vscode.ExtensionContext): void {
  const file = path.join(context.globalStorageUri.fsPath, CACHE_FILE);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        v: CACHE_VERSION,
        product: portalProductName ?? undefined,
        docs: helpDocs,
      }),
    );
  } catch (e) {
    error("Cicode: Failed to save builtin cache:", file, e);
  }
}

export async function initBuiltins(
  context: vscode.ExtensionContext,
  cfg: () => vscode.WorkspaceConfiguration,
): Promise<void> {
  if (!loadHelpCache(context)) {
    try {
      await rebuildBuiltins(context, cfg);
      return;
    } catch (e) {
      error("Cicode: Failed to rebuild builtins from help files:", e);
      helpDocs = {};
    }
  }
  assembleBuiltins(context, cfg);
}

/** Re-read FUNC0 and reassemble with the cached help text (no help scrape). */
export function reloadBuiltins(
  context: vscode.ExtensionContext,
  cfg: () => vscode.WorkspaceConfiguration,
): void {
  assembleBuiltins(context, cfg);
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

/** A return type named by the first word of the Flare "Return Value" text. */
function extractReturnType($: cheerio.CheerioAPI): string {
  const retText = $("p.SubHeading:contains('Return Value')").next("p").text();
  const first = (squish(retText).split(/\s+/)[0] || "").toUpperCase();
  return SIGNATURE_TYPES.has(first) ? first : "UNKNOWN";
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

  $("p").each((_, el) => {
    const $p = $(el);

    if ($p.hasClass("pArgBody")) {
      const em = $p.find("em.cEmphasis, i").first();
      if (em.length) {
        const paramName = em.text();
        const label = new RegExp(
          "^\\s*" + escapeRegExp(paramName) + "\\s*[:\\-\u2013\u2014]?\\s*",
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

  return cleanParamDocs(paramDocs);
}

/** Drop parameter-doc entries that are a signature rather than a description. */
function cleanParamDocs(docs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(docs)) {
    if (/[,(]/.test(k) || /^[A-Za-z_]\w*\s*\(.*\)$/.test(v)) continue;
    out[k] = v;
  }
  return out;
}

/** Return type named by the first word of a signature ("INT Foo(...)"). */
function signatureReturnType(head: string): string {
  const tokens = head.split(/\s+/).filter(Boolean);
  const t = (tokens[0] || "").toUpperCase();
  return tokens.length >= 2 && SIGNATURE_TYPES.has(t) ? t : "UNKNOWN";
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
 *
 * A few topics (ScheduleItemDelete, StrToLocalText, TrnBrowseClose) have no
 * Syntax subheading; their signature paragraph comes before the first
 * subheading.
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

  // Many topics glue the return type to the name span
  // (`INT<span class="strong">ArrayDestroy</span>(...)`), which .text()
  // flattens to "INTArrayDestroy(...)". Join the inline children with a
  // space wherever two words would otherwise run together.
  const signatureOf = (el: cheerio.Cheerio<any>) => ({
    text: squish(
      el
        .contents()
        .toArray()
        .reduce((acc, node) => {
          const t = $(node).text();
          return /\w$/.test(acc) && /^\w/.test(t) ? `${acc} ${t}` : acc + t;
        }, ""),
    ),
    name: squish(el.find(".strong").first().text()),
  });

  // Walk the topic's children in document order, tracking the current
  // subheading so paragraphs land in the right bucket.
  let section = "";
  let summary = "";
  let sig: { text: string; name: string } | null = null;
  let preSig: { text: string; name: string } | null = null;
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
      if (!section) {
        if (!summary) summary = txt;
        else if (!preSig && $el.find(".strong").length && txt.includes("("))
          preSig = signatureOf($el);
      } else if (section === "syntax" && !sig) {
        sig = signatureOf($el);
      } else if (section === "return value" && !returnsDoc) {
        returnsDoc = txt;
      }
    }
  });

  // A real Cicode function topic has a signature "NAME(...)" (optionally
  // prefixed by a return type). Anything else is a concept/overview page.
  // Cicode is case-insensitive and some topics differ from their heading in
  // case only (SOEDismount vs SOEDisMount). A few topics misspell the name in
  // the signature (DspAnInRgn vs "pAnInRgn"); they are still accepted when
  // the bold signature name is followed by "(", and keep the heading's name.
  const callRe = (n: string) =>
    new RegExp("\\b" + escapeRegExp(n) + "\\s*\\(", "i");
  const isSignature = (s: { text: string; name: string } | null) =>
    !!s &&
    !!s.text &&
    (callRe(name).test(s.text) ||
      (/^[A-Za-z_]\w*$/.test(s.name) && callRe(s.name).test(s.text)));
  const chosen = isSignature(sig) ? sig! : isSignature(preSig) ? preSig! : null;
  if (!chosen) return null;

  const call = parseCallText(chosen.text);
  return {
    name,
    returnType: signatureReturnType(call?.head ?? ""),
    params: call?.params ?? [],
    doc: summary,
    returns: returnsDoc || undefined,
    paramDocs: cleanParamDocs(paramDocs),
    helpId,
  };
}

interface PortalTocItem {
  name?: string;
  id?: string;
  items?: PortalTocItem[];
}

/**
 * Topic ids to scrape, taken from the portal's toc.json: everything under the
 * "Cicode Reference" node. If that node is missing, every toc topic except
 * the VBA and Graphics Builder Automation references. Returns null when the
 * toc can't be read, in which case the whole folder is scanned.
 */
async function portalCicodeTopicIds(
  inputDir: string,
): Promise<string[] | null> {
  let items: PortalTocItem[];
  try {
    const toc = JSON.parse(
      await fs.promises.readFile(path.join(inputDir, PORTAL_TOC_FILE), "utf8"),
    );
    if (!Array.isArray(toc?.items)) return null;
    items = toc.items;
  } catch {
    return null;
  }

  const collect = (nodes: PortalTocItem[], ids: Set<string>): Set<string> => {
    for (const n of nodes) {
      if (n.id) ids.add(n.id);
      if (n.items) collect(n.items, ids);
    }
    return ids;
  };

  const findRef = (nodes: PortalTocItem[]): PortalTocItem | undefined => {
    for (const n of nodes) {
      if (
        n.id === CICODE_REFERENCE_TOC_ID ||
        squish(n.name || "").toLowerCase() === CICODE_REFERENCE_TOC_NAME
      )
        return n;
      const r = n.items && findRef(n.items);
      if (r) return r;
    }
    return undefined;
  };

  const ref = findRef(items);
  if (ref) return [...collect([ref], new Set())];

  const excluded = (n: PortalTocItem) =>
    (!!n.id && NON_CICODE_TOC_IDS.has(n.id)) ||
    NON_CICODE_TOC_NAME_RE.test(n.name || "");
  const ids = new Set<string>();
  const walk = (nodes: PortalTocItem[]) => {
    for (const n of nodes) {
      if (excluded(n)) continue;
      if (n.id) ids.add(n.id);
      if (n.items) walk(n.items);
    }
  };
  walk(items);
  return ids.size ? [...ids] : null;
}

/** Scrape Cicode builtins from the Author-it portal content folder. */
async function scrapePortal(
  inputDir: string,
): Promise<Record<string, BuiltinFunction>> {
  const out: Record<string, BuiltinFunction> = {};
  const ids = await portalCicodeTopicIds(inputDir);
  const files = ids
    ? ids.filter((id) => /^[\w-]+$/.test(id)).map((id) => `${id}.html`)
    : (await fs.promises.readdir(inputDir)).filter(
        (f) => path.extname(f).toLowerCase() === ".html",
      );
  let processed = 0;
  for (const file of files) {
    // Yield to the event loop so the scrape doesn't starve the host.
    if (++processed % 50 === 0) await new Promise((r) => setImmediate(r));
    let html: string;
    try {
      html = await fs.promises.readFile(path.join(inputDir, file), "utf8");
    } catch {
      continue; // toc entry without a topic file
    }
    try {
      // Cheap pre-filter to skip category/overview (non-function) topics:
      // a function topic has a bold name followed by "(".
      if (!/class="strong">[^<]*<\/span>\s*\(/.test(html)) continue;
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
  portalProductName = null;

  helpDocs = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "Cicode: scanning AVEVA help documentation for builtins...",
    },
    () => scrapeHelp(cfg),
  );
  // An empty scrape isn't cached, so a later help install is picked up.
  if (Object.keys(helpDocs).length) saveHelpCache(context);
  else {
    try {
      fs.rmSync(path.join(context.globalStorageUri.fsPath, CACHE_FILE), {
        force: true,
      });
    } catch {
      // A cache that can't be removed is read again at the next activation.
    }
  }
  assembleBuiltins(context, cfg);
  return builtinCache;
}

async function scrapeHelp(
  cfg: () => vscode.WorkspaceConfiguration,
): Promise<Record<string, BuiltinFunction>> {
  // Prefer the 2023 R2+ Author-it web portal content: it is the copy that is
  // reliably installed and yields topic ids for the help-server deep-link.
  const portalDir = await resolvePortalContentPath(cfg);

  // ...unless the user explicitly pointed cicode.avevaPath at legacy Flare
  // help and the portal was only auto-discovered under %ProgramData% (e.g. a
  // side-by-side 2020 + 2023 R2 machine): honour the explicit choice.
  if (portalDir && !portalViaOverride && avevaPathIsExplicit(cfg)) {
    const flareDir = resolveContentPath(cfg);
    const flareOut = flareDir ? await scrapeFlare(flareDir) : {};
    if (Object.keys(flareOut).length) {
      // Flare entries carry no portal topic ids, so no portal product applies.
      portalProductName = null;
      return flareOut;
    }
  }

  if (portalDir) {
    const portalOut = await scrapePortal(portalDir);
    if (Object.keys(portalOut).length) return portalOut;
  }

  // Fallback: legacy MadCap Flare help files (2020 / file-based installs).
  const inputDir = resolveContentPath(cfg);
  if (!inputDir || !fs.existsSync(inputDir)) return {};
  return scrapeFlare(inputDir);
}

/** Scrape Cicode builtins from a legacy MadCap Flare help content folder. */
async function scrapeFlare(
  inputDir: string,
): Promise<Record<string, BuiltinFunction>> {
  const out: Record<string, BuiltinFunction> = {};
  let processed = 0;
  for (const file of await fs.promises.readdir(inputDir)) {
    const ext = path.extname(file).toLowerCase();
    if (ext !== ".htm" && ext !== ".html") continue;
    // Yield to the event loop so the scrape doesn't starve the host.
    if (++processed % 50 === 0) await new Promise((r) => setImmediate(r));

    try {
      const html = await fs.promises.readFile(
        path.join(inputDir, file),
        "utf8",
      );
      const $ = cheerio.load(html);
      const name = $(".pFunctionName").first().text().trim();
      if (!name) continue;

      let syntaxLine = $("p:contains('Syntax')").next("p").text().trim();
      if (!syntaxLine)
        syntaxLine = $("p:contains('Syntax')").next("pre").text().trim();
      const call = parseCallText(squish(syntaxLine));

      out[name.toLowerCase()] = {
        name,
        returnType: extractReturnType($),
        params: call?.params ?? [],
        doc: extractSummary($),
        returns: extractReturnsDoc($),
        paramDocs: extractParamDocs($),
        helpPath: file, // Just store filename, construct full path at runtime
      };
    } catch (e) {
      error("builtin parse fail", file, e);
    }
  }

  return out;
}

export function getBuiltins(): Map<string, BuiltinFunction> {
  return builtinCache;
}

const SIGNATURE_RE = new RegExp(
  `^(${NAME_PATTERN})\\s+(${NAME_PATTERN})\\s*\\((.*)\\)\\s*$`,
  "s",
);

/**
 * Parse a signature override such as
 *   STRING MyFormat(STRING sText, [STRING sPicture])
 *   INT Foo(INT a [, INT b [, INT c]])
 * Returns null when the string isn't "TYPE NAME(...)".
 */
function parseSignature(sig: string): BuiltinFunction | null {
  const m = sig.trim().match(SIGNATURE_RE);
  if (!m) return null;
  const [, returnType, name, rawParams] = m;
  return {
    name,
    returnType: returnType.toUpperCase(),
    params: splitSignatureParams(rawParams),
    doc: "",
  };
}

/** Apply cicode.signatureOverrides from settings over the current builtinCache. */
export function applySignatureOverrides(
  cfg: () => vscode.WorkspaceConfiguration,
): void {
  // Restore the pristine entries first so re-applying never stacks on
  // previously overridden ones and removed overrides revert.
  if (pristineBuiltins) builtinCache = new Map(pristineBuiltins);
  else pristineBuiltins = new Map(builtinCache);

  const overrides: string[] = cfg().get("cicode.signatureOverrides", []);
  for (const sig of overrides) {
    const entry = parseSignature(sig);
    if (!entry) continue;
    const key = nameKey(entry.name);
    const { min, max } = computeParamBounds(entry.params);
    const signature = {
      returnType: entry.returnType,
      params: entry.params,
      minArgs: min,
      maxArgs: Number.isFinite(max) ? max : -1,
      argTypes: undefined,
    };
    const existing = builtinCache.get(key);
    builtinCache.set(
      key,
      existing ? { ...existing, ...signature } : { ...entry, ...signature },
    );
  }
}
