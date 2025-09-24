const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// -------------------- CACHE --------------------
let functionCache = new Map(); // key: function name (lowercased), value: { name, returnType, params, location, doc }

// -------------------- BUILTIN LOADER --------------------
async function loadBuiltinFunctions(context, rebuild) {
  const storageFile = path.join(context.globalStorageUri.fsPath, "builtinFunctions.json");

  if (fs.existsSync(storageFile) && !rebuild) {
    console.log("Loading builtin functions from cache:", storageFile);
    return JSON.parse(fs.readFileSync(storageFile, "utf8"));
  }

  const inputDir = "C:/Program Files (x86)/AVEVA Plant SCADA/Bin/Help/SCADA Help/Subsystems/CicodeReferenceCitectHTML/Content";
  let functions = {};
  
  if (fs.existsSync(inputDir)) {
    console.log("Parsing builtin functions from help folder:", inputDir);
    for (const file of fs.readdirSync(inputDir)) {
      if (!file.toLowerCase().endsWith(".html")) continue;

      try {
        const html = fs.readFileSync(path.join(inputDir, file), "utf8");
        const $ = cheerio.load(html);

        const name = $(".pFunctionName").first().text().trim();
        if (!name) continue;

        let syntaxLine = $("p:contains('Syntax')").next("p").text().trim();
        if (!syntaxLine) syntaxLine = $("p:contains('Syntax')").next("pre").text().trim();

        let params = [];
        const match = syntaxLine.match(/\((.*)\)/);
        if (match) {
          params = match[1]
            .split(",")
            .map(p => p.replace(/\s+/g, " ").trim())
            .filter(p => p.length > 0);
        }

        const desc =
          $("meta[name=description]").attr("content") ||
          $(".pBody").first().text().trim() ||
          "";

        let returnType = "UNKNOWN";
        const returnPara = $("p.SubHeading:contains('Return Value')").next("p").text().trim();
        if (returnPara) {
          const firstWord = returnPara.split(/\s+/)[0];
          if (/^(INT|REAL|STRING|OBJECT|BOOL|LONG|ULONG)$/i.test(firstWord)) {
            returnType = firstWord.toUpperCase();
          }
        }

        functions[name.toLowerCase()] = {
          name,
          returnType,
          params,
          doc: desc
        };
      } catch (err) {
        console.error("Failed parsing builtin help file:", file, err);
      }
    }

    if (Object.keys(functions).length > 0) {
      fs.mkdirSync(path.dirname(storageFile), { recursive: true });
      fs.writeFileSync(storageFile, JSON.stringify(functions, null, 2), "utf8");
      console.log("Extracted and cached", Object.keys(functions).length, "builtin functions");
      return functions;
    }
  }

  try {
    const packagedFile = context.asAbsolutePath(path.join("builtins", "builtinFunctions.json"));
    if (fs.existsSync(packagedFile)) {
      console.log("Falling back to packaged builtin functions:", packagedFile);
      return JSON.parse(fs.readFileSync(packagedFile, "utf8"));
    }
  } catch (err) {
    console.error("No packaged builtin functions found", err);
  }

  console.warn("No builtin functions available!");
  return {};
}

// -------------------- USER FUNCTION INDEX --------------------
async function buildFunctionCache(context) {
  functionCache.clear();

  const builtins = await loadBuiltinFunctions(context, false);
  for (const [key, val] of Object.entries(builtins)) {
    functionCache.set(key, { ...val, location: null });
  }

  const files = await vscode.workspace.findFiles('**/*.ci');
  for (const file of files) {
    try {
      const doc = await vscode.workspace.openTextDocument(file);
      indexFunctionsInDocument(doc);
    } catch (err) {
      console.error("Cache init failed:", file.fsPath, err);
    }
  }

  console.log("Cicode function cache built:", functionCache.size, "functions");
}

function indexFunctionsInDocument(doc) {
  const text = doc.getText();
  const regex = /^(?!.*\/\/)\s*(\w+)?\s*function\s+(\w+)\s*\(([^)]*)\)/gim;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const returnType = match[1] ? match[1].toUpperCase() : "VOID";
    const name = match[2];
    const params = match[3].split(/\s*,\s*/).filter(p => p.length > 0);

    // Jump to the function name instead of line start
    const nameOffset = match.index + match[0].indexOf(name);
    const start = doc.positionAt(nameOffset);
    const loc = new vscode.Location(doc.uri, start);

    functionCache.set(name.toLowerCase(), { name, returnType, params, location: loc, doc: "" });
  }
}

// -------------------- PROVIDERS --------------------

// Outline (symbols)
class CicodeSymbolProvider {
  provideDocumentSymbols(document) {
    return extractFunctionSymbols(document.getText(), document.uri);
  }
}

// Workspace symbols
class CicodeWorkspaceSymbolProvider {
  async provideWorkspaceSymbols(query) {
    const results = [];
    for (const [key, entry] of functionCache.entries()) {
      if (!query || key.includes(query.toLowerCase())) {
        const display = entry.name || key;
        results.push(new vscode.SymbolInformation(
          display,
          vscode.SymbolKind.Function,
          '',
          entry.location || new vscode.Location(vscode.Uri.file(""), new vscode.Position(0, 0))
        ));
      }
    }
    return results;
  }
}

// Go to Definition
class CicodeDefinitionProvider {
  provideDefinition(document, position) {
    const wordRange = document.getWordRangeAtPosition(position, /\w+/);
    if (!wordRange) return null;
    const word = document.getText(wordRange);
    const entry = functionCache.get(word.toLowerCase());
    return entry && entry.location ? entry.location : null;
  }
}

