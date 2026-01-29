import * as vscode from "vscode";
import { debounce } from "../../shared/utils";
import {
  TYPE_RE,
  splitDeclNames,
  buildIgnoreSpans,
  inSpan,
  extractLeadingTripleSlashDoc,
  extractSlashDoubleStarDoc,
  parseXmlDocLines,
} from "../../shared/textUtils";
import { getBuiltins } from "../builtins/builtins";
import type { FunctionInfo, VariableEntry } from "../../shared/types";
import type { FunctionRange } from "./types";

/**
 * Indexes Cicode files to extract function definitions, variable declarations,
 * and their locations for use by other language features.
 */
export class Indexer {
  private readonly functionCache = new Map<string, FunctionInfo>();
  readonly variableCache = new Map<string, VariableEntry[]>();
  private readonly functionRangesByFile = new Map<string, FunctionRange[]>();
  private readonly _ignoreSpansByFile = new Map<
    string,
    Array<[number, number]>
  >();

  // Reverse indexes for O(1) file purge instead of O(n) iteration
  private readonly _functionKeysByFile = new Map<string, Set<string>>();
  private readonly _variableKeysByFile = new Map<string, Set<string>>();

  private readonly _onIndexed = new vscode.EventEmitter<string | undefined>();
  /** Fires after indexing completes. Carries the file path for single-file reindex, undefined for full rebuild. */
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

  /** Build index for all .ci files in the workspace */
  async buildAll(): Promise<void> {
    this.functionCache.clear();
    this.variableCache.clear();
    this.functionRangesByFile.clear();

    // Load builtin functions first
    for (const [k, v] of getBuiltins()) {
      this.functionCache.set(k, {
        ...v,
        location: null,
        file: null,
        bodyRange: null,
      });
    }

    // Find and index all .ci files
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
    this._onIndexed.fire(undefined);
  }

  private _maybeIndex(doc: vscode.TextDocument): void {
    if (!doc || !doc.uri.fsPath.toLowerCase().endsWith(".ci")) return;
    this._debouncedIndex(doc);
  }

  private _purgeFile(file: string, fireEvent = true): void {
    // Use reverse index for O(functions_in_file) instead of O(all_functions)
    const funcKeys = this._functionKeysByFile.get(file);
    if (funcKeys) {
      for (const key of funcKeys) {
        this.functionCache.delete(key);
      }
      this._functionKeysByFile.delete(file);
    }

    // Use reverse index for O(variables_in_file) instead of O(all_variables)
    const varKeys = this._variableKeysByFile.get(file);
    if (varKeys) {
      for (const key of varKeys) {
        const arr = this.variableCache.get(key);
        if (arr) {
          const filtered = arr.filter((e) => e.file !== file);
          if (filtered.length) this.variableCache.set(key, filtered);
          else this.variableCache.delete(key);
        }
      }
      this._variableKeysByFile.delete(file);
    }

    this.functionRangesByFile.delete(file);
    this._ignoreSpansByFile.delete(file);
    if (fireEvent) this._onIndexed.fire(file);
  }

  private _moveFile(oldPath: string, newPath: string): void {
    // Update function cache entries
    for (const [key, v] of this.functionCache) {
      if (v && v.file === oldPath) {
        this.functionCache.set(key, { ...v, file: newPath });
      }
    }
    // Update variable cache entries
    for (const [key, arr] of this.variableCache) {
      const updated = arr.map((e) =>
        e.file === oldPath ? { ...e, file: newPath } : e,
      );
      this.variableCache.set(key, updated);
    }
    // Update function ranges by file
    if (this.functionRangesByFile.has(oldPath)) {
      this.functionRangesByFile.set(
        newPath,
        this.functionRangesByFile.get(oldPath)!,
      );
      this.functionRangesByFile.delete(oldPath);
    }
    // Update ignore spans by file
    if (this._ignoreSpansByFile.has(oldPath)) {
      this._ignoreSpansByFile.set(
        newPath,
        this._ignoreSpansByFile.get(oldPath)!,
      );
      this._ignoreSpansByFile.delete(oldPath);
    }
    // Update reverse indexes
    if (this._functionKeysByFile.has(oldPath)) {
      this._functionKeysByFile.set(
        newPath,
        this._functionKeysByFile.get(oldPath)!,
      );
      this._functionKeysByFile.delete(oldPath);
    }
    if (this._variableKeysByFile.has(oldPath)) {
      this._variableKeysByFile.set(
        newPath,
        this._variableKeysByFile.get(oldPath)!,
      );
      this._variableKeysByFile.delete(oldPath);
    }
    this._onIndexed.fire(newPath);
  }

