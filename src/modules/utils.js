const vscode = require('vscode');

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function log(...a) { console.log('[cicode]', ...a); }
function warn(...a) { console.warn('[cicode]', ...a); }
function error(...a) { console.error('[cicode]', ...a); }

module.exports = { debounce, escapeRegExp, log, warn, error };
