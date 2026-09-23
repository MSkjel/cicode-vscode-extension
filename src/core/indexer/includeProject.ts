import * as fs from "fs";
import * as path from "path";
import { parseDbf } from "./dbfReader";

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Path of the file `name` directly inside `dir`, matched case-insensitively
 *  like the compiler does (LABELS.DBF and labels.DBF are the same table). */
export function findFileInDir(dir: string, name: string): string | undefined {
  const lower = name.toLowerCase();
  const hit = readDir(dir).find((e) => e.toLowerCase() === lower);
  return hit ? path.join(dir, hit) : undefined;
}

/** Value of `key` in `[section]` of an INI text (case-insensitive). */
function iniValue(
  ini: string,
  section: string,
  key: string,
): string | undefined {
  let inSection = false;
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[(.*)\]$/.exec(line);
    if (sec) {
      inSection = sec[1].trim().toLowerCase() === section.toLowerCase();
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (
      eq > 0 &&
      line.slice(0, eq).trim().toLowerCase() === key.toLowerCase()
    ) {
      return line.slice(eq + 1).trim() || undefined;
    }
  }
  return undefined;
}

/** Folder of the project registered as `name` in a User folder's MASTER.DBF. */
function projectFromMaster(userDir: string, name: string): string | undefined {
  const master = findFileInDir(userDir, "MASTER.DBF");
  if (!master) return undefined;
  for (const row of parseDbf(master)) {
    if ((row["NAME"] ?? "").toLowerCase() !== name.toLowerCase()) continue;
    const dir = (row["PATH"] ?? "").replace(/[\\/]+$/, "");
    if (dir && isDir(dir)) return dir;
  }
  return undefined;
}

/** User folders (holding MASTER.DBF) at or above `dir`. */
function userDirsAbove(dir: string): string[] {
  const out: string[] = [];
  let d = path.resolve(dir);
  for (let depth = 0; depth < 12; depth++) {
    if (findFileInDir(d, "MASTER.DBF")) out.push(d);
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return out;
}

/** True if `p` is `dir` or lies inside it. */
function isWithin(p: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** User folders of installed Plant SCADA / Citect SCADA versions. Those
 *  whose citect.ini `[CtEdit]Bin` lies in `install` come first, then the
 *  most recently used (by the age of their citect.ini). */
function installedUserDirs(install?: string): string[] {
  const programData = process.env.ProgramData || "C:\\ProgramData";
  const roots: string[] = [];
  const scan = (base: string) => {
    for (const e of readDir(base)) {
      if (/plant scada|citect/i.test(e)) roots.push(path.join(base, e));
    }
  };
  scan(programData);
  scan(path.join(programData, "Schneider Electric"));
  scan(path.join(programData, "AVEVA"));

  const found: Array<{ dir: string; mtime: number; ours: boolean }> = [];
  for (const root of roots) {
    const ini = path.join(root, "Config", "citect.ini");
    let mtime = 0;
    let user: string | undefined;
    let bin: string | undefined;
    try {
      mtime = fs.statSync(ini).mtimeMs;
      const text = fs.readFileSync(ini, "latin1");
      user = iniValue(text, "CtEdit", "User");
      bin = iniValue(text, "CtEdit", "Bin");
    } catch {
      /* no citect.ini: fall back to <root>\User */
    }
    const dir = user && isDir(user) ? user : path.join(root, "User");
    const ours = !!install && !!bin && isWithin(bin, install);
    if (isDir(dir)) found.push({ dir, mtime, ours });
  }
  return found
    .sort((a, b) => Number(b.ours) - Number(a.ours) || b.mtime - a.mtime)
    .map((f) => f.dir);
}

export interface IncludeLookup {
  /** Explicit Include project folder (or its labels.DBF); skips discovery. */
  readonly explicit?: string;
  /** Folders to start from, e.g. the workspace folders. */
  readonly near: readonly string[];
  /** The `cicode.avevaPath` setting: the installation folder, whose
   *  version's User folder is preferred (a User or data folder works too). */
  readonly avevaPath?: string;
}

/**
 * labels.DBF of the Include project, which the compiler adds to every
 * project. Searched in the User folder above the given folders (its
 * MASTER.DBF names the Include project), then in the installed versions'
 * User folders. Undefined when none is found; never throws.
 */
export function locateIncludeLabels(opts: IncludeLookup): string | undefined {
  try {
    return locate(opts);
  } catch {
    return undefined;
  }
}

function locate(opts: IncludeLookup): string | undefined {
  const labelsIn = (dir: string | undefined) =>
    dir && isDir(dir) ? findFileInDir(dir, "labels.DBF") : undefined;

  if (opts.explicit) {
    const p = path.resolve(opts.explicit);
    return /\.dbf$/i.test(p) && fs.existsSync(p) ? p : labelsIn(p);
  }

  const userDirs: string[] = [];
  for (const d of opts.near) userDirs.push(...userDirsAbove(d));
  if (opts.avevaPath) {
    userDirs.push(opts.avevaPath, path.join(opts.avevaPath, "User"));
  }
  userDirs.push(...installedUserDirs(opts.avevaPath));

  const seen = new Set<string>();
  for (const u of userDirs) {
    const key = path.resolve(u).toLowerCase();
    if (seen.has(key) || !isDir(u)) continue;
    seen.add(key);
    const hit =
      labelsIn(projectFromMaster(u, "Include")) ??
      labelsIn(path.join(u, "Include"));
    if (hit) return hit;
  }
  return undefined;
}
