import * as path from "path";
import { nameKey } from "../../shared/textUtils";
import { parseDbf, readDbfStrict } from "./dbfReader";
import {
  candidateUserDirs,
  findFileInDir,
  isDir,
  readDir,
  userDirsAbove,
} from "./includeProject";

// A project compiles with the projects its include.DBF names (recursively,
// through the User folder's MASTER.DBF), plus System and Include, which
// every compile holds. Compiling a root gives one unit: System, Include,
// the includes depth-first post-order in row order (each once), the root.
// Names are shared by every project of a unit, so a project sees the union
// of the units holding it.

/** Identity of a project folder: resolved, lower-case, no trailing
 *  separator (Uri.file(p).fsPath compared case-insensitively). */
export function projectKey(folder: string): string {
  return path.resolve(folder).toLowerCase();
}

export interface ProjectInfo {
  /** Identity (projectKey of the folder). */
  readonly key: string;
  /** The folder as the workspace or MASTER.DBF gives it. */
  readonly folder: string;
  /** MASTER.DBF name, else the folder name. */
  readonly name: string;
  /** Holds workspace sources. */
  readonly inWorkspace: boolean;
  /** No registered or workspace project owns the folder: it compiles with
   *  its own include rows only, and no other project sees it. */
  readonly stray: boolean;
  /** Key of the project whose folder holds this unregistered one (a backup
   *  or scratch copy): no compile reads it (<PATH>\*.ci only), it sees what
   *  that project sees, and nothing sees it. Always a stray. */
  readonly overlayOf?: string;
}

export interface CompileUnit {
  /** Name of the compiled project. */
  readonly root: string;
  readonly rootKey: string;
  /** Project keys in compile order: System, Include, the includes
   *  depth-first post-order in row order, the root. */
  readonly projects: readonly string[];
  /** Every include row resolved (no unknown or blank name, no cycle, no
   *  table cut short) and Include was found with sources. */
  readonly complete: boolean;
}

/** One compile unit per shared unit, with the order of two files in it. */
export interface UnitOrder {
  readonly unit: CompileUnit;
  /** -1 when the first file compiles first, 1 when the second does, 0 for
   *  the same file. */
  readonly order: -1 | 0 | 1;
}

export interface GraphInput {
  /** Workspace folder paths. */
  readonly workspaceFolders: readonly string[];
  /** Folders holding workspace sources (.ci, labels.DBF, locvar.DBF,
   *  include.DBF). */
  readonly sourceFolders: readonly string[];
  /** Workspace folders with .ci files cicode.indexing.excludePatterns
   *  hides: the compiler still reads them, so their units are not fully
   *  indexed. */
  readonly partialFolders?: readonly string[];
  /** Folders of .ci files opened from outside the workspace: their
   *  projects are indexed with what they compile with (looseProjects). */
  readonly looseFolders?: readonly string[];
  /** `cicode.indexing.includeProjectPath`: the Include folder or its
   *  labels.DBF. */
  readonly includeProjectPath?: string;
  /** `cicode.avevaPath`. */
  readonly avevaPath?: string;
}

export interface GraphBuild {
  readonly graph: ProjectGraph;
  /** False when a MASTER.DBF or include.DBF could not be read whole. */
  readonly ok: boolean;
  /** Every MASTER.DBF was read whole: the graph is usable even when an
   *  include.DBF stays short (its units count as incomplete). */
  readonly mastersOk: boolean;
}

/** One MASTER.DBF and the names it resolves. */
interface Registry {
  /** Folder of the MASTER.DBF; undefined without one. */
  readonly userDir?: string;
  /** nameKey -> project key. */
  readonly names: Map<string, string>;
  /** Names of project folders in this User folder that MASTER.DBF does not
   *  register: an include row naming one is F4016 for the compiler. */
  readonly unregistered: Set<string>;
  includeKey?: string;
  systemKey?: string;
  /** Include was found and holds sources. */
  includeOk: boolean;
}

/** A project's include rows. */
interface Rows {
  /** Resolved include rows, in row order. */
  readonly edges: string[];
  /** Include rows that break a compile: unknown or blank names, self
   *  includes. */
  readonly unresolved: string[];
  /** The include.DBF was cut short or unreadable: rows may be missing. */
  partial: boolean;
}

interface Node extends ProjectInfo, Rows {
  readonly reg: Registry;
}

class Unit implements CompileUnit {
  readonly index = new Map<string, number>();

  constructor(
    readonly root: string,
    readonly rootKey: string,
    readonly projects: readonly string[],
    readonly complete: boolean,
  ) {
    projects.forEach((k, i) => this.index.set(k, i));
  }
}

interface Stray {
  readonly info: ProjectInfo;
  readonly rows: Rows;
  readonly unit: Unit;
}

/** A stray known at build time, its rows read then: a workspace folder that
 *  lost its name to another folder, or the folder of a loose file. */
interface KnownStray extends Rows {
  readonly reg: Registry;
  readonly folder: string;
  readonly inWorkspace: boolean;
  readonly overlayOf?: string;
}

