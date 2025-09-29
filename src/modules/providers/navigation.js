const vscode = require('vscode');
const { buildIgnoreSpans, inSpan } = require('../../modules/textUtils');

function makeNavProviders(indexer) {
  const lang = { language: 'cicode' };
  return [
    // Go to definition
    vscode.languages.registerDefinitionProvider(lang, {
      provideDefinition(document, position) {
        const wr = document.getWordRangeAtPosition(position, /\w+/); if (!wr) return null; const w = document.getText(wr); const f = indexer.getFunction(w); if (f?.location) return f.location; const v = indexer.resolveVariableAt(document, position, w); return v?.location || null;
      }
    }),

    // Find references (skip comments/strings/headers via spans)
    vscode.languages.registerReferenceProvider(lang, {
      async provideReferences(document, position) {
        const wr = document.getWordRangeAtPosition(position, /\w+/); if (!wr) return [];
        const word = document.getText(wr); const lower = word.toLowerCase();
        const files = await vscode.workspace.findFiles('**/*.ci'); const results = [];

        async function scan(uri, range) {
          const doc = await vscode.workspace.openTextDocument(uri);
          const text = doc.getText();
          const searchText = range ? text.slice(doc.offsetAt(range.start), doc.offsetAt(range.end)) : text;
          const baseOffset = range ? doc.offsetAt(range.start) : 0;
          const ignore = buildIgnoreSpans(searchText);
          const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'g');

          let m;
          while ((m = re.exec(searchText))) {
            const abs = baseOffset + m.index;
            if (inSpan(m.index, ignore)) continue;
            // Skip matches inside // trailing comment on the line (cheap guard)
            const lineStart = text.lastIndexOf('\n', abs) + 1;
            const lineEnd = text.indexOf('\n', abs);
            const lineText = text.substring(lineStart, lineEnd === -1 ? text.length : lineEnd);
            const commentIdx = lineText.indexOf('//');
            const col = abs - lineStart;
            if (commentIdx >= 0 && col >= commentIdx) continue;

            const start = doc.positionAt(abs);
            const end = doc.positionAt(abs + word.length);
            results.push(new vscode.Location(uri, new vscode.Range(start, end)));
          }
        }

        const funcEntry = indexer.getFunction(lower);
        const varEntry = indexer.resolveVariableAt(document, position, word);

        if (funcEntry) { for (const f of files) await scan(f); return results; }
        if (varEntry) {
          if (varEntry.scopeType === 'local') { await scan(document.uri, varEntry.range); }
          else if (varEntry.scopeType === 'module') { await scan(document.uri); }
          else { for (const f of files) await scan(f); }
          return results;
        }
        for (const f of files) await scan(f);
        return results;
      }
    }),

    // Hover + Signature help (same logic as before)
    vscode.languages.registerHoverProvider(lang, {
      provideHover(document, position) {
        const wr = document.getWordRangeAtPosition(position, /\w+/); if (!wr) return null; const w = document.getText(wr); const lc = w.toLowerCase(); const f = indexer.getFunction(lc);
        if (f) { const sig = `${f.returnType} ${f.name}(${(f.params || []).join(', ')})`; let md = '```cicode\n' + sig + '\n```'; if (f.doc) md += '\n\n' + f.doc; if (f.helpPath && vscode.workspace.getConfiguration('cicode').get('hover.showHelpLink', true)) { const cmdUri = vscode.Uri.parse(`command:cicode.openHelpForSymbol?${encodeURIComponent(JSON.stringify(f.name))}`); md += `\n\n[Open full help](${cmdUri})`; } const ms = new vscode.MarkdownString(md); ms.isTrusted = true; return new vscode.Hover(ms); }
        const v = indexer.resolveVariableAt(document, position, w); if (v) { const scope = v.scopeType === 'global' ? 'global' : v.scopeType === 'module' ? 'module' : `local (${v.scopeId.split('::').pop()})`; const md = '```cicode\n' + `${v.type} ${v.name} // ${scope}` + '\n```'; return new vscode.Hover(md); }
        return null;
      }
    }),

    vscode.languages.registerSignatureHelpProvider(lang, {
      provideSignatureHelp(document, position) {
        const text = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
        let depth = 0, funcPos = -1; for (let i = text.length - 1; i >= 0; i--) { const ch = text[i]; if (ch === ')') depth++; else if (ch === '(') { if (depth === 0) { funcPos = i; break; } depth--; } } if (funcPos === -1) return null;
        const funcRange = document.getWordRangeAtPosition(document.positionAt(funcPos - 1), /\w+/); if (!funcRange) return null; const funcName = document.getText(funcRange);
        const entry = indexer.getFunction(funcName); if (!entry) return null;
        const sigInfo = new vscode.SignatureInformation(`${entry.returnType} ${funcName}(${entry.params.join(', ')})`, entry.doc || `Function ${funcName}`);
        sigInfo.parameters = entry.params.map(p => new vscode.ParameterInformation(p));
        const sigHelp = new vscode.SignatureHelp(); sigHelp.signatures = [sigInfo]; sigHelp.activeSignature = 0;
        const lineText = document.lineAt(position.line).text; const argText = lineText.substring(lineText.lastIndexOf('(', position.character - 1) + 1, position.character); const commaCount = (argText.match(/,/g) || []).length; sigHelp.activeParameter = Math.min(commaCount, Math.max(entry.params.length - 1, 0));
        return sigHelp;
      }
    }, { triggerCharacters: ['(', ','], retriggerCharacters: [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split(''), ' ', ',', ')'] })
  ];
}

module.exports = { makeNavProviders };
