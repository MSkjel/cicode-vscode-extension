import * as fs from "fs";
import * as path from "path";
import { parseDbf } from "../indexer/dbfReader";
import type { BuiltinFunction } from "./types";
import {
  paramName,
  splitSignatureParams,
  splitTopLevelCommas,
} from "./signature";

// The compiler's built-in function table, Bin\FUNC0.DBF of the installation.
// CtCmp32 reads NAME, TYPE, ARGC, OPTARGS and FLAGS from it; ARGNAMES is only
// shown by the Cicode Editor and does not always match ARGC.
const FUNC0_FILE = "FUNC0.DBF";

/** One FUNC0 row: [NAME, TYPE, ARGC, OPTARGS, FLAGS, ARGNAMES]. */
export type Func0Row = [string, string, string, string, string, string];

/**
 * Items of a parenthesised FUNC0 list. A default can be a call:
 * `(TimestampCreate(1601,1,1,0,0,0,1,1),86400,"")` has three items.
 */
function listItems(s: string): string[] {
  const inner = s.trim().replace(/^\(/, "").replace(/\)$/, "");
  if (!inner.trim()) return [];
  return splitTopLevelCommas(inner).map((item) => item.trim());
}

function fileIfExists(p: string): string | null {
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/**
 * Locate FUNC0.DBF: the Bin folder of cicode.avevaPath (the setting may
 * also name Bin itself or a folder inside the installation), the default
 * Plant SCADA folder, then any `<Program Files>\*\Bin` or
 * `<Program Files>\*\*\Bin` holding one (newest wins).
 */
export function findFunc0(avevaPath: string): string | null {
  const direct: string[] = [];
  if (avevaPath) {
    let dir = path.resolve(avevaPath);
    for (let i = 0; i < 3; i++) {
      direct.push(
        path.join(dir, "Bin", FUNC0_FILE),
        path.join(dir, FUNC0_FILE),
      );
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]
    .filter((r): r is string => !!r)
    .filter((r, i, a) => a.indexOf(r) === i);
  for (const r of roots)
    direct.push(path.join(r, "AVEVA Plant SCADA", "Bin", FUNC0_FILE));
  for (const p of direct) {
    const f = fileIfExists(p);
    if (f) return f;
  }

  const subdirs = (d: string): string[] => {
    try {
      return fs
        .readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(d, e.name));
    } catch {
      return [];
    }
  };
  const found: { file: string; mtime: number }[] = [];
  for (const r of roots) {
    for (const a of subdirs(r)) {
      for (const dir of [a, ...subdirs(a)]) {
        const file = path.join(dir, "Bin", FUNC0_FILE);
        try {
          const st = fs.statSync(file);
          if (st.isFile()) found.push({ file, mtime: st.mtimeMs });
        } catch {
          // No FUNC0.DBF in this folder.
        }
      }
    }
  }
  found.sort((x, y) => y.mtime - x.mtime);
  return found[0]?.file ?? null;
}

/** Read FUNC0.DBF; null when the file is missing or not a FUNC0 table. */
export function readFunc0(file: string): Func0Row[] | null {
  const recs = parseDbf(file);
  if (!recs.length || !("NAME" in recs[0]) || !("ARGC" in recs[0])) return null;
  const rows: Func0Row[] = [];
  for (const r of recs) {
    if (!r.NAME) continue;
    rows.push([
      r.NAME,
      r.TYPE || "",
      r.ARGC || "()",
      r.OPTARGS || "",
      r.FLAGS || "",
      r.ARGNAMES || "",
    ]);
  }
  return rows.length ? rows : null;
}

/** Argument names from a documentation parameter list, one per argument. */
function namesOf(params: string[] | undefined): string[] {
  return (params || []).map(paramName).filter(Boolean);
}

/**
 * Build a builtin entry from a FUNC0 row. `docParams` (the help topic's
 * parameter list) names the arguments when it has one name per argument,
 * otherwise ARGNAMES does; the table's types and defaults always win.
 */
export function func0Entry(
  row: Func0Row,
  docParams?: string[],
): BuiltinFunction {
  const [name, type, argc, optargs, flags, argnames] = row;
  const kinds = listItems(argc).map((k) => k.replace(/\s+/g, " "));
  const variadic =
    kinds.length > 0 && /^VARARG$/i.test(kinds[kinds.length - 1]);
  const fixed = variadic ? kinds.slice(0, -1) : kinds;
  const defaults = listItems(optargs);

  const fromDoc = namesOf(docParams);
  const fromTable = namesOf(
    splitSignatureParams(argnames.replace(/^\(|\)$/g, "")),
  );
  const names =
    fromDoc.length === fixed.length
      ? fromDoc
      : fromTable.length === fixed.length
        ? fromTable
        : fixed.map((_, i) => fromTable[i] || fromDoc[i] || `arg${i + 1}`);

  let minArgs = 0;
  const params = fixed.map((kind, i) => {
    const def = defaults[i] ?? "";
    if (!def) minArgs = i + 1;
    // Parameter strings carry the table's type word (LONG is not a
    // declarable Cicode type), except VARIANT and FUNCTION arguments, which
    // have none; argTypes keeps each exact kind, by-reference included.
    const base = kind.replace(/^var\s+/i, "").toUpperCase();
    const typed = /^(VARIANT|FUNCTION)$/.test(base)
      ? names[i]
      : `${base} ${names[i]}`;
    return def ? `${typed} = ${def}` : typed;
  });
  if (variadic) params.push("...");

  const obsolete = Number(flags) || 0;
  return {
    name,
    returnType: (type || "INT").toUpperCase(),
    params,
    doc: "",
    origin: "builtin",
    minArgs,
    maxArgs: variadic ? -1 : fixed.length,
    argTypes: kinds.map((k) =>
      /^var\s/i.test(k)
        ? `var ${k.slice(4).trim().toUpperCase()}`
        : k.toUpperCase(),
    ),
    ...(obsolete ? { obsolete } : {}),
  };
}