// References
class CicodeReferenceProvider {
  async provideReferences(document, position) {
    const wordRange = document.getWordRangeAtPosition(position, /\w+/);
    if (!wordRange) return [];
    const word = document.getText(wordRange);

    const results = [];
    const files = await vscode.workspace.findFiles('**/*.ci');

    for (const file of files) {
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();
        const regex = new RegExp(`\\b${escapeRegExp(word)}\\b`, "gi");
        let match;
        while ((match = regex.exec(text)) !== null) {
          const lineStart = text.lastIndexOf("\n", match.index) + 1;
          const lineEnd = text.indexOf("\n", match.index);
          const lineText = text.substring(lineStart, lineEnd === -1 ? text.length : lineEnd);

          if (lineText.includes("//")) continue;

          const start = doc.positionAt(match.index);
          const end = doc.positionAt(match.index + word.length);
          results.push(new vscode.Location(file, new vscode.Range(start, end)));
        }
      } catch (err) {
        console.error("Reference scan failed for:", file.fsPath, err);
      }
    }
    return results;
  }
}

// Hover (prototype preview)
class CicodeHoverProvider {
  provideHover(document, position) {
    const wordRange = document.getWordRangeAtPosition(position, /\w+/);
    if (!wordRange) return null;
    const word = document.getText(wordRange);
    const entry = functionCache.get(word.toLowerCase());
    if (!entry) return null;

    const signature = `${entry.returnType} ${entry.name || word}(${entry.params.join(", ")})`;
    let docText = "```cicode\n" + signature + "\n```";
    if (entry.doc) docText += `\n\n${entry.doc}`;
    return new vscode.Hover(docText);
  }
}

// Signature help
class CicodeSignatureHelpProvider {
  provideSignatureHelp(document, position) {
    const text = document.getText(new vscode.Range(new vscode.Position(0, 0), position));

    let depth = 0;
    let funcPos = -1;
    for (let i = text.length - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === ')') depth++;
      else if (ch === '(') {
        if (depth === 0) { funcPos = i; break; }
        depth--;
      }
    }
    if (funcPos === -1) return null;

    const funcRange = document.getWordRangeAtPosition(document.positionAt(funcPos - 1), /\w+/);
    if (!funcRange) return null;
    const funcName = document.getText(funcRange);

    const entry = functionCache.get(funcName.toLowerCase());
    if (!entry) return null;

    const sigInfo = new vscode.SignatureInformation(
      `${entry.returnType} ${funcName}(${entry.params.join(", ")})`,
      entry.doc || `Function ${funcName}`
    );
    sigInfo.parameters = entry.params.map(p => new vscode.ParameterInformation(p));

    const sigHelp = new vscode.SignatureHelp();
    sigHelp.signatures = [sigInfo];
    sigHelp.activeSignature = 0;

    const lineText = document.lineAt(position.line).text;
    const argText = lineText.substring(lineText.lastIndexOf('(', position.character - 1) + 1, position.character);
    const commaCount = (argText.match(/,/g) || []).length;
    sigHelp.activeParameter = Math.min(commaCount, entry.params.length - 1);

    return sigHelp;
  }
}

// Completion
class CicodeCompletionProvider {
  provideCompletionItems(document, position) {
    const items = [];

    for (const [key, entry] of functionCache.entries()) {
      const display = entry.name || key;
      const signature = `${entry.returnType} ${display}(${entry.params.join(", ")})`;

      const item = new vscode.CompletionItem(display, vscode.CompletionItemKind.Function);
      item.label = display;
      item.insertText = display;
      item.detail = signature;
      if (entry.doc) {
        item.documentation = new vscode.MarkdownString(entry.doc);
      }
      items.push(item);
    }

    return items;
  }
}

// -------------------- HELPERS --------------------
function extractFunctionSymbols(text, uri) {
  const symbols = [];
  const regex = /^(?!.*\/\/)\s*(\w+)?\s*function\s+(\w+)\s*\(/gim;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const name = match[2];
    const offset = match.index;
    const before = text.substr(0, offset);
    const line = before.split(/\r?\n/).length - 1;
    const col = offset - before.lastIndexOf("\n") - 1;

    symbols.push(
      new vscode.SymbolInformation(
        name,
        vscode.SymbolKind.Function,
        '',
        new vscode.Location(uri, new vscode.Position(line, col))
      )
    );
  }
  return symbols;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// -------------------- ACTIVATE --------------------
async function activate(context) {
  console.log("Cicode extension active!");
  await buildFunctionCache(context);

  // Rebuild cache when documents are saved
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.languageId === 'cicode') {
        indexFunctionsInDocument(doc);
      }
    })
  );

  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('');
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider({ language: 'cicode' }, new CicodeSymbolProvider()),
    vscode.languages.registerWorkspaceSymbolProvider(new CicodeWorkspaceSymbolProvider()),
    vscode.languages.registerDefinitionProvider({ language: 'cicode' }, new CicodeDefinitionProvider()),
    vscode.languages.registerReferenceProvider({ language: 'cicode' }, new CicodeReferenceProvider()),
    vscode.languages.registerHoverProvider({ language: 'cicode' }, new CicodeHoverProvider()),
    vscode.languages.registerSignatureHelpProvider(
      { language: 'cicode' },
      new CicodeSignatureHelpProvider(),
      { triggerCharacters: ['(', ','], retriggerCharacters: letters.concat([' ', ',', ')']) }
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: 'cicode' },
      new CicodeCompletionProvider(),
      ...letters
    ),
    vscode.commands.registerCommand("cicode.rebuildBuiltins", async () => {
      await loadBuiltinFunctions(context, true);
      await buildFunctionCache(context);
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