  /** Generate unique scope ID for local variables */
  localScopeId(file: string, funcName: string) {
    return `local:${file}::${funcName}`;
  }

  private async _indexFile(doc: vscode.TextDocument): Promise<void> {
    const file = doc.uri.fsPath;
    this._purgeFile(file, false);

    const text = doc.getText();
    const ignoreSpans = buildIgnoreSpans(text, {
      includeFunctionHeaders: false,
    });
    this._ignoreSpansByFile.set(file, ignoreSpans);

    const functions = this._extractFunctionsWithRanges(text, doc, ignoreSpans);
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

      // Track in reverse index for efficient purge
      if (!this._functionKeysByFile.has(file)) {
        this._functionKeysByFile.set(file, new Set());
      }
      this._functionKeysByFile.get(file)!.add(key);

      // Register function parameters as local variables
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
    this._onIndexed.fire(file);
  }

  private _addVar(name: string, entry: VariableEntry) {
    const k = name.toLowerCase();
    if (!this.variableCache.has(k)) this.variableCache.set(k, []);
    this.variableCache.get(k)!.push(entry);

    // Track in reverse index for efficient purge
    if (!this._variableKeysByFile.has(entry.file)) {
      this._variableKeysByFile.set(entry.file, new Set());
    }
    this._variableKeysByFile.get(entry.file)!.add(k);
  }

  /**
   * Extract function definitions with their body ranges from source text.
   * Handles multi-line function signatures and various return type patterns.
   */
  private _extractFunctionsWithRanges(
    text: string,
    doc: vscode.TextDocument,
    ignoreCS: Array<[number, number]>,
  ): FunctionRange[] {
    const funcKeywordRe = /\bfunction\b/gi;
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
      headerEndPos: number;
    }> = [];

    let m: RegExpExecArray | null;
    while ((m = funcKeywordRe.exec(text))) {
      if (inSpan(m.index, ignoreCS)) continue;

      const funcKeywordPos = m.index + m[0].length;

      let name = "";
      let paramsRaw = "";
      let nameOffset = 0;
      let headerEndPos = 0;

      // Get text after FUNCTION keyword
      const afterFunc = text.slice(funcKeywordPos);

      // Skip any inline comment on the same line as FUNCTION keyword
      // Comments in Cicode: // or ! or |
      // We need to skip: optional whitespace, then optional comment to end of line
      const skipCommentMatch = /^[ \t]*((?:\/\/|!|\|)[^\r\n]*)?\r?\n?/i.exec(
        afterFunc,
      );
      const skipLen = skipCommentMatch ? skipCommentMatch[0].length : 0;
      const afterComment = afterFunc.slice(skipLen);
      const afterCommentPos = funcKeywordPos + skipLen;

      // Try to match function name and params
      const nameMatch = /^\s*(\w+)\s*\(([^)]*)\)/i.exec(afterComment);