/** What is indexed besides the workspace. */
interface Scope {
  /** External projects (externalFolders), by key. */
  readonly ext: ReadonlyMap<string, ProjectInfo>;
  /** Workspace projects and workspace strays, by key. */
  readonly ws: readonly ProjectInfo[];
  /** looseProjects, by key. */
  readonly loose: ReadonlyMap<string, ProjectInfo>;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byKey = (a: { key: string }, b: { key: string }) => cmp(a.key, b.key);

const regSig = (r: Registry) => [
  r.userDir ?? "",
  r.includeKey ?? "",
  r.systemKey ?? "",
  r.includeOk,
];
const rowsSig = (r: Rows) => [r.edges, r.unresolved, r.partial];
const nodeSig = (n: Node) => [n.key, n.name, n.inWorkspace, ...rowsSig(n)];
const straySig = (k: string, s: KnownStray) => [
  k,
  s.inWorkspace,
  s.overlayOf ?? "",
  ...rowsSig(s),
];
const unitSig = (u: Unit) => [u.rootKey, u.projects, u.complete];

function hasSources(folder: string): boolean {
  return readDir(folder).some((e) => /\.ci$|^labels\.dbf$/i.test(e));
}

/** The nearest folder above the one keyed `key` that `isHome` accepts. */
function homeAbove(
  key: string,
  isHome: (k: string) => boolean,
): string | undefined {
  for (let d = path.dirname(key); ; ) {
    if (isHome(d)) return d;
    const up = path.dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

const depth = (key: string) => key.split(path.sep).length;

/** Upper-case file name order, the order of the files of one project. */
function compareFileNames(a: string, b: string): -1 | 0 | 1 {
  const x = path.basename(a).toUpperCase();
  const y = path.basename(b).toUpperCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Include rows of a folder (NAME per live row; blank names kept). */
function includeRows(
  folder: string,
  strict: boolean,
): { names: string[]; ok: boolean } {
  const f = findFileInDir(folder, "include.DBF");
  if (!f) return { names: [], ok: true };
  const rows = strict ? readDbfStrict(f) : undefined;
  return {
    names: (rows ?? parseDbf(f)).map((r) => (r["NAME"] ?? "").trim()),
    ok: !strict || rows !== undefined,
  };
}

/** Read and resolve the include rows of project `self` into `rows`; false
 *  when the table was not read whole. */
function readRows(
  reg: Registry,
  nodes: ReadonlyMap<string, Node>,
  self: string,
  folder: string,
  rows: Rows,
): boolean {
  const r = includeRows(folder, true);
  for (const name of r.names) {
    resolveRow(reg, nodes, self, name, rows.edges, rows.unresolved);
  }
  rows.partial = !r.ok;
  return r.ok;
}

/**
 * Projects, their include edges and compile units. Built from one MASTER.DBF
 * per workspace folder plus the workspace's project folders; immutable, with
 * memoized per-project queries.
 */
export class ProjectGraph {
  private readonly _files = new Map<string, ProjectInfo>();
  private readonly _dirs = new Map<string, ProjectInfo>();
  private readonly _strays = new Map<string, Stray>();
  private readonly _unitsOf = new Map<string, readonly Unit[]>();
  private readonly _visible = new Map<string, ReadonlyMap<string, number>>();
  private readonly _libraries = new Map<string, ProjectInfo | null>();
  private readonly _complete = new Map<string, boolean>();
  private readonly _known = new Map<string, boolean>();
  private _scope?: Scope;
  private _userDirs?: Set<string>;
  private _signature?: string;
  private _wsSignature?: string;

  /** @internal Use buildProjectGraph. */
  constructor(
    private readonly _nodes: ReadonlyMap<string, Node>,
    private readonly _registries: readonly Registry[],
    private readonly _defaultReg: Registry,
    private readonly _units: readonly Unit[],
    private readonly _roots: readonly ProjectInfo[],
    private readonly _wsFolders: readonly string[],
    private readonly _knownStrays: ReadonlyMap<string, KnownStray>,
    /** looseFolders by key. */
    private readonly _looseFolders: ReadonlyMap<string, string>,
    /** partialFolders by key. */
    private readonly _partial: ReadonlySet<string>,
  ) {}

  /** No MASTER.DBF, no workspace: every folder is a stray. */
  static empty(): ProjectGraph {
    const reg: Registry = {
      names: new Map(),
      unregistered: new Set(),
      includeOk: false,
    };
    return new ProjectGraph(
      new Map(),
      [],
      reg,
      [],
      [],
      [],
      new Map(),
      new Map(),
      new Set(),
    );
  }

  /** Every project: registered ones whose folder exists, and workspace
   *  project folders. */
  get projects(): readonly ProjectInfo[] {
    return [...this._nodes.values()];
  }

  /** Projects no other project includes (System and Include never are). */
  get roots(): readonly ProjectInfo[] {
    return this._roots;
  }

  /** One unit per root. */
  get units(): readonly CompileUnit[] {
    return this._units;
  }

  /** Folders of the MASTER.DBF files the graph was built from. */
  get userFolders(): readonly string[] {
    return this._registries.flatMap((r) => (r.userDir ? [r.userDir] : []));
  }

  project(key: string): ProjectInfo | undefined {
    return this._nodes.get(key);
  }

  /** The project of a file: its folder's. A folder no project owns (a stray
   *  file, a nested copy, no MASTER.DBF) is a project compiling with its own
   *  include rows only. */
  projectOf(file: string): ProjectInfo {
    // By path first: lookups run per token on the diagnostics hot path.
    let p = this._files.get(file);
    if (p) return p;
    if (!path.isAbsolute(file)) return this._stray("", "").info;
    const dir = path.dirname(file);
    p = this._dirs.get(dir);
    if (!p) {
      const key = projectKey(dir);
      p = this._nodes.get(key) ?? this._stray(key, dir).info;
      this._dirs.set(dir, p);
    }
    this._files.set(file, p);
    return p;
  }

  projectName(file: string): string {
    return this.projectOf(file).name;
  }

  /** The units compiling a file's project. */
  unitsOf(file: string): readonly CompileUnit[] {
    return this._unitsOfKey(this.projectOf(file));
  }

  /** Every unit of the file resolved all its include rows and has every
   *  project indexed (in the workspace, external or loose), so a name
   *  missing from them is certainly unknown to the compiler. False for a
   *  file of a project that is none of these (not indexed yet). */
  unitComplete(file: string): boolean {
    const p = this.projectOf(file);
    let done = this._complete.get(p.key);
    if (done === undefined) {
      done = this._unitsOfKey(p).every((u) => this._unitKnown(u, p));
      this._complete.set(p.key, done);
    }
    return done;
  }

  /** unitComplete for one unit of the file. */
  unitKnown(file: string, unit: CompileUnit): boolean {
    return unit instanceof Unit && this._unitKnown(unit, this.projectOf(file));
  }

  /** Include rows of the file's units that name no project ("" for a
   *  blank row). */
  unresolvedIncludes(file: string): string[] {
    const p = this.projectOf(file);
    const out = new Set(
      p.stray ? this._stray(p.key, p.folder).rows.unresolved : [],
    );
    for (const u of this._unitsOfKey(p)) {
      for (const k of u.projects) {
        this._nodes.get(k)?.unresolved.forEach((r) => out.add(r));
      }
    }
    return [...out];
  }

  /** Projects sharing a unit with the file's project, ranked by lookup
   *  preference: its own project 0, then unit order (System and Include
   *  first), the first unit before later ones. */
  visible(file: string): ReadonlyMap<string, number> {
    return this._visibleOf(this.projectOf(file));
  }

  /** Stable id of the file's visible set (its project key), for caches. */
  visibleKey(file: string): string {
    return this.projectOf(file).key;
  }

  /** A definition in `defFile` can be seen from `fromFile`: their projects
   *  share a unit. */
  isVisible(fromFile: string, defFile: string): boolean {
    return this.visible(fromFile).has(this.projectOf(defFile).key);
  }

  /** Both files are compiled together in some unit. Symmetric, except that
   *  a stray folder sees its includes while nothing sees it. */
  sameUnit(a: string, b: string): boolean {
    return this.isVisible(a, b);
  }

  /** The order of two files in each unit of `a` that holds both. */
  compareInUnit(a: string, b: string): UnitOrder[] {
    const pa = this.projectOf(a);
    const pb = this.projectOf(b);
    // An overlay is compiled with nothing: it only borrows names.
    if (pa.overlayOf && pa.key !== pb.key) return [];
    const out: UnitOrder[] = [];
    for (const u of this._unitsOfKey(pa)) {
      const ib = u.index.get(pb.key);
      if (ib === undefined) continue;
      const ia = u.index.get(pa.key)!;
      out.push({
        unit: u,
        order: ia < ib ? -1 : ia > ib ? 1 : compareFileNames(a, b),
      });
    }
    return out;
  }

  /** A file of the Include project (by MASTER name, or the
   *  includeProjectPath override). */
  isInclude(file: string): boolean {
    const p = this.projectOf(file);
    return !p.stray && this._registries.some((r) => r.includeKey === p.key);
  }

  /** Include or System: in every unit of their registry, never a root. */
  isImplicit(key: string): boolean {
    return this._registries.some(
      (r) => r.includeKey === key || r.systemKey === key,
    );
  }

  /** The file lies under a workspace folder. */
  underWorkspace(file: string): boolean {
    const key = projectKey(file);
    return this._wsFolders.some((w) => key.startsWith(w + path.sep));
  }

  /** The project named `name` visible from the file (nameKey match); for
   *  "Include", the file's Include project. */
  libraryProject(file: string, name: string): ProjectInfo | undefined {
    const p = this.projectOf(file);
    const nk = nameKey(name);
    const memo = `${p.key}|${nk}`;
    const hit = this._libraries.get(memo);
    if (hit !== undefined) return hit ?? undefined;
    const vis = this._visibleOf(p);
    let best: ProjectInfo | undefined;
    const inc = this._regOf(p).includeKey;
    if (nk === "include" && inc && vis.has(inc)) {
      best = this._nodes.get(inc);
    } else {
      let rank = Infinity;
      for (const [k, r] of vis) {
        const n = this._nodes.get(k);
        if (n && r < rank && nameKey(n.name) === nk) {
          best = n;
          rank = r;
        }
      }
    }
    this._libraries.set(memo, best ?? null);
    return best;
  }

  /** A project named `name` is in a unit of the file. Include always is. */
  hasLibrary(file: string, name: string): boolean {
    return (
      nameKey(name) === "include" ||
      this.libraryProject(file, name) !== undefined
    );
  }

  /** Projects outside the workspace that a workspace project or a loose
   *  project shares a unit with, plus Include: indexed from disk, never
   *  diagnosed. */
  externalFolders(): readonly ProjectInfo[] {
    return [...this._scopeOf().ext.values()];
  }

  /** A file of an external project (see externalFolders). */
  isExternal(file: string): boolean {
    const p = this.projectOf(file);
    return !p.stray && this._scopeOf().ext.has(p.key);
  }

  /** Projects of files opened from outside the workspace (looseFolders)
   *  that are not external: indexed from disk like external projects, but
   *  diagnosed. Their units count as indexed (unitComplete). */
  looseProjects(): readonly ProjectInfo[] {
    return [...this._scopeOf().loose.values()];
  }

  /** Changes when projects, names, edges, units or completeness change. */
  get signature(): string {
    return (this._signature ??= JSON.stringify([
      this._registries.map(regSig),
      [...this._nodes.values()].sort(byKey).map(nodeSig),
      this._units.map(unitSig),
      [...this._knownStrays]
        .sort(([a], [b]) => cmp(a, b))
        .map(([k, s]) => straySig(k, s)),
      [...this._scopeOf().loose.keys()],
      [...this._partial].sort(cmp),
    ]));
  }

  /** The part of the signature lookups from the workspace depend on: the
   *  projects it compiles with (names, rows), the units of its projects and
   *  their registries. Unchanged by projects no workspace project shares a
   *  unit with (a probe rig's registrations) and by loose projects. Include
   *  and System in the workspace count by their rows only: they are in
   *  every unit, so any registration changes their units, and only what
   *  their own files see (implicitSignature). */
  get workspaceSignature(): string {
    if (this._wsSignature === undefined) {
      const { ws } = this._scopeOf();
      const regs = new Set(ws.map((p) => this._regOf(p)));
      const own = ws.filter((p) => !this.isImplicit(p.key));
      const keys = new Set(ws.map((p) => p.key));
      for (const p of own)
        for (const k of this._visibleOf(p).keys()) keys.add(k);
      this._wsSignature = JSON.stringify([
        this._registries
          .filter((r) => r === this._defaultReg || regs.has(r))
          .map(regSig),
        [...keys].sort(cmp).map((k) => {
          const n = this._nodes.get(k);
          const s = this._knownStrays.get(k);
          return n ? nodeSig(n) : s ? straySig(k, s) : [k];
        }),
        own.map((p) => [p.key, this._unitsOfKey(p).map(unitSig)]),
        [...this._partial].filter((k) => keys.has(k)).sort(cmp),
      ]);
    }
    return this._wsSignature;
  }

  /** The units of Include and System where they are workspace projects. */
  get implicitSignature(): string {
    return JSON.stringify(
      this._scopeOf()
        .ws.filter((p) => this.isImplicit(p.key))
        .map((p) => [p.key, this._unitsOfKey(p).map(unitSig)]),
    );
  }

  // ---------------------------------------------------------------------------

  private _scopeOf(): Scope {
    if (!this._scope) {
      const ext = new Map<string, ProjectInfo>();
      const add = (k: string) => {
        const n = this._nodes.get(k);
        if (n && !n.inWorkspace) ext.set(k, n);
      };
      const ws: ProjectInfo[] = [];
      for (const n of this._nodes.values()) if (n.inWorkspace) ws.push(n);
      for (const [k, s] of this._knownStrays) {
        if (s.inWorkspace) ws.push(this._stray(k, s.folder).info);
      }
      ws.sort(byKey);
      for (const p of ws) for (const k of this._visibleOf(p).keys()) add(k);
      if (this._defaultReg.includeKey) add(this._defaultReg.includeKey);
      // A loose file brings its project and what that compiles with.
      const loose = new Map<string, ProjectInfo>();
      for (const [k, folder] of this._looseFolders) {
        const p = this._nodes.get(k) ?? this._stray(k, folder).info;
        if (!p.inWorkspace && !ext.has(k)) loose.set(k, p);
      }
      for (const p of loose.values()) {
        for (const k of this._visibleOf(p).keys()) if (!loose.has(k)) add(k);
      }
      this._scope = {
        ext: new Map([...ext].sort(([a], [b]) => cmp(a, b))),
        ws,
        loose,
      };
    }
    return this._scope;
  }

  /** The unit resolved all its include rows and each of its projects is
   *  indexed whole: in the workspace (no .ci hidden by excludePatterns),
   *  external or loose. `p` is the asking file's project. */
  private _unitKnown(u: Unit, p: ProjectInfo): boolean {
    if (!u.complete) return false;
    const memo = `${u.rootKey}|${p.key}`;
    let known = this._known.get(memo);
    if (known === undefined) {
      const { ext, loose } = this._scopeOf();
      known = u.projects.every(
        (k) =>
          ext.has(k) ||
          loose.has(k) ||
          (!this._partial.has(k) &&
            !!(this._nodes.get(k) ?? (k === p.key ? p : undefined))
              ?.inWorkspace),
      );
      this._known.set(memo, known);
    }
    return known;
  }

  private _regOf(p: ProjectInfo): Registry {
    return (
      this._nodes.get(p.key)?.reg ??
      this._knownStrays.get(p.key)?.reg ??
      this._regAbove(p.folder)
    );
  }

  /** The loaded registry whose User folder holds `folder`, else the
   *  default one. */
  private _regAbove(folder: string): Registry {
    const key = folder ? projectKey(folder) : "";
    let best = this._defaultReg;
    let len = -1;
    for (const r of this._registries) {
      if (!r.userDir) continue;
      const u = projectKey(r.userDir);
      if ((key === u || key.startsWith(u + path.sep)) && u.length > len) {
        best = r;
        len = u.length;
      }
    }
    return best;
  }

  private _unitsOfKey(p: ProjectInfo): readonly Unit[] {
    if (p.stray) return [this._stray(p.key, p.folder).unit];
    let units = this._unitsOf.get(p.key);
    if (!units) {
      units = this._units.filter((u) => u.index.has(p.key));
      if (!units.length) {
        // System or Include alone: compiled with nothing else.
        const reg = this._regOf(p);
        const keys = [reg.systemKey, reg.includeKey, p.key].filter(
          (k, i, a): k is string => !!k && a.indexOf(k) === i,
        );
        units = [new Unit(p.name, p.key, keys, reg.includeOk)];
      }
      this._unitsOf.set(p.key, units);
    }
    return units;
  }

  private _visibleOf(p: ProjectInfo): ReadonlyMap<string, number> {
    let vis = this._visible.get(p.key);
    if (!vis) {
      const m = new Map<string, number>([[p.key, 0]]);
      for (const u of this._unitsOfKey(p)) {
        for (const k of u.projects) if (!m.has(k)) m.set(k, m.size);
      }
      this._visible.set(p.key, (vis = m));
    }
    return vis;
  }

  private _stray(key: string, folder: string): Stray {
    let s = this._strays.get(key);
    if (!s) {
      const known = this._knownStrays.get(key);
      const info: ProjectInfo = {
        key,
        folder,
        name: folder ? path.basename(folder) : "",
        inWorkspace:
          known?.inWorkspace ??
          (!!key &&
            this._wsFolders.some(
              (w) => key === w || key.startsWith(w + path.sep),
            )),
        stray: true,
        overlayOf: known
          ? known.overlayOf
          : key
            ? this._homeOf(key)
            : undefined,
      };
      const reg = this._regOf(info);
      let rows: Rows | undefined = known;
      if (!rows) {
        // A folder first seen now: read its rows once.
        rows = { edges: [], unresolved: [], partial: false };
        if (folder && path.isAbsolute(folder)) {
          readRows(reg, this._nodes, key, folder, rows);
        }
      }
      let unit = buildUnit(reg, this._nodes, info, rows);
      if (info.overlayOf) unit = this._overlayUnit(info, info.overlayOf, unit);
      this._strays.set(key, (s = { info, rows, unit }));
    }
    return s;
  }

  /** The project folder above the folder keyed `key` (registered, or a
   *  workspace project not inside another), which it is an overlay of. */
  private _homeOf(key: string): string | undefined {
    this._userDirs ??= new Set(this.userFolders.map(projectKey));
    return homeAbove(
      key,
      (d) =>
        !this._userDirs!.has(d) &&
        (this._nodes.has(d) ||
          (this._knownStrays.has(d) && !this._knownStrays.get(d)!.overlayOf)),
    );
  }

  /** An overlay sees its home project's names, its own before them, then
   *  those of its own include rows. Never compiled: incomplete. */
  private _overlayUnit(info: ProjectInfo, home: string, own: Unit): Unit {
    const h =
      this._nodes.get(home) ??
      this._stray(home, this._knownStrays.get(home)?.folder ?? home).info;
    const keys = [...this._visibleOf(h).keys()];
    const seen = new Set(keys);
    for (const k of own.projects) if (!seen.has(k)) keys.push(k);
    return new Unit(info.name, info.key, keys, false);
  }
}

/** Resolve one include row of project `self` into `edges` / `unresolved`. */
function resolveRow(
  reg: Registry,
  nodes: ReadonlyMap<string, Node>,
  self: string,
  name: string,
  edges: string[],
  unresolved: string[],
): void {
  if (!name) {
    unresolved.push(""); // blank row: E2008 + F4016
    return;
  }
  const nk = nameKey(name);
  if (nk === "include" || nk === "system") return; // always compiled
  const to = reg.names.get(nk);
  if (!to || !nodes.has(to) || to === self) {
    unresolved.push(name); // F4016, or F4017 for a self include
    return;
  }
  // Found by folder name only: still looked up, but F4016 for the compiler.
  if (reg.unregistered.has(nk)) unresolved.push(name);
  if (!edges.includes(to)) edges.push(to);
}

/** The unit compiling `root`: System, Include, its includes depth-first
 *  post-order (each once, first occurrence wins), the root. */
function buildUnit(
  reg: Registry,
  nodes: ReadonlyMap<string, Node>,
  root: ProjectInfo,
  rootRows: Rows,
): Unit {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const k of [reg.systemKey, reg.includeKey]) {
    if (k && !seen.has(k)) {
      seen.add(k);
      order.push(k);
    }
  }
  let complete =
    reg.includeOk && !rootRows.unresolved.length && !rootRows.partial;
  const onStack = new Set<string>([root.key]);
  const visit = (edges: readonly string[]) => {
    for (const e of edges) {
      if (onStack.has(e)) {
        complete = false; // circular reference: F4017
        continue;
      }
      if (seen.has(e)) continue;
      const n = nodes.get(e)!;
      seen.add(e);
      onStack.add(e);
      if (n.unresolved.length || n.partial) complete = false;
      visit(n.edges);
      onStack.delete(e);
      order.push(e);
    }
  };
  seen.add(root.key);
  visit(rootRows.edges);
  order.push(root.key);
  return new Unit(root.name, root.key, order, complete);
}

interface MasterRow {
  readonly name: string;
  readonly nk: string;
  readonly folder: string;
  readonly key: string;
}

/** Live MASTER.DBF rows, the first per name; undefined when unreadable
 *  (or gone: the folder was picked for holding one). */
function readMaster(userDir: string): MasterRow[] | undefined {
  const f = findFileInDir(userDir, "MASTER.DBF");
  const rows = f ? readDbfStrict(f) : undefined;
  if (!rows) return undefined;
  const out: MasterRow[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const name = (r["NAME"] ?? "").trim();
    const nk = nameKey(name);
    if (!name || seen.has(nk)) continue;
    seen.add(nk);
    const raw = (r["PATH"] ?? "").trim().replace(/[\\/]+$/, "");
    const folder = path.resolve(userDir, raw || name);
    out.push({ name, nk, folder, key: projectKey(folder) });
  }
  return out;
}

/** The Include folder the includeProjectPath setting names (the folder, or
 *  the folder of its labels.DBF). */
function includeOverride(setting: string | undefined): string | undefined {
  const p = setting?.trim();
  if (!p) return undefined;
  const dir = /\.dbf$/i.test(p)
    ? path.dirname(path.resolve(p))
    : path.resolve(p);
  return isDir(dir) ? dir : undefined;
}

/** Folders by key, sorted (workspace.findFiles order is not stable, so
 *  names, clones and the signature would not be); one spelling per key. */
function sortedFolders(list: readonly string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of [...list].sort(cmp)) {
    const key = projectKey(f);
    if (!out.has(key)) out.set(key, f);
  }
  return new Map([...out].sort(([a], [b]) => cmp(a, b)));
}

/**
 * Build the project graph. For each workspace folder one MASTER.DBF is
 * used, never merged with another install's: the one above the
 * includeProjectPath folder, else the nearest at or above the workspace
 * folder, else under avevaPath or an installed version (one registering the
 * folder first). Workspace project folders win a name over the registered
 * folder elsewhere (a clone), the registered folder wins over a workspace
 * folder that only shares its name. An unregistered folder inside a
 * project's folder is an overlay of that project (never compiled).
 */
export function buildProjectGraph(input: GraphInput): GraphBuild {
  let ok = true;
  let mastersOk = true;
  const override = includeOverride(input.includeProjectPath);

  const masters = new Map<string, MasterRow[]>();
  const unreadable = new Set<string>();
  const master = (userDir: string): MasterRow[] => {
    const k = projectKey(userDir);
    let rows = masters.get(k);
    if (!rows) {
      rows = readMaster(userDir);
      if (!rows) unreadable.add(k);
      masters.set(k, (rows ??= []));
    }
    return rows;
  };
  let candidates: string[] | undefined;
  const pickUserDir = (folder?: string): string | undefined => {
    const above =
      (override && userDirsAbove(override, 1)[0]) ||
      (folder && userDirsAbove(folder, 1)[0]);
    if (above) return above;
    candidates ??= candidateUserDirs([], input.avevaPath).filter(
      (d) => !!findFileInDir(d, "MASTER.DBF"),
    );
    if (folder) {
      const k = projectKey(folder);
      const hit = candidates.find((d) =>
        master(d).some(
          (r) =>
            r.key === k ||
            r.key.startsWith(k + path.sep) ||
            k.startsWith(r.key + path.sep),
        ),
      );
      if (hit) return hit;
    }
    return candidates[0];
  };

  const registries = new Map<string, Registry>();
  const registry = (userDir: string | undefined): Registry => {
    const k = userDir ? projectKey(userDir) : "";
    let r = registries.get(k);
    if (!r) {
      r = {
        userDir,
        names: new Map(),
        unregistered: new Set(),
        includeOk: false,
      };
      registries.set(k, r);
    }
    return r;
  };

  const wsKeys = input.workspaceFolders.map(projectKey);
  const wsRegs = input.workspaceFolders.map((w) => registry(pickUserDir(w)));
  const defaultReg = wsRegs[0] ?? registry(pickUserDir());
  const underWs = (key: string) =>
    wsKeys.some((w) => key === w || key.startsWith(w + path.sep));
  /** The registry of a folder: its workspace folder's, else the nearest. */
  const regFor = (key: string, folder: string): Registry => {
    let reg: Registry | undefined;
    let len = -1;
    wsKeys.forEach((w, i) => {
      if ((key === w || key.startsWith(w + path.sep)) && w.length > len) {
        reg = wsRegs[i];
        len = w.length;
      }
    });
    return reg ?? registry(pickUserDir(folder));
  };

  // Workspace project folders, by the registry of their workspace folder.
  const wsByReg = new Map<Registry, Array<{ key: string; folder: string }>>();
  const seenWs = new Set<string>();
  for (const [key, folder] of sortedFolders(input.sourceFolders)) {
    seenWs.add(key);
    const reg = regFor(key, folder);
    let list = wsByReg.get(reg);
    if (!list) wsByReg.set(reg, (list = []));
    list.push({ key, folder });
  }
  // Folders of loose files, with their registries.
  const loose = [...sortedFolders(input.looseFolders)].map(([key, folder]) => ({
    key,
    folder,
    reg: regFor(key, folder),
  }));

  const nodes = new Map<string, Node>();
  const strays = new Map<string, KnownStray>();
  const addStray = (
    reg: Registry,
    key: string,
    folder: string,
    inWorkspace: boolean,
    overlayOf?: string,
  ) => {
    strays.set(key, {
      reg,
      folder,
      inWorkspace,
      overlayOf,
      edges: [],
      unresolved: [],
      partial: false,
    });
  };
  const userDirs = new Set(
    [...registries.values()].flatMap((r) =>
      r.userDir ? [projectKey(r.userDir)] : [],
    ),
  );
  // Workspace folders by the names their include rows give, for projects
  // nested in another's folder that MASTER.DBF does not register.
  const namedBy = new Map<string, Set<string>>();
  for (const f of input.sourceFolders) {
    for (const n of includeRows(f, false).names) {
      const nk = nameKey(n);
      if (!namedBy.has(nk)) namedBy.set(nk, new Set());
      namedBy.get(nk)!.add(projectKey(f));
    }
  }
  const wanted = (nk: string, self: string) =>
    [...(namedBy.get(nk) ?? [])].some((k) => k !== self);
  const addNode = (
    reg: Registry,
    key: string,
    folder: string,
    name: string,
    inWorkspace: boolean,
  ) => {
    if (!nodes.has(key)) {
      nodes.set(key, {
        key,
        folder,
        name,
        inWorkspace,
        stray: false,
        reg,
        edges: [],
        unresolved: [],
        partial: false,
      });
    }
  };

  for (const reg of registries.values()) {
    const rows = reg.userDir ? master(reg.userDir) : [];
    if (reg.userDir && unreadable.has(projectKey(reg.userDir))) {
      ok = mastersOk = false;
    }
    const ws = wsByReg.get(reg) ?? [];
    const wsFolder = new Map(ws.map((w) => [w.key, w.folder]));
    const rowKeys = new Set(rows.map((r) => r.key));
    const rowNames = new Set(rows.map((r) => r.nk));
    const exists = new Map(
      rows.map((r) => [r.key, wsFolder.has(r.key) || isDir(r.folder)]),
    );
    const overrideKey = override && projectKey(override);
    // Project folders: registered ones, then workspace folders inside none
    // of them (parents sort first). An unregistered folder inside one is an
    // overlay of it (a backup or scratch copy the compiler never reads),
    // unless a workspace include row names it and MASTER.DBF does not.
    const homes = new Set(
      rows.filter((r) => exists.get(r.key)).map((r) => r.key),
    );
    if (overrideKey) homes.add(overrideKey);
    const top: Array<{ key: string; folder: string }> = [];
    for (const w of ws) {
      if (rowKeys.has(w.key) || w.key === overrideKey) continue;
      const nk = nameKey(path.basename(w.folder));
      const home = homeAbove(w.key, (d) => homes.has(d));
      if (home && (rowNames.has(nk) || !wanted(nk, w.key))) {
        addStray(reg, w.key, w.folder, true, home);
        continue;
      }
      top.push(w);
      if (!userDirs.has(w.key)) homes.add(w.key);
    }
    // Other unregistered workspace folders stand in for the registered
    // project of their folder name (a clone), the shallowest first.
    const clones = new Map<string, { key: string; folder: string }>();
    for (const w of [...top].sort(
      (a, b) => depth(a.key) - depth(b.key) || cmp(a.key, b.key),
    )) {
      const nk = nameKey(path.basename(w.folder));
      if (!clones.has(nk)) clones.set(nk, w);
    }
    if (override) {
      // The setting names Include's folder, over MASTER.DBF's.
      const k = projectKey(override);
      const reged = rows.find((r) => r.key === k);
      addNode(reg, k, override, reged?.name ?? "Include", seenWs.has(k));
      reg.names.set("include", k);
    }
    for (const r of rows) {
      if (reg.names.has(r.nk)) continue;
      const clone = wsFolder.has(r.key) ? undefined : clones.get(r.nk);
      if (clone) {
        reg.names.set(r.nk, clone.key);
        addNode(reg, clone.key, clone.folder, r.name, true);
      } else if (exists.get(r.key)) {
        reg.names.set(r.nk, r.key);
        const inWs = wsFolder.has(r.key);
        addNode(reg, r.key, wsFolder.get(r.key) ?? r.folder, r.name, inWs);
      }
    }
    const userKey = reg.userDir && projectKey(reg.userDir);
    for (const w of top) {
      if (nodes.has(w.key)) continue;
      const name = path.basename(w.folder);
      const nk = nameKey(name);
      if (reg.names.has(nk)) {
        addStray(reg, w.key, w.folder, true); // name taken
      } else {
        reg.names.set(nk, w.key);
        addNode(reg, w.key, w.folder, name, true);
        // A project folder of this User folder MASTER.DBF does not list.
        if (userKey && w.key.startsWith(userKey + path.sep)) {
          reg.unregistered.add(nk);
        }
      }
    }

    reg.includeKey = reg.names.get("include");
    if (!reg.includeKey && !reg.userDir) {
      // No MASTER.DBF: an Include folder in a User folder nearby.
      for (const u of candidateUserDirs(
        input.workspaceFolders,
        input.avevaPath,
      )) {
        const dir = path.join(u, "Include");
        if (isDir(dir) && hasSources(dir)) {
          reg.includeKey = projectKey(dir);
          addNode(reg, reg.includeKey, dir, "Include", false);
          break;
        }
      }
    }
    reg.systemKey = reg.names.get("system");
    const inc = reg.includeKey && nodes.get(reg.includeKey);
    reg.includeOk = !!inc && hasSources(inc.folder);
  }
  // A loose folder inside a project's folder is an overlay of it.
  const isHome = (d: string) =>
    !userDirs.has(d) &&
    (nodes.has(d) || (strays.has(d) && !strays.get(d)!.overlayOf));
  for (const l of loose) {
    if (!nodes.has(l.key) && !strays.has(l.key)) {
      const home = homeAbove(l.key, isHome);
      addStray(l.reg, l.key, l.folder, underWs(l.key), home);
    }
  }

  // Include rows. Include's and System's own are never read.
  for (const n of nodes.values()) {
    if (n.key === n.reg.includeKey || n.key === n.reg.systemKey) continue;
    if (!readRows(n.reg, nodes, n.key, n.folder, n)) ok = false;
  }
  for (const [k, s] of strays) {
    if (!readRows(s.reg, nodes, k, s.folder, s)) ok = false;
  }

  // Roots: no in-edge; then one per cycle nothing else reaches.
  const special = (n: Node) =>
    n.key === n.reg.includeKey || n.key === n.reg.systemKey;
  const included = new Set<string>();
  for (const n of nodes.values()) n.edges.forEach((e) => included.add(e));
  const roots: Node[] = [];
  const units: Unit[] = [];
  const covered = new Set<string>();
  const addRoot = (n: Node) => {
    const u = buildUnit(n.reg, nodes, n, n);
    roots.push(n);
    units.push(u);
    u.projects.forEach((k) => covered.add(k));
  };
  for (const n of nodes.values()) {
    if (!special(n) && !included.has(n.key)) addRoot(n);
  }
  for (const n of nodes.values()) {
    if (!special(n) && !covered.has(n.key)) addRoot(n);
  }

  return {
    graph: new ProjectGraph(
      nodes,
      [...registries.values()],
      defaultReg,
      units,
      roots,
      wsKeys,
      strays,
      new Map(loose.map((l) => [l.key, l.folder])),
      new Set((input.partialFolders ?? []).map(projectKey)),
    ),
    ok,
    mastersOk,
  };
}
