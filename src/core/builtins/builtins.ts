import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import * as cheerio from "cheerio";
import { BuiltinFunction } from "./types";

let builtinCache: Map<string, BuiltinFunction> = new Map();
const CACHE_FILE = "builtinFunctions.json";
const CACHE_VERSION = 4;

function asMap(
  obj: Record<string, BuiltinFunction> | undefined | null,
): Map<string, BuiltinFunction> {
  const m = new Map<string, BuiltinFunction>();
  for (const k of Object.keys(obj || {})) m.set(k, (obj as any)[k]);
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

  if (loadFromDisk()) return;

  try {
    await rebuildBuiltins(context, cfg);
  } catch {}
  if (loadFromDisk()) return;

  loadFromShipped();
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
  return /^(INT|REAL|STRING|OBJECT|BOOL|BOOLEAN|LONG|ULONG|VOID)$/i.test(first)
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

  const $ps = $("p");

  $ps.each((i, el) => {
    const $p = $(el);

    if ($p.hasClass("pArgBody")) {
      const em = $p.find("em.cEmphasis, i").first();
      if (em.length) {
        const paramName = em.text();
        let remainder = $p.text();
        const label = new RegExp(
          "^\\s*" + escapeRegex(em.text()) + "\\s*[:\\-–—]?\\s*",
          "i",
        );
        remainder = squish(remainder.replace(label, ""));
        add(paramName, remainder);
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

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function rebuildBuiltins(
  context: vscode.ExtensionContext,
  cfg: () => vscode.WorkspaceConfiguration,
): Promise<Map<string, BuiltinFunction>> {
  const override =
    (cfg().get("cicode.builtins.path") as string | undefined)?.trim() || "";
  const inputDir =
    override ||
    "C:/Program Files (x86)/AVEVA Plant SCADA/Bin/Help/SCADA Help/Subsystems/CicodeReferenceCitectHTML/Content";

  const out: Record<string, BuiltinFunction> = {};
  if (!fs.existsSync(inputDir)) return save(context, out);

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
        helpPath: path.join(inputDir, file),
      };
    } catch (e) {
      console.error("builtin parse fail", file, e);
    }
  }

  return save(context, out);
}

function save(
  context: vscode.ExtensionContext,
  obj: Record<string, BuiltinFunction>,
): Map<string, BuiltinFunction> {
  const file = path.join(context.globalStorageUri.fsPath, CACHE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ v: CACHE_VERSION, functions: obj }, null, 2),
  );
  builtinCache = asMap(obj);
  return builtinCache;
}

export function getBuiltins(): Map<string, BuiltinFunction> {
  return builtinCache;
}
