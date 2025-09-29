const vscode = require('vscode');
const { makeSymbols } = require('./symbols');
const { makeNavProviders } = require('./navigation');
const { makeCompletion } = require('./completion');
const { makeDiagnostics } = require('./diagnostics');
const { makeRename } = require('./rename');
const { makeFolding } = require('./folding');
const { makeInlay } = require('./inlay');
const { makeSemanticTokens } = require('./semanticTokens');
const { makeFormatter } = require('./formatter');

function registerProviders(context, indexer, cfg) {
  const lang = { language: 'cicode' };
  return [
    vscode.languages.registerDocumentSymbolProvider(lang, makeSymbols(indexer)),
    vscode.languages.registerWorkspaceSymbolProvider(makeSymbols(indexer, true)),
    ...makeNavProviders(indexer),
    vscode.languages.registerCompletionItemProvider(lang, makeCompletion(indexer), ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('')),
    makeDiagnostics(indexer, cfg),
    vscode.languages.registerRenameProvider('cicode', makeRename(indexer)),
    vscode.languages.registerFoldingRangeProvider('cicode', makeFolding(indexer)),
    vscode.languages.registerInlayHintsProvider('cicode', makeInlay(indexer)),
    vscode.languages.registerDocumentSemanticTokensProvider(lang, makeSemanticTokens(indexer), makeSemanticTokens(indexer).legend),
    vscode.languages.registerDocumentFormattingEditProvider('cicode', makeFormatter(cfg))
  ];
}

module.exports = { registerProviders };
