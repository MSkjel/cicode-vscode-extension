const vscode = require('vscode');
const { initBuiltins, rebuildBuiltins } = require('./modules/builtins');
const { Indexer } = require('./modules/indexer');
const { registerProviders } = require('./modules/providers');
const { registerCommands } = require('./modules/commands');
const { makeStatusBar } = require('./modules/statusBar');

/** @type {Indexer} */
let indexer;

async function activate(context) {
  console.log('Cicode extension active!');

  const cfg = () => vscode.workspace.getConfiguration('cicode');

  await initBuiltins(context, cfg);

  indexer = new Indexer(context, cfg);
  await indexer.buildAll();

  const disposables = [];
  disposables.push(...registerProviders(context, indexer, cfg));
  disposables.push(...registerCommands(context, indexer, cfg, { rebuildBuiltins }));
  disposables.push(makeStatusBar(indexer));

  context.subscriptions.push(...disposables);
}

function deactivate() { }

module.exports = { activate, deactivate };