      if (nameMatch && !nameMatch[2].includes("\n")) {
        // Simple case: name(params) all on one line (or what remains fits)
        name = nameMatch[1];
        paramsRaw = nameMatch[2] || "";
        nameOffset =
          afterCommentPos + nameMatch.index + nameMatch[0].indexOf(name);
        headerEndPos = afterCommentPos + nameMatch.index + nameMatch[0].length;
      } else {
        // Handle multi-line function signatures
        const nameOnlyMatch = /^\s*(\w+)\s*\(/i.exec(afterComment);
        if (!nameOnlyMatch) continue;

        name = nameOnlyMatch[1];
        nameOffset = afterCommentPos + afterComment.indexOf(name);

        // Find matching closing paren across multiple lines
        const openParenPos = afterCommentPos + nameOnlyMatch[0].length - 1;
        let depth = 1;
        let closeParenPos = -1;

        for (
          let i = openParenPos + 1;
          i < text.length && i < openParenPos + 5000;
          i++
        ) {
          const ch = text[i];
          if (ch === "(") depth++;
          else if (ch === ")") {
            depth--;
            if (depth === 0) {
              closeParenPos = i;
              break;
            }
          }
        }

        if (closeParenPos === -1) continue;

        paramsRaw = text.slice(openParenPos + 1, closeParenPos);
        headerEndPos = closeParenPos + 1;
      }

      // Extract return type from lines before FUNCTION keyword
      const beforeFunc = text.slice(0, m.index);
      const beforeLines = beforeFunc.split(/\r?\n/);
      let returnType = "VOID";

      // Check for type on same line: "INT FUNCTION foo()"
      const lastLine = beforeLines[beforeLines.length - 1] || "";
      const sameLineMatch =
        /\b(INT|REAL|STRING|OBJECT|BOOL|BOOLEAN|LONG|ULONG|VOID|QUALITY|TIMESTAMP)\s*$/i.exec(
          lastLine,
        );

      if (sameLineMatch) {
        returnType = sameLineMatch[1].toUpperCase();
      } else {
        // Scan upward (max 20 lines) for standalone type declaration
        for (
          let i = beforeLines.length - 1;
          i >= 0 && i >= beforeLines.length - 20;
          i--
        ) {
          const raw = beforeLines[i];
          const line = raw
            .replace(/\/\/.*$/, "")
            .replace(/!.*$/, "")
            .trim();

          if (!line) continue;

          // Stop at module declarations or code
          if (/^\s*MODULE\b/i.test(line)) break;
          if (line.endsWith(";")) break;
          if (/\b(END|IF|FOR|WHILE|SELECT)\b/i.test(line)) break;

          const mType =
            /^(?:(?:private|public|global|module|const|static)\s+)*(INT|REAL|STRING|OBJECT|BOOL|BOOLEAN|LONG|ULONG|VOID|QUALITY|TIMESTAMP)\s*$/i.exec(
              line,
            );
          if (mType) {
            returnType = mType[1].toUpperCase();
            break;
          }
        }
      }

      const headerStart = m.index;
      const startPos = doc.positionAt(nameOffset);
      const headerPos = doc.positionAt(headerStart);
      const loc = new vscode.Location(doc.uri, startPos);

      // Extract XML documentation comments (/// style)
      let docText: string | undefined;
      let paramDocs: Record<string, string> | undefined;
      let returnsDoc: string | undefined;

      let docLines = extractSlashDoubleStarDoc(text, headerStart);
      if (!docLines.length) {
        docLines = extractLeadingTripleSlashDoc(text, headerStart);
      }
      if (docLines.length) {
        const parsed = parseXmlDocLines(docLines);
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
        headerEndPos,
      });
    }

    // Match function bodies by tracking nested blocks
    const out: FunctionRange[] = [];

    for (let hi = 0; hi < headers.length; hi++) {
      const h = headers[hi];
      const bodyStart = h.headerEndPos;

      // Don't search past the next function's header
      const maxSearchEnd =
        hi + 1 < headers.length ? headers[hi + 1].headerIndex : text.length;

      // Track nesting depth to find matching END
      // Note: 'function' is excluded since Cicode doesn't support nested functions
      let depth = 1;
      const tokenRe = /\b(if|for|while|repeat|try|select|end)\b/gi;
      tokenRe.lastIndex = bodyStart;

      let endPos = maxSearchEnd;
      let t: RegExpExecArray | null;

      while ((t = tokenRe.exec(text))) {
        if (t.index >= maxSearchEnd) break;
        if (inSpan(t.index, ignoreCS)) continue;

        const kw = t[0].toLowerCase();
        if (kw === "end") {
          depth--;
          if (depth === 0) {
            endPos = t.index + t[0].length;
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
      } as FunctionRange);
    }

    return out;
  }

  /** Parse function parameters into type/name pairs */
  private _parseParamVariables(
    params: string[],
  ): Array<{ type: string; name: string }> {
    const out: Array<{ type: string; name: string }> = [];
    for (const raw of params) {
      // Match: TYPE NAME or TYPE NAME=DEFAULT (with optional spaces around =)
      const m = raw.match(/^\s*(\w+)\s+(\w+)(?:\s*=.*)?$/);
      if (m) {
        out.push({ type: m[1].toUpperCase(), name: m[2] });
      } else {
        // Fallback: try to extract just the variable name
        // Strip any default value assignment first
        const withoutDefault = raw.replace(/\s*=.*$/, "").trim();
        const parts = withoutDefault.split(/\s+/);
        if (parts.length >= 2) {
          // TYPE NAME format
          out.push({ type: parts[0].toUpperCase(), name: parts[1] });
        } else if (parts.length === 1 && parts[0]) {
          // Just a name without type
          out.push({ type: "UNKNOWN", name: parts[0] });
        }
      }
    }
    return out;
  }

  /** Index variable declarations in both function bodies and module scope */
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
      // Use [ \t]+ (not \s+) between type and names to avoid matching across newlines
      const declRe =
        /^\s*(?:(GLOBAL|MODULE)[ \t]+)?(\w+)[ \t]+([^\r\n;]+)\s*;?/gim;
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

          if (scopeKind === "local" && funcCtx) {
            // Inside a function body
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
                scopeType: "local",
                scopeId: this.localScopeId(file, funcCtx.name),
                location: loc,
                file,
                range: funcCtx.bodyRange,
                isParam: false,
              });
            }
          } else if (scopeKind === "local" && !funcCtx) {
            // Defensive: treat as module scope
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
          } else {
            // Module-level declaration
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

    // Scan inside each function body
    for (const f of functions) {
      const base = doc.offsetAt(f.bodyRange.start);
      const slice = text.slice(base, doc.offsetAt(f.bodyRange.end));
      scanDeclsInSlice(slice, base, "local", f);
    }

    // Scan module-level regions (outside functions)
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

  // ===========================================================================
  // Public API
  // ===========================================================================

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
    for (const [, arr] of this.variableCache) {
      for (const v of arr) {
        if (pred(v)) out.push(v);
      }
    }
    return out;
  }

  getTotalVariableCount(): number {
    let n = 0;
    for (const [, arr] of this.variableCache) n += arr.length;
    return n;
  }

  getVariablesInFile(file: string) {
    const out: VariableEntry[] = [];
    for (const [, arr] of this.variableCache) {
      for (const v of arr) {
        if (v.file === file) out.push(v);
      }
    }
    return out;
  }

  getFunctionRanges(file: string) {
    return this.functionRangesByFile.get(file) || [];
  }

  /** Get cached ignore spans (comments/strings) for a file, if indexed. */
  getIgnoreSpans(file: string): Array<[number, number]> | undefined {
    return this._ignoreSpansByFile.get(file);
  }

  /** Resolve a variable name at a given position, respecting scope rules */
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

  /** Find the function containing a given position (includes header and body) */
  findEnclosingFunction(
    document: vscode.TextDocument,
    position: vscode.Position,
  ) {
    const file = document.uri.fsPath;
    const list = this.getFunctionRanges(file);
    if (!list) return null;

    const off = document.offsetAt(position);
    for (const f of list) {
      // Check full function range: from header start to body end
      const headerStart = document.offsetAt(f.headerPos);
      const bodyEnd = document.offsetAt(f.bodyRange.end);
      if (off >= headerStart && off < bodyEnd) return f;
    }
    return null;
  }

  /** Dispose of resources (EventEmitter) */
  dispose(): void {
    this._onIndexed.dispose();
  }
}
