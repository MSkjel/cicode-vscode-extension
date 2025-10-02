import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import * as cheerio from "cheerio";
import { BuiltinFunction } from "./types";

let builtinCache: Map<string, BuiltinFunction> = new Map();
const CACHE_FILE = "builtinFunctions.json";
const CACHE_VERSION = 3;

function asMap(
  obj: Record<string, BuiltinFunction> | undefined | null,
): Map<string, BuiltinFunction> {
  const m = new Map<string, BuiltinFunction>();
  for (const k of Object.keys(obj || {})) m.set(k, (obj as any)[k]);
  return m;
}

export async function initBuiltins(
  context: vscode.ExtensionContext,
  _cfg: () => vscode.WorkspaceConfiguration,
): Promise<void> {
  const file = path.join(context.globalStorageUri.fsPath, CACHE_FILE);
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data.v === CACHE_VERSION) builtinCache = asMap(data.functions);
    }
  } catch {}
  if (builtinCache.size === 0) {
    try {
      const packaged = context.asAbsolutePath(
        path.join("builtins", "builtinFunctions.json"),
      );
      if (fs.existsSync(packaged)) {
        const obj = JSON.parse(fs.readFileSync(packaged, "utf8"));
        builtinCache = asMap(obj);
      }
    } catch {}
  }
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
    if (!file.toLowerCase().endsWith(".htm")) continue;
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
      if (m)
        params = m[1]
          .split(",")
          .map((p) => p.replace(/\s+/g, " ").trim())
          .filter(Boolean);

      const desc =
        $("meta[name=description]").attr("content") ||
        $(".pBody").first().text().trim() ||
        "";

      let returnType = "UNKNOWN";
      const ret = $("p.SubHeading:contains('Return Value')")
        .next("p")
        .text()
        .trim();
      if (ret) {
        const first = ret.split(/\s+/)[0];
        if (/^(INT|REAL|STRING|OBJECT|BOOL|BOOLEAN|LONG|ULONG)$/i.test(first))
          returnType = first.toUpperCase();
      }

      out[name.toLowerCase()] = {
        name,
        returnType,
        params,
        doc: desc,
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
