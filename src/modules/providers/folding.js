function makeFolding(indexer) {
  return {
    provideFoldingRanges(doc) {
      return (indexer.getFunctionRanges(doc.uri.fsPath) || []).map(f => ({ start: f.bodyRange.start.line, end: f.bodyRange.end.line, kind: 2 }));
    }
  };
}
module.exports = { makeFolding };
