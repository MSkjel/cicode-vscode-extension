import * as vscode from "vscode";
import { debounce } from "../../shared/utils";
import {
  TYPE_RE,
  splitDeclNames,
  buildIgnoreSpans,
  inSpan,
  extractLeadingTripleSlashDoc,
  parseXmlDocLines,
} from "../../shared/textUtils";
import { getBuiltins } from "../builtins/builtins";
import type { FunctionInfo, VariableEntry } from "../../shared/types";
import type { FunctionRange } from "./types";

export class Indexer {
  private readonly functionCache = new Map<string, FunctionInfo>();
  readonly variableCache = new Map<string, VariableEntry[]>();
  private readonly functionRangesByFile = new Map<string, FunctionRange[]>();

  private readonly _onIndexed = new vscode.EventEmitter<void>();
  readonly onIndexed = this._onIndexed.event;

  private readonly _debouncedIndex: (doc: vscode.TextDocument) => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly cfg: () => vscode.WorkspaceConfiguration,
  ) {
    this._debouncedIndex = debounce((doc) => this._indexFile(doc), 300);

    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((d) => this._maybeIndex(d)),
      vscode.workspace.onDidOpenTextDocument((d) => this._maybeIndex(d)),
      vscode.workspace.onDidChangeTextDocument((e) =>
        this._maybeIndex(e.document),
      ),
      vscode.workspace.onDidDeleteFiles((e) =>
        e.files.forEach((f) => this._purgeFile(f.fsPath)),
      ),
      vscode.workspace.onDidRenameFiles((e) =>
        e.files.forEach(({ oldUri, newUri }) =>
          this._moveFile(oldUri.fsPath, newUri.fsPath),
        ),
      ),
    );
  }

  async buildAll(): Promise<void> {
    this.functionCache.clear();
    this.variableCache.clear();
    this.functionRangesByFile.clear();

    for (const [k, v] of getBuiltins())
      this.functionCache.set(k, {
        ...v,
        location: null,
        file: null,
        bodyRange: null,
      });

    const ex = this.cfg().get("cicode.indexing.excludeGlobs");
    let exclude: string | undefined;
    if (Array.isArray(ex) && ex.length) exclude = `{${ex.join(",")}}`;
    else if (typeof ex === "string" && ex.trim()) exclude = ex.trim();

    const files = await vscode.workspace.findFiles("**/*.ci", exclude);
    for (const file of files) {
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        await this._indexFile(doc);
      } catch (e) {
        console.error("index fail", file.fsPath, e);
      }
    }
    this._onIndexed.fire();
  }

  private _maybeIndex(doc: vscode.TextDocument): void {
    if (!doc || !doc.uri.fsPath.toLowerCase().endsWith(".ci")) return;
    this._debouncedIndex(doc);
  }

  private _purgeFile(file: string): void {
    for (const [k, v] of this.functionCache)
      if (v && v.file === file) this.functionCache.delete(k);
    for (const [k, arr] of this.variableCache) {
      const filtered = arr.filter((e) => e.file !== file);
      if (filtered.length) this.variableCache.set(k, filtered);
      else this.variableCache.delete(k);
    }
    this.functionRangesByFile.delete(file);
    this._onIndexed.fire();
  }

  private _moveFile(oldPath: string, newPath: string): void {
    for (const [, v] of this.functionCache) {
      if (v && v.file === oldPath) (v as any).file = newPath;
    }
    for (const [, arr] of this.variableCache) {
      arr.forEach((e) => {
        if (e.file === oldPath) (e as any).file = newPath;
      });
    }
    if (this.functionRangesByFile.has(oldPath)) {
      this.functionRangesByFile.set(
        newPath,
        this.functionRangesByFile.get(oldPath)!,
      );
      this.functionRangesByFile.delete(oldPath);
    }
    this._onIndexed.fire();
  }

  localScopeId(file: string, funcName: string) {
    return `local:${file}::${funcName}`;
  }

  private async _indexFile(doc: vscode.TextDocument): Promise<void> {
    const file = doc.uri.fsPath;
    this._purgeFile(file);

    const text = doc.getText();
    const functions = this._extractFunctionsWithRanges(text, doc);
    this.functionRangesByFile.set(file, functions);

    for (const f of functions as any[]) {
      const key = f.name.toLowerCase();
      const params = f.paramsRaw
        .split(",")
        .map((p: string) => p.trim())
        .filter(Boolean);
      this.functionCache.set(key, {
        name: f.name,
        returnType: f.returnType || "VOID",
        params,
        location: f.location,
        doc: f.docText || "",
        returns: f.returnsDoc,
        paramDocs: f.paramDocs,
        file,
        bodyRange: f.bodyRange,
      });

      for (const v of this._parseParamVariables(params)) {
        this._addVar(v.name, {
          name: v.name,
          type: v.type,
          scopeType: "local",
          scopeId: this.localScopeId(file, f.name),
          location: new vscode.Location(doc.uri, f.location.range.start),
          file,
          range: f.bodyRange,
          isParam: true,
        });
      }
    }

    this._indexVariablesInText(doc, text, functions);
    this._onIndexed.fire();
  }

  private _addVar(name: string, entry: VariableEntry) {
    const k = name.toLowerCase();
    if (!this.variableCache.has(k)) this.variableCache.set(k, []);
    this.variableCache.get(k)!.push(entry);
  }

  private _extractFunctionsWithRanges(
    text: string,
    doc: vscode.TextDocument,
  ): FunctionRange[] {
    const ignoreCS = buildIgnoreSpans(text, { includeFunctionHeaders: false });

    const funcKeywordRe = /\bfunction\b/gim;
    const headers: Array<{
      returnType: string;
      name: string;
      paramsRaw: string;
      headerIndex: number;
      headerPos: vscode.Position;
      location: vscode.Location;
      docText?: string;
      paramDocs?: Record<string, string>;
      returnsDoc?: string;
    }> = [];

    let m: RegExpExecArray | null;
    while ((m = funcKeywordRe.exec(text))) {
      if (inSpan(m.index, ignoreCS)) continue;

      const funcKeywordPos = m.index + m[0].length;

      const sameLine = /^\s*(\w+)\s*\(([^)]*)\)/i.exec(
        text.slice(funcKeywordPos),
      );

      let name: string;
      let paramsRaw: string;
      let nameOffset: number;
      let headerEndPos: number; // Track where header actually ends

      if (sameLine) {
        name = sameLine[1];
        paramsRaw = sameLine[2] || "";
        nameOffset =
          funcKeywordPos + sameLine.index + sameLine[0].indexOf(name);
        headerEndPos = funcKeywordPos + sameLine.index + sameLine[0].length;
      } else {
        const afterFunc = text.slice(funcKeywordPos);
        const nextLine = /^\s*\r?\n\s*(\w+)\s*\(([^)]*)\)/i.exec(afterFunc);
        if (!nextLine) continue;

        name = nextLine[1];
        paramsRaw = nextLine[2] || "";
        nameOffset =
          funcKeywordPos + nextLine.index + nextLine[0].indexOf(name);
        headerEndPos = funcKeywordPos + nextLine.index + nextLine[0].length;
      }

      const beforeFunc = text.slice(0, m.index);
      const beforeLines = beforeFunc.split(/\r?\n/);
      const tokens: string[] = [];

      for (
        let i = beforeLines.length - 1;
        i >= Math.max(0, beforeLines.length - 10);
        i--
      ) {
        const lineTokens = beforeLines[i].trim().split(/\s+/).filter(Boolean);
        tokens.unshift(...lineTokens);

        if (/[;{}]|end\b/i.test(beforeLines[i])) break;
      }

      let returnType = "VOID";
      for (let i = tokens.length - 1; i >= 0; i--) {
        const tok = tokens[i].toUpperCase();
        if (TYPE_RE.test(tok)) {
          returnType = tok;
          break;
        }
      }

      let headerStart = m.index;
      for (
        let i = beforeLines.length - 1;
        i >= Math.max(0, beforeLines.length - 10);
        i--
      ) {
        const line = beforeLines[i].trim();
        if (!line || /^\/\//.test(line)) continue;
        const hasModOrType =
          /^(private|public|global|module|const|static|boolean|bool|int|real|long|ulong|string|object|quality|timestamp|void)\b/i.test(
            line,
          );
        if (hasModOrType) {
          headerStart = text.lastIndexOf(line, m.index);
          break;
        }
      }

      const startPos = doc.positionAt(nameOffset);
      const headerPos = doc.positionAt(headerStart);
      const loc = new vscode.Location(doc.uri, startPos);

      let docText: string | undefined;
      let paramDocs: Record<string, string> | undefined;
      let returnsDoc: string | undefined;

      const lines = extractLeadingTripleSlashDoc(text, headerStart);
      if (lines.length) {
        const parsed = parseXmlDocLines(lines);
        docText = parsed.summary || undefined;
        returnsDoc = parsed.returns || undefined;
        if (Object.keys(parsed.paramDocs).length) paramDocs = parsed.paramDocs;
      }

      headers.push({
        name,
        returnType,
        paramsRaw,
        headerIndex: headerStart,
        headerPos,
        location: loc,
        docText,
        paramDocs,
        returnsDoc,
        headerEndPos, // Store this for body calculation
      } as any);
    }

    // Find matching END for each function
    const out: FunctionRange[] = [];
    for (const h of headers as any[]) {
      // Body starts right after the ) character
      const bodyStart = h.headerEndPos;

      let depth = 1;
      const tokenRe = /\b(function|if|for|while|repeat|try|select|end)\b/gi;
      tokenRe.lastIndex = bodyStart;

      let endPos = text.length;
      let match: RegExpExecArray | null;

      while ((match = tokenRe.exec(text))) {
        if (inSpan(match.index, ignoreCS)) continue;

        const kw = match[0].toLowerCase();
        if (kw === "end") {
          depth--;
          if (depth === 0) {
            endPos = match.index + match[0].length;
            break;
          }
        } else {
          depth++;
        }
      }

      out.push({
        ...h,
        startOffset: h.headerIndex,
        endOffset: endPos,
        bodyRange: new vscode.Range(
          doc.positionAt(bodyStart),
          doc.positionAt(endPos),
        ),
      } as unknown as FunctionRange);
    }

    return out;
  }
  private _parseParamVariables(
    params: string[],
  ): Array<{ type: string; name: string }> {
    const out: Array<{ type: string; name: string }> = [];
    for (const raw of params) {
      const m = raw.match(/^\s*(\w+)\s+(\w+)\s*$/);
      if (m) out.push({ type: m[1].toUpperCase(), name: m[2] });
      else {
        const n = raw.trim();
        if (n) out.push({ type: "UNKNOWN", name: n });
      }
    }
    return out;
  }

  private _indexVariablesInText(
    doc: vscode.TextDocument,
    text: string,
    functions: FunctionRange[],
  ): void {
    const file = doc.uri.fsPath;
    const intervals = functions.map((f) => ({
      start: doc.offsetAt(f.bodyRange.start),
      end: doc.offsetAt(f.bodyRange.end),
      func: f,
    }));

    const scanDeclsInSlice = (
      sliceText: string,
      baseOffset: number,
      scopeKind: "local" | "module",
      funcCtx: FunctionRange | null,
    ) => {
      const ignore = buildIgnoreSpans(sliceText);
      const declRe = /^\s*(?:(GLOBAL|MODULE)\s+)?(\w+)\s+([^\r\n;]+)\s*;?/gim;
      let m: RegExpExecArray | null;
      while ((m = declRe.exec(sliceText))) {
        const kw = (m[1] || "").toUpperCase();
        const typeRaw = m[2];
        if (!TYPE_RE.test(typeRaw)) continue;
        const anchor = m.index;
        if (inSpan(anchor, ignore)) continue;

        const type = typeRaw.toUpperCase();
        const namesPart = m[3];
        const names = splitDeclNames(namesPart);
        const namesRelStart = m.index + m[0].indexOf(namesPart);

        for (const name of names) {
          const nameRel = namesRelStart + Math.max(0, namesPart.indexOf(name));
          const abs = baseOffset + nameRel;
          const pos = doc.positionAt(abs);
          const loc = new vscode.Location(doc.uri, pos);

          const isGlobalKw = kw === "GLOBAL";
          const isModuleKw = kw === "MODULE";

          if (scopeKind === "local") {
            // Inside a function
            if (isGlobalKw) {
              this._addVar(name, {
                name,
                type,
                scopeType: "global",
                scopeId: "global",
                location: loc,
                file,
                range: null,
                isParam: false,
              });
            } else {
              // Everything else is local
              this._addVar(name, {
                name,
                type,
                scopeType: "local",
                scopeId: this.localScopeId(file, funcCtx!.name),
                location: loc,
                file,
                range: funcCtx!.bodyRange,
                isParam: false,
              });
            }
          } else {
            // Module-level code
            if (isGlobalKw) {
              this._addVar(name, {
                name,
                type,
                scopeType: "global",
                scopeId: "global",
                location: loc,
                file,
                range: null,
                isParam: false,
              });
            } else {
              this._addVar(name, {
                name,
                type,
                scopeType: "module",
                scopeId: file,
                location: loc,
                file,
                range: null,
                isParam: false,
              });
            }
          }
        }
      }
    };

    for (const f of functions) {
      const base = doc.offsetAt(f.bodyRange.start);
      const slice = text.slice(base, doc.offsetAt(f.bodyRange.end));
      scanDeclsInSlice(slice, base, "local", f);
    }

    const nonFuncRegions: Array<[number, number]> = [];
    let cursor = 0;
    for (const it of intervals.sort((a, b) => a.start - b.start)) {
      if (cursor < it.start) nonFuncRegions.push([cursor, it.start]);
      cursor = Math.max(cursor, it.end);
    }
    if (cursor < text.length) nonFuncRegions.push([cursor, text.length]);

    for (const [start, end] of nonFuncRegions) {
      const slice = text.slice(start, end);
      scanDeclsInSlice(slice, start, "module", null);
    }
  }

  getFunction(name: string) {
    return this.functionCache.get(name.toLowerCase());
  }
  hasFunction(name: string) {
    return this.functionCache.has(name.toLowerCase());
  }
  getAllFunctions() {
    return this.functionCache;
  }
  getVariables(name: string) {
    return this.variableCache.get(name.toLowerCase()) || [];
  }
  getAllVariableEntries(): ReadonlyArray<VariableEntry> {
    const out: VariableEntry[] = [];
    for (const [, arr] of this.variableCache) out.push(...arr);
    return out;
  }
  getVariablesByPredicate(
    pred: (v: VariableEntry) => boolean,
  ): VariableEntry[] {
    const out: VariableEntry[] = [];
    for (const [, arr] of this.variableCache)
      for (const v of arr) if (pred(v)) out.push(v);
    return out;
  }
  getTotalVariableCount(): number {
    let n = 0;
    for (const [, arr] of this.variableCache) n += arr.length;
    return n;
  }
  getVariablesInFile(file: string) {
    const out: VariableEntry[] = [];
    for (const [, arr] of this.variableCache)
      for (const v of arr) if (v.file === file) out.push(v);
    return out;
  }
  getFunctionRanges(file: string) {
    return this.functionRangesByFile.get(file) || [];
  }
  resolveVariableAt(
    document: vscode.TextDocument,
    position: vscode.Position,
    name: string,
  ) {
    const file = document.uri.fsPath;
    const lc = name.toLowerCase();
    const candidates = this.variableCache.get(lc);
    if (!candidates?.length) return null;
    const encl = this.findEnclosingFunction(document, position);
    if (encl) {
      const sid = this.localScopeId(file, encl.name);
      const local = candidates.find(
        (v) => v.scopeType === "local" && v.scopeId === sid,
      );
      if (local) return local;
    }
    const mod = candidates.find(
      (v) => v.scopeType === "module" && v.scopeId === file,
    );
    if (mod) return mod;
    const glob = candidates.find((v) => v.scopeType === "global");
    if (glob) return glob;
    return candidates[0] || null;
  }
  findEnclosingFunction(
    document: vscode.TextDocument,
    position: vscode.Position,
  ) {
    const file = document.uri.fsPath;
    const list = this.getFunctionRanges(file);
    if (!list) return null;
    const off = document.offsetAt(position);
    for (const f of list) {
      const s = document.offsetAt(f.bodyRange.start),
        e = document.offsetAt(f.bodyRange.end);
      if (off >= s && off < e) return f;
    }
    return null;
  }
}
