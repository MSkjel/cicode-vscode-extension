import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import type { FunctionInfo } from "../../shared/types";
import {
  buildIgnoreSpans,
  inSpan,
  nameKey,
  upperAscii,
} from "../../shared/textUtils";
import {
  CALL_RE,
  INCLUDE_BOOL_LABELS,
  RESERVED_WORDS,
  TOKEN_RE,
} from "../../shared/constants";

type TokenKind = { type: string; modifiers: string[] };

// Labels are expanded before the compiler looks at names, so a label wins
// over a variable or function of the same name.
const LABEL_CONSTANT: TokenKind = { type: "variable", modifiers: ["readonly"] };
const LABEL_MACRO: TokenKind = { type: "macro", modifiers: [] };
const BUILTIN: TokenKind = { type: "builtin", modifiers: [] };
const LIBRARY_FUNCTION: TokenKind = {
  type: "function",
  modifiers: ["defaultLibrary"],
};

const isDocumented = (f: FunctionInfo | undefined) =>
  !!(f?.helpPath || f?.helpId);

/** How a call to `f` is highlighted; undefined leaves it to the grammar.
 *  `documented`: `f` or the library entry it replaces has help. */
function callKind(f: FunctionInfo, documented: boolean): TokenKind | undefined {
  switch (f.origin) {
    case "label":
      return LABEL_MACRO;
    case "builtin":
      return BUILTIN;
    case "cicode":
      // A documented function written in Cicode (AVEVA's library projects)
      return documented ? LIBRARY_FUNCTION : undefined;
    default:
      return documented ? BUILTIN : undefined;
  }
}

export function makeSemanticTokens(indexer: Indexer): {
  provider: vscode.DocumentSemanticTokensProvider;
  legend: vscode.SemanticTokensLegend;
  dispose: () => void;
} {
  const legend = new vscode.SemanticTokensLegend(
    ["function", "variable", "builtin", "macro"],
    ["global", "local", "parameter", "module", "readonly", "defaultLibrary"],
  );

  /** How a call to `f` (named `key`) in `file` is highlighted. */
  function kindOf(
    key: string,
    f: FunctionInfo,
    file: string,
  ): TokenKind | undefined {
    // A copy of an AVEVA library file hides the documented entry, where
    // that library is compiled with the file
    const lib =
      f.origin === "cicode" ? indexer.getBuiltinFunction(key) : undefined;
    return callKind(
      f,
      isDocumented(f) ||
        (lib?.origin === "cicode" &&
          isDocumented(lib) &&
          (!lib.library || indexer.projects.hasLibrary(file, lib.library))),
    );
  }

  // Call highlighting per nameKey of the functions a file's project sees
  // (projects.visibleKey), rebuilt after each reindex
  const callKinds = new Map<string, Map<string, TokenKind>>();

  function getCallKinds(file: string): Map<string, TokenKind> {
    const vk = indexer.projects.visibleKey(file);
    let kinds = callKinds.get(vk);
    if (kinds) return kinds;
    kinds = new Map();
    for (const [key, f] of indexer.getAllFunctions(file)) {
      const kind = kindOf(key, f, file);
      if (kind) kinds.set(key, kind);
    }
    callKinds.set(vk, kinds);
    return kinds;
  }

  // Notify VS Code to re-request tokens once the (debounced) reindex has
  // caught up, so highlighting built from stale ranges self-corrects.
  const _onDidChange = new vscode.EventEmitter<void>();
  const subscription = indexer.onIndexed(() => {
    callKinds.clear();
    _onDidChange.fire();
  });

  const provider: vscode.DocumentSemanticTokensProvider = {
    onDidChangeSemanticTokens: _onDidChange.event,
    provideDocumentSemanticTokens(doc: vscode.TextDocument) {
      const builder = new vscode.SemanticTokensBuilder(legend);
      const text = doc.getText();
      const file = doc.uri.fsPath;
      // Any label (constant or function-like) of the file's compile, TRUE
      // and FALSE included
      const isLabel = (name: string) =>
        indexer.isKnownLabel(name, file) ||
        INCLUDE_BOOL_LABELS.has(upperAscii(name));
      const isConstantLabel = (name: string) =>
        !!indexer.getLabel(name, file) ||
        INCLUDE_BOOL_LABELS.has(upperAscii(name));
      const push = (offset: number, length: number, kind: TokenKind) => {
        const pos = doc.positionAt(offset);
        builder.push(
          new vscode.Range(pos, pos.translate(0, length)),
          kind.type,
          kind.modifiers,
        );
      };

      // Use indexer data for function definitions (handles edge cases like comments after FUNCTION)
      const definitions = new Set<number>();
      const ranges = indexer.getFunctionRanges(file);
      for (const f of ranges) {
        builder.push(f.location.range, "function", []);
        definitions.add(doc.offsetAt(f.location.range.start));
      }

      // Calls and label names, skipping comments and strings. A call of a
      // function the file defines itself reaches that one (a PRIVATE one
      // hides a built-in), not the one its project sees.
      const kinds = getCallKinds(file);
      const own = new Map<string, TokenKind | undefined>();
      for (const r of ranges) {
        const key = nameKey(r.name);
        const f = indexer.getFunctionFor(r.name, file);
        own.set(key, f && kindOf(key, f, file));
      }
      const kindFor = (key: string) =>
        own.has(key) ? own.get(key) : kinds.get(key);
      const ignore =
        indexer.getIgnoreSpans(file) ??
        buildIgnoreSpans(text, { includeFunctionHeaders: false });
      const calls = new Set<number>();
      CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CALL_RE.exec(text))) {
        const name = m[1];
        calls.add(m.index);
        if (definitions.has(m.index) || inSpan(m.index, ignore)) continue;
        if (m.index > 0 && text[m.index - 1] === ".") continue;
        if (RESERVED_WORDS.has(upperAscii(name))) continue;
        const kind = isLabel(name) ? LABEL_MACRO : kindFor(nameKey(name));
        if (kind) push(m.index, name.length, kind);
      }

      TOKEN_RE.lastIndex = 0;
      while ((m = TOKEN_RE.exec(text))) {
        const name = m[1];
        if (calls.has(m.index) || definitions.has(m.index)) continue;
        // Field of a tag reference (Tag.Field)
        if (m.index > 0 && text[m.index - 1] === ".") continue;
        if (RESERVED_WORDS.has(upperAscii(name))) continue;
        if (inSpan(m.index, ignore)) continue;
        // A function-like label named without parentheses is still expanded
        if (isConstantLabel(name)) push(m.index, name.length, LABEL_CONSTANT);
        else if (isLabel(name)) push(m.index, name.length, LABEL_MACRO);
      }

      return builder.build();
    },
  };

  return {
    provider,
    legend,
    dispose(): void {
      subscription.dispose();
      _onDidChange.dispose();
    },
  };
}
