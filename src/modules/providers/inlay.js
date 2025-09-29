const vscode = require('vscode');
const {
  buildIgnoreSpans, inSpan,
  cleanParamName, argLooksNamed
} = require('../../modules/textUtils');

function makeInlay(indexer) {
  return {
    provideInlayHints(doc, range) {
      const out = [];
      const text = doc.getText(range);
      const base = doc.offsetAt(range.start);

      const ignore = buildIgnoreSpans(text);
      const call = /\b([A-Za-z_]\w*)\s*\(([^)]*)\)/g;
      let m;

      while ((m = call.exec(text))) {
        const name = m[1];
        const entry = indexer.getFunction(name);
        if (!entry || !entry.params || !entry.params.length) continue;

        const parenRel = m.index + m[0].indexOf('(');
        if (inSpan(parenRel, ignore)) continue;

        const argsRaw = m[2] || '';
        const args = argsRaw.split(',');

        let cursor = 0;
        for (let i = 0; i < Math.min(args.length, entry.params.length); i++) {
          const piece = args[i];
          if (argLooksNamed(piece)) { cursor += piece.length + 1; continue; }

          const argStartRel = parenRel + 1 + cursor;
          const argStartAbs = base + argStartRel;
          const pos = doc.positionAt(argStartAbs);

          const label = cleanParamName(entry.params[i]) + ':';
          out.push(new vscode.InlayHint(pos, label, vscode.InlayHintKind.Parameter));

          cursor += piece.length + 1; // +1 for comma
        }
      }
      return out;
    }
  };
}

module.exports = { makeInlay };
