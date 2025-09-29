const vscode = require('vscode');
const { debounce } = require('./utils');
const { getBuiltins } = require('./builtins');
const { TYPE_RE, splitDeclNames, buildIgnoreSpans } = require('./textUtils');

class Indexer {
  constructor(context, cfg) {
    this.context = context; this.cfg = cfg;
    this.functionCache = new Map();
    this.variableCache = new Map();
    this.functionRangesByFile = new Map();

    this._onIndexed = new vscode.EventEmitter();
    this.onIndexed = this._onIndexed.event;

    this._debouncedIndex = debounce((doc) => this._indexFile(doc), 200);

    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(d => this._maybeIndex(d)),
      vscode.workspace.onDidDeleteFiles(e => e.files.forEach(f => this._purgeFile(f.fsPath))),
      vscode.workspace.onDidRenameFiles(e => e.files.forEach(({ oldUri, newUri }) => this._moveFile(oldUri.fsPath, newUri.fsPath)))
    );
  }

  async buildAll() {
    this.functionCache.clear();
    this.variableCache.clear();
    this.functionRangesByFile.clear();

    // seed builtins
    for (const [k, v] of getBuiltins()) this.functionCache.set(k, { ...v, location: null, file: null, bodyRange: null });

    const exclude = (this.cfg().get('cicode.indexing.excludeGlobs', []) || []).join(',');
    const files = await vscode.workspace.findFiles('**/*.ci', exclude);
    for (const file of files) {
      try { const doc = await vscode.workspace.openTextDocument(file); await this._indexFile(doc); }
      catch (e) { console.error('index fail', file.fsPath, e); }
    }
    this._onIndexed.fire();
  }

  _maybeIndex(doc) { if (!doc.uri.fsPath.toLowerCase().endsWith('.ci')) return; this._debouncedIndex(doc); }

  _purgeFile(file) {
    for (const [k, v] of this.functionCache) if (v && v.file === file) this.functionCache.delete(k);
    for (const [k, arr] of this.variableCache) {
      const filtered = arr.filter(e => e.file !== file);
      if (filtered.length) this.variableCache.set(k, filtered); else this.variableCache.delete(k);
    }
    this.functionRangesByFile.delete(file);
    this._onIndexed.fire();
  }

  _moveFile(oldPath, newPath) {
    for (const [k, v] of this.functionCache) { if (v && v.file === oldPath) v.file = newPath; }
    for (const [k, arr] of this.variableCache) { arr.forEach(e => { if (e.file === oldPath) e.file = newPath; }); }
    if (this.functionRangesByFile.has(oldPath)) {
      this.functionRangesByFile.set(newPath, this.functionRangesByFile.get(oldPath));
      this.functionRangesByFile.delete(oldPath);
    }
    this._onIndexed.fire();
  }

  localScopeId(file, funcName) { return `local:${file}::${funcName}`; }

  async _indexFile(doc) {
    const file = doc.uri.fsPath;
    this._purgeFile(file); // clear old entries for this file

    const text = doc.getText();
    const functions = this._extractFunctionsWithRanges(text, doc);
    this.functionRangesByFile.set(file, functions);

    for (const f of functions) {
      const key = f.name.toLowerCase();
      const params = f.paramsRaw.split(',').map(p => p.trim()).filter(Boolean);
      this.functionCache.set(key, { name: f.name, returnType: f.returnType || 'VOID', params, location: f.location, doc: '', file, bodyRange: f.bodyRange });

      // params as local vars
      for (const v of this._parseParamVariables(params)) {
        this._addVar(v.name, { name: v.name, type: v.type, scopeType: 'local', scopeId: this.localScopeId(file, f.name), location: new vscode.Location(doc.uri, f.location.range.start), file, range: f.bodyRange, isParam: true });
      }
    }

    this._indexVariablesInText(doc, text, functions);
    this._onIndexed.fire();
  }

  _addVar(name, entry) { const k = name.toLowerCase(); if (!this.variableCache.has(k)) this.variableCache.set(k, []); this.variableCache.get(k).push(entry); }

  _extractFunctionsWithRanges(text, doc) {
    const regex = /^(?!.*\/\/).*?(\w+)?\s*function\s+(\w+)\s*\(([^)]*)\)/gim;
    const headers = []; let m;
    while ((m = regex.exec(text))) {
      const returnType = (m[1] || '').toUpperCase() || 'VOID';
      const name = m[2]; const paramsRaw = m[3] || ''; const headerStart = m.index; const nameOffset = m.index + m[0].indexOf(name);
      const startPos = doc.positionAt(nameOffset); const headerPos = doc.positionAt(headerStart); const loc = new vscode.Location(doc.uri, startPos);
      headers.push({ name, returnType, paramsRaw, headerIndex: headerStart, headerPos, location: loc });
    }

    const out = [];
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i]; const end = (i + 1 < headers.length) ? headers[i + 1].headerIndex : text.length;
      const rpar = text.indexOf(')', h.headerIndex); const bodyStart = (rpar === -1 ? h.headerIndex : rpar + 1);
      out.push({ ...h, startOffset: h.headerIndex, endOffset: end, bodyRange: new vscode.Range(doc.positionAt(bodyStart), doc.positionAt(end)) });
    }
    return out;
  }

  _parseParamVariables(params) {
    const out = []; for (const raw of params) { const m = raw.match(/^\s*(\w+)\s+(\w+)\s*$/); if (m) out.push({ type: m[1].toUpperCase(), name: m[2] }); else { const n = raw.trim(); if (n) out.push({ type: 'UNKNOWN', name: n }); } }
    return out;
  }

  _indexVariablesInText(doc, text, functions) {
    const file = doc.uri.fsPath;

    // Build function intervals (absolute offsets)
    const intervals = functions.map(f => ({
      start: doc.offsetAt(f.bodyRange.start),
      end: doc.offsetAt(f.bodyRange.end),
      func: f
    }));
    const findFunc = (off) => intervals.find(i => off >= i.start && off < i.end)?.func || null;

    // Helper: scan a text slice for declarations, skipping comments/strings/headers
    function scanDeclsInSlice(sliceText, baseOffset, scopeKind, funcCtx) {
      const ignore = buildIgnoreSpans(sliceText);
      const declRe = /^\s*(?:(GLOBAL|MODULE)\s+)?(\w+)\s+([^;]+);?/gmi; // 1=scope kw, 2=type, 3=names
      let m;
      while ((m = declRe.exec(sliceText))) {
        const kw = (m[1] || '').toUpperCase();
        const typeRaw = m[2];
        if (!TYPE_RE.test(typeRaw)) continue;                 // avoid IF/FOR/etc.

        // '(' position is a good anchor to test ignore; use start of match
        const anchor = m.index;
        // Skip if inside comments/strings/headers
        // (use the match start; that’s enough for decl lines)
        if (isIgnored(anchor, ignore)) continue;

        const type = typeRaw.toUpperCase();
        const namesPart = m[3];
        const names = splitDeclNames(namesPart);

        // Find where namesPart starts relative to the slice
        const namesRelStart = m.index + m[0].indexOf(namesPart);

        // Compute this declaration's scope
        const isGlobalKw = kw === 'GLOBAL';
        const isModuleKw = kw === 'MODULE';

        for (const name of names) {
          // position for this variable name
          const nameRel = namesRelStart + indexOfFrom(namesPart, name);
          const abs = baseOffset + nameRel;
          const pos = doc.positionAt(abs);
          const loc = new vscode.Location(doc.uri, pos);

          // Decide scope
          if (scopeKind === 'local' && !isGlobalKw) {
            this._addVar(name, {
              name, type,
              scopeType: 'local',
              scopeId: this.localScopeId(file, funcCtx.name),
              location: loc, file, range: funcCtx.bodyRange, isParam: false
            });
          } else if (isGlobalKw) {
            this._addVar(name, {
              name, type, scopeType: 'global', scopeId: 'global',
              location: loc, file, range: null, isParam: false
            });
          } else {
            // module: either keyword MODULE or top-level region
            this._addVar(name, {
              name, type, scopeType: 'module', scopeId: file,
              location: loc, file, range: null, isParam: false
            });
          }
        }
      }

      function isIgnored(pos, spans) {
        for (const [s, e] of spans) {
          if (pos >= s && pos < e) return true;
          if (pos < s) break;
        }
        return false;
      }
      function indexOfFrom(hay, needle) {
        // robust incremental search for each name occurrence
        const idx = hay.indexOf(needle);
        return idx >= 0 ? idx : 0;
      }
    }

    // 1) Locals: scan each function body slice
    for (const f of functions) {
      const base = doc.offsetAt(f.bodyRange.start);
      const slice = text.slice(base, doc.offsetAt(f.bodyRange.end));
      scanDeclsInSlice.call(this, slice, base, 'local', f);
    }

    // 2) Module/Global: scan regions outside functions
    const nonFuncRegions = [];
    let cursor = 0;
    for (const it of intervals.sort((a, b) => a.start - b.start)) {
      if (cursor < it.start) nonFuncRegions.push([cursor, it.start]);
      cursor = Math.max(cursor, it.end);
    }
    if (cursor < text.length) nonFuncRegions.push([cursor, text.length]);

    for (const [start, end] of nonFuncRegions) {
      const slice = text.slice(start, end);
      scanDeclsInSlice.call(this, slice, start, 'module', null);
    }
  }

  // API for providers
  getFunction(name) { return this.functionCache.get(name.toLowerCase()); }
  hasFunction(name) { return this.functionCache.has(name.toLowerCase()); }
  getAllFunctions() { return this.functionCache; }
  getVariables(name) { return this.variableCache.get(name.toLowerCase()) || []; }
  getVariablesInFile(file) { const out = []; for (const [, arr] of this.variableCache) for (const v of arr) if (v.file === file) out.push(v); return out; }
  getFunctionRanges(file) { return this.functionRangesByFile.get(file) || []; }
  resolveVariableAt(document, position, name) {
    const file = document.uri.fsPath; const lc = name.toLowerCase(); const candidates = this.variableCache.get(lc); if (!candidates || !candidates.length) return null;
    const encl = this.findEnclosingFunction(document, position); if (encl) { const sid = this.localScopeId(file, encl.name); const local = candidates.find(v => v.scopeType === 'local' && v.scopeId === sid); if (local) return local; }
    const mod = candidates.find(v => v.scopeType === 'module' && v.scopeId === file); if (mod) return mod;
    const glob = candidates.find(v => v.scopeType === 'global'); if (glob) return glob;
    return candidates[0];
  }
  findEnclosingFunction(document, position) { const file = document.uri.fsPath; const list = this.getFunctionRanges(file); if (!list) return null; const off = document.offsetAt(position); for (const f of list) { const s = document.offsetAt(f.bodyRange.start), e = document.offsetAt(f.bodyRange.end); if (off >= s && off < e) return f; } return null; }
}

module.exports = { Indexer };
