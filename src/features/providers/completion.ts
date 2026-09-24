import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import type { FunctionInfo, VariableEntry } from "../../shared/types";
import {
  buildIgnoreSpans,
  inSpan,
  isInCommentOrString,
  leftWordRangeAt,
  nameKey,
  scanIgnoreSpans,
  stripLineComment,
} from "../../shared/textUtils";
import { CICODE_TYPES, NAME_CHARS, NAME_PATTERN } from "../../shared/constants";
import { formatScopeType } from "../../shared/utils";
import { scanBlocks } from "./formatter";

// ---------------------------------------------------------------------------
// Keyword categories
// ---------------------------------------------------------------------------

const KW_CONTROL_FLOW = new Set(["for", "while", "if", "do", "select", "case"]);

const KW_CONTROL = new Set([
  "then",
  "else",
  "end",
  "end select",
  "to",
  "is",
  "return",
]);

// Derived from the shared type list so the two can never drift apart
// (lowercase: the KW_* sets and sortText rely on lowercase keywords).
const KW_TYPES = new Set([...CICODE_TYPES].map((t) => t.toLowerCase()));

// File-scope words: invalid inside a function body (E2041, FUNCTION E2076)
const KW_SCOPE = new Set(["module", "global", "function", "private", "public"]);

const KW_OPERATORS = new Set([
  "and",
  "or",
  "not",
  "mod",
  "bitand",
  "bitor",
  "bitxor",
]);

/** All keywords in a single iterable for the completion loop. */
const ALL_KEYWORDS = [
  ...KW_CONTROL_FLOW,
  ...KW_CONTROL,
  ...KW_TYPES,
  ...KW_SCOPE,
  ...KW_OPERATORS,
];

// ---------------------------------------------------------------------------
// Sort prefixes
// ---------------------------------------------------------------------------

const SORT = {
  LOCAL_VAR: "0A_",
  MODULE_VAR: "0B_",
  KW_HIGH: "0C_", // boosted keyword tier
  KW_MID: "0D_", // default keyword tier
  KW_LOW: "0E_", // demoted keyword tier
  USER_FUNC: "0F_",
  BUILTIN_FUNC: "0G_",
  GLOBAL_VAR: "1_",
  LABEL: "1_",
  // `_` names are internal helpers of the compiler and AVEVA's libraries;
  // the Cicode Editor hides them, they are listed last here.
  INTERNAL_FUNC: "2_",
} as const;

// ---------------------------------------------------------------------------
// Context detection
// ---------------------------------------------------------------------------

type CursorContext =
  | "statement"
  | "expression"
  | "format"
  | "type"
  | "declaration"
  | "funcdef"
  | "param"
  | "default";

// The six declaration types (a tag type such as LONG or a word such as VOID
// starts no declaration: E2015 in a parameter list, E2031 at file scope).
const TYPES_PATTERN = [...CICODE_TYPES].join("|");
const NAME_TAIL = `[${NAME_CHARS}]*$`;

// "param": naming a parameter in a FUNCTION header's argument list, e.g.
// "INT FUNCTION Foo(INT i" or a continuation line "STRING sArg1 = "", STRING s".
// The tail is checked on the current line; inParamList() then confirms the
// cursor is inside an unclosed FUNCTION header '('.
const PARAM_TAIL_RE = new RegExp(
  `(?:^|[(,])\\s*(?:${TYPES_PATTERN})\\s+${NAME_TAIL}`,
  "i",
);
const FUNC_HEADER_OPEN_RE = new RegExp(
  `(?<![${NAME_CHARS}])FUNCTION\\s+${NAME_PATTERN}\\s*\\(`,
  "gi",
);
/** How far back to look for the FUNCTION header of a multi-line parameter list. */
const PARAM_LOOKBACK_LINES = 20;

/** True when the cursor is inside the still-open parameter list of a
 *  FUNCTION header (which may span several lines). */
function inParamList(
  document: vscode.TextDocument,
  position: vscode.Position,
): boolean {
  const firstLine = Math.max(0, position.line - PARAM_LOOKBACK_LINES);
  const text = document.getText(
    new vscode.Range(new vscode.Position(firstLine, 0), position),
  );
  // Strings (default values, which may span lines) and comments are skipped
  const spans = scanIgnoreSpans(text);
  let paramsStart = -1;
  FUNC_HEADER_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FUNC_HEADER_OPEN_RE.exec(text))) {
    if (!inSpan(m.index, spans)) paramsStart = m.index + m[0].length;
  }
  if (paramsStart < 0) return false;

  // The header's '(' is still open if no top-level ')' follows it.
  let depth = 0;
  let k = 0;
  for (let i = paramsStart; i < text.length; i++) {
    while (k < spans.length && spans[k][1] <= i) k++;
    if (k < spans.length && spans[k][0] <= i) {
      i = spans[k][1] - 1;
      continue;
    }
    const c = text[i];
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      if (depth === 0) return false;
      depth--;
    }
  }
  return true;
}

// "declaration": statement-start type keyword (with an optional scope
// keyword) + space + the name being typed, or a further name of a list
// e.g. "INT i", "REAL myV", "MODULE STRING s", "INT a, b", but NOT "nX = Int i"
const DECL_RE = new RegExp(
  `^\\s*(?:(?:GLOBAL|MODULE|PRIVATE|PUBLIC)\\s+)?(?:${TYPES_PATTERN})\\s+(?:${NAME_PATTERN}\\s*,\\s*)*[${NAME_CHARS}]+$`,
  "i",
);

// "funcdef": after FUNCTION keyword + space (+ optional chars being typed as function name)
// e.g. "FUNCTION foo", "INT FUNCTION My"
const FUNCDEF_RE = new RegExp(
  `(?<![${NAME_CHARS}])FUNCTION\\s+${NAME_TAIL}`,
  "i",
);

// "type": statement-start type keyword (with an optional scope keyword)
// followed by whitespace, anchored so identifiers ending in a type word
// mid-expression (e.g. "nX = Int" while typing IntToStr) don't collapse
// completions, and requiring the space so a bare "Object"/"Int" at statement
// start stays "statement" and still offers ObjectAssociateEvents, IntToStr...
const TYPE_KW_RE = new RegExp(
  `^\\s*(?:(?:GLOBAL|MODULE|PRIVATE|PUBLIC)\\s+)?(?:${TYPES_PATTERN})\\s+$`,
  "i",
);
// GLOBAL and MODULE functions do not exist (E2070, E2069)
const VAR_SCOPE_RE = /^\s*(?:GLOBAL|MODULE)\s/i;
// An operand comes next: after an operator, '(' '[' ',' or a keyword that
// takes an expression. (`!` starts a comment; `&`, `|` and `^` are no
// operators.)
const EXPR_TAIL_RE = new RegExp(
  `(?:[=+\\-*/<>(,[]|(?<![${NAME_CHARS}])(?:AND|OR|NOT|MOD|BITAND|BITOR|BITXOR|IF|WHILE|RETURN|TO))\\s*$`,
  "i",
);
// The format operator: a picture (###), a width or a label comes next
const FORMAT_TAIL_RE = /:\s*$/;
// A label that expands to a width (`5`, `-5`, `3.2`, `0x5`) or `~` fits
// after `:`; one that expands to a picture or a name gives E2035.
const FORMAT_LABEL_RE =
  /^\s*(?:~|-?\s*(?:0[xX][0-9A-Fa-f]*|0[bB][01]*|0[oO][0-7]*|\d+\.?\d*(?:[eE][+-]?\d*)?))\s*$/;
// A new statement starts at the line start, after ';', or after THEN, DO,
// ELSE or END (a line break is only whitespace: statements may share lines)
const STATEMENT_TAIL_RE = new RegExp(
  `(?:^|;|(?<![${NAME_CHARS}])(?:THEN|DO|ELSE|END))\\s*$`,
  "i",
);
const FUNCTION_TAIL_RE = new RegExp(`(?<![${NAME_CHARS}])FUNCTION$`, "i");
const PARTIAL_NAME_RE = new RegExp(NAME_TAIL);

function detectContext(
  document: vscode.TextDocument,
  position: vscode.Position,
): CursorContext {
  const lineText = document
    .lineAt(position.line)
    .text.slice(0, position.character);
  // The text before the name being typed
  const before = lineText.replace(PARTIAL_NAME_RE, "");

  // Most specific checks first
  if (PARAM_TAIL_RE.test(lineText) && inParamList(document, position))
    return "param";
  if (DECL_RE.test(lineText)) return "declaration";
  if (FUNCDEF_RE.test(lineText)) return "funcdef";
  if (TYPE_KW_RE.test(lineText)) return "type";
  if (FORMAT_TAIL_RE.test(before)) return "format";
  if (STATEMENT_TAIL_RE.test(before)) {
    // Multiline function declaration: if the previous code line ends with
    // the FUNCTION keyword (e.g. "INT FUNCTION\nMyFunc|"), the cursor is in
    // the function-name position even though the current line looks like a
    // statement. Comment lines may sit in between.
    if (/^\s*$/.test(before)) {
      for (
        let i = position.line - 1;
        i >= Math.max(0, position.line - 4);
        i--
      ) {
        const prev = stripLineComment(document.lineAt(i).text).trim();
        if (!prev) continue; // skip blank and comment lines
        if (FUNCTION_TAIL_RE.test(prev)) return "funcdef";
        break; // first code line is not a funcdef continuation
      }
    }
    return "statement";
  }
  if (EXPR_TAIL_RE.test(before)) return "expression";
  return "default";
}

/** Where `position` is in the live text: inside a function (header or
 *  body; outside, only declarations and FUNCTION are valid, E2031), and
 *  inside an IF, WHILE, FOR or SELECT block of it (no declarations, E2041). */
function blockContextAt(
  document: vscode.TextDocument,
  position: vscode.Position,
): { inFunction: boolean; inBlock: boolean } {
  const text = document.getText();
  const spans = buildIgnoreSpans(text, { includeFunctionHeaders: false });
  const line = position.line;
  const around = scanBlocks(text, spans).blocks.filter(
    (b) => b.openLine <= line && (b.closeLine === -1 || b.closeLine >= line),
  );
  return {
    inFunction: around.some((b) => b.kind === "FUNCTION"),
    inBlock: around.some((b) => b.kind !== "FUNCTION"),
  };
}

// ---------------------------------------------------------------------------
// Keyword → sortText mapping based on context
// ---------------------------------------------------------------------------

function keywordSortPrefix(kw: string, ctx: CursorContext): string {
  if (KW_CONTROL_FLOW.has(kw)) {
    return ctx === "statement" ? SORT.KW_HIGH : SORT.KW_LOW;
  }
  if (KW_CONTROL.has(kw)) {
    return SORT.KW_MID;
  }
  if (KW_TYPES.has(kw)) {
    return ctx === "type" || ctx === "statement" ? SORT.KW_HIGH : SORT.KW_MID;
  }
  if (KW_SCOPE.has(kw)) {
    return ctx === "statement" ? SORT.KW_HIGH : SORT.KW_MID;
  }
  return ctx === "expression" ? SORT.KW_HIGH : SORT.KW_LOW;
}

/** Whether a keyword can come next in this context. */
function keywordFits(
  kw: string,
  ctx: CursorContext,
  inFunction: boolean,
  inBlock: boolean,
  lineText: string,
): boolean {
  switch (ctx) {
    case "expression":
      // An operand comes next: the only operand keyword is NOT (a file-scope
      // initializer is a literal or a label)
      return kw === "not" && inFunction;
    case "format":
      return false;
    case "type":
    case "declaration":
      // After a file-scope type keyword only FUNCTION (a function returning
      // that type) can follow; a local declaration is naming a variable.
      return kw === "function" && !inFunction && !VAR_SCOPE_RE.test(lineText);
    default:
      if (!inFunction) return KW_TYPES.has(kw) || KW_SCOPE.has(kw);
      return !KW_SCOPE.has(kw) && !(inBlock && KW_TYPES.has(kw));
  }
}

/** FUNC0 argument kinds of a built-in, one per parameter (a final VARARG
 *  matches the "..." parameter), or undefined. */
function argKinds(f: FunctionInfo): string[] | undefined {
  const kinds = f.argTypes;
  return f.origin === "builtin" && kinds?.length === f.params?.length
    ? kinds
    : undefined;
}

/** Parameters as displayed: a by-reference argument (FUNC0 `var`) shows
 *  `var` before its type, a callback or any-type argument its kind. */
function displayParams(f: FunctionInfo): string[] {
  const kinds = argKinds(f);
  return (f.params || []).map((p, i) => {
    const k = kinds?.[i] ?? "";
    if (/^var /i.test(k)) return `var ${p}`;
    if (k === "FUNCTION" || k === "VARIANT") return `${k} ${p}`;
    return p;
  });
}

/** What the compiler requires of a built-in's argument beyond its type. */
export function argumentNote(f: FunctionInfo, index: number): string {
  const k = argKinds(f)?.[index] ?? "";
  if (/^var /i.test(k))
    return "By reference: pass a variable (a literal gives E2008 Tag expected).";
  if (k === "FUNCTION")
    return "The name of a Cicode INT function without parameters (not a built-in), without parentheses.";
  if (k === "VARIANT") return "Any type.";
  if (k === "VARARG") return "Any number of further arguments.";
  return "";
}

/** Signature line of a function, e.g. `INT Name(INT a)`, with the offsets
 *  of each parameter in it. A label macro has no type of its own: it
 *  expands to text. */
export function signatureParts(
  f: FunctionInfo,
  name = f.name,
): { label: string; params: [number, number][] } {
  let label = f.origin === "label" ? "label " : `${f.returnType || "VOID"} `;
  label += `${name}(`;
  const params: [number, number][] = [];
  displayParams(f).forEach((p, i) => {
    if (i) label += ", ";
    params.push([label.length, label.length + p.length]);
    label += p;
  });
  return { label: label + ")", params };
}

export function functionSignature(f: FunctionInfo, name = f.name): string {
  return signatureParts(f, name).label;
}

function isBuiltinFunction(f: FunctionInfo): boolean {
  return f.origin ? f.origin === "builtin" : f.file === null;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function makeCompletion(
  indexer: Indexer,
): vscode.CompletionItemProvider {
  // Cache completion items, rebuilt only when the indexer changes
  let cachedFuncItems:
    | { item: vscode.CompletionItem; f: FunctionInfo }[]
    | null = null;
  let cachedGlobalVarItems: vscode.CompletionItem[] | null = null;
  let cachedLabelItems: vscode.CompletionItem[] | null = null;
  const cachedModuleVarItems = new Map<
    string,
    { item: vscode.CompletionItem; v: VariableEntry }[]
  >();

  indexer.onIndexed(() => {
    cachedFuncItems = null;
    cachedGlobalVarItems = null;
    cachedLabelItems = null;
    cachedModuleVarItems.clear();
  });

  function makeFunctionItem(
    display: string,
    f: FunctionInfo,
  ): vscode.CompletionItem {
    const it = new vscode.CompletionItem(
      display,
      vscode.CompletionItemKind.Function,
    );
    it.insertText = display;
    it.detail = functionSignature(f, display);
    it.sortText = `${
      display.startsWith("_")
        ? SORT.INTERNAL_FUNC
        : isBuiltinFunction(f)
          ? SORT.BUILTIN_FUNC
          : SORT.USER_FUNC
    }${display}`;
    // Obsolete built-ins are errors (E2101), so never offered; deprecated
    // ones (W1008) are marked.
    if (f.obsolete && f.obsolete > 1) {
      it.tags = [vscode.CompletionItemTag.Deprecated];
    }

    if (f.doc || f.returns || f.expr) {
      const md = new vscode.MarkdownString();
      if (f.expr) md.appendMarkdown(`**Expands to:** \`${f.expr}\`\n\n`);
      if (f.doc) md.appendMarkdown(f.doc);
      if (f.returns) md.appendMarkdown(`\n\n**Returns:** ${f.returns}`);
      it.documentation = md;
    }
    return it;
  }

  function getFunctionItems(): {
    item: vscode.CompletionItem;
    f: FunctionInfo;
  }[] {
    if (!cachedFuncItems) {
      const userItems: { item: vscode.CompletionItem; f: FunctionInfo }[] = [];
      const builtinItems: typeof userItems = [];
      for (const [key, f] of indexer.getAllFunctions()) {
        if (f.obsolete === 1) continue;
        const entry = { item: makeFunctionItem(f.name || key, f), f };
        (isBuiltinFunction(f) ? builtinItems : userItems).push(entry);
      }
      cachedFuncItems = [...userItems, ...builtinItems];
    }
    return cachedFuncItems;
  }

  function makeVarItem(v: VariableEntry): vscode.CompletionItem {
    const it = new vscode.CompletionItem(
      v.name,
      vscode.CompletionItemKind.Variable,
    );
    it.detail = formatScopeType(v.scopeType, {
      includeType: true,
      type: v.type,
    });
    const prefix =
      v.scopeType === "local"
        ? SORT.LOCAL_VAR
        : v.scopeType === "module"
          ? SORT.MODULE_VAR
          : SORT.GLOBAL_VAR;
    it.sortText = `${prefix}${v.name}`;
    return it;
  }

  /** Build variable items for one scope category, deduplicated within it. */
  function buildVarItems(
    pred: (v: VariableEntry) => boolean,
  ): { item: vscode.CompletionItem; v: VariableEntry }[] {
    const out: { item: vscode.CompletionItem; v: VariableEntry }[] = [];
    const seen = new Set<string>();
    for (const v of indexer.getVariablesByPredicate(pred)) {
      const k = `${nameKey(v.name)}|${v.scopeType}|${v.scopeId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ item: makeVarItem(v), v });
    }
    return out;
  }

  /** A local or module variable is known only after its declaration (an
   *  earlier use is a tag reference, W1007); parameters everywhere. */
  const declaredBy = (v: VariableEntry, position: vscode.Position) =>
    v.isParam || !v.location || !v.location.range.start.isAfter(position);

  return {
    provideCompletionItems(document, position) {
      // No completions inside strings or comments
      if (isInCommentOrString(document, position)) return [];

      const ctx = detectContext(document, position);
      const wr = leftWordRangeAt(document, position);

      // Naming a new function or parameter: nothing useful to complete
      // (a keyword item would be committed by the "," or ")" ending the name)
      if (ctx === "funcdef" || ctx === "param") return [];

      const file = document.uri.fsPath;
      const { inFunction, inBlock } = blockContextAt(document, position);
      const lineText = document
        .lineAt(position.line)
        .text.slice(0, position.character);
      const items: vscode.CompletionItem[] = [];

      // Functions and variables only inside a function (at file scope an
      // initializer takes literals and labels only), and not when the user
      // is about to name something ("type"/"declaration") or format a value.
      const offerNames =
        inFunction &&
        ctx !== "type" &&
        ctx !== "declaration" &&
        ctx !== "format";

      if (offerNames) {
        for (const { item, f } of getFunctionItems()) {
          // The function a call from this file reaches: its own PRIVATE one
          // hides a PUBLIC one, and another file's PRIVATE one is invisible
          // (E2031), leaving a built-in of the name or nothing.
          const own = indexer.getFunctionFor(item.label as string, file);
          if (own === f) items.push(item);
          else if (own && own.obsolete !== 1)
            items.push(makeFunctionItem(item.label as string, own));
        }
      }

      // Keywords are case-insensitive; they are offered in upper case, the
      // AVEVA convention. Only those that can come next are listed.
      for (const kw of ALL_KEYWORDS) {
        if (!keywordFits(kw, ctx, inFunction, inBlock, lineText)) continue;

        const upper = kw.toUpperCase();
        const it = new vscode.CompletionItem(
          upper,
          vscode.CompletionItemKind.Keyword,
        );
        it.sortText = `${keywordSortPrefix(kw, ctx)}${kw}`;
        it.commitCharacters = [" ", "\t", "\n", "(", ")", ",", ";"];
        it.filterText = upper;
        it.command = {
          command: "cicode.addSpaceIfNeeded",
          title: "Add space if needed",
        };
        if (wr) it.range = wr;
        it.insertText = upper;
        items.push(it);
      }

      // Variables. Global and per-file module items are cached across
      // keystrokes (invalidated on reindex); locals are cheap and
      // position-dependent, so they are built per request.
      if (offerNames) {
        if (!cachedGlobalVarItems) {
          cachedGlobalVarItems = buildVarItems(
            (x) => x.scopeType === "global",
          ).map((e) => e.item);
        }
        for (const it of cachedGlobalVarItems) items.push(it);

        let moduleItems = cachedModuleVarItems.get(file);
        if (!moduleItems) {
          moduleItems = buildVarItems(
            (x) => x.scopeType === "module" && x.scopeId === file,
          );
          cachedModuleVarItems.set(file, moduleItems);
        }
        for (const { item, v } of moduleItems) {
          if (declaredBy(v, position)) items.push(item);
        }

        const current = indexer.findEnclosingFunction(document, position);
        if (current) {
          const localScopeId = indexer.localScopeId(file, current.name);
          for (const { item, v } of buildVarItems(
            (x) => x.scopeType === "local" && x.scopeId === localScopeId,
          )) {
            if (declaredBy(v, position)) items.push(item);
          }
        }
      }

      // Label constants from labels.DBF: the compiler substitutes them before
      // parsing, so one fits wherever its text does (even as a format width).
      if (ctx !== "type" && ctx !== "declaration") {
        if (!cachedLabelItems) {
          cachedLabelItems = [];
          for (const [, label] of indexer.getAllLabels()) {
            const it = new vscode.CompletionItem(
              label.name,
              vscode.CompletionItemKind.Constant,
            );
            it.detail = label.expr || undefined;
            it.sortText = `${SORT.LABEL}${label.name}`;
            if (label.comment) {
              it.documentation = new vscode.MarkdownString(label.comment);
            }
            cachedLabelItems.push(it);
          }
        }
        for (const it of cachedLabelItems) {
          if (
            ctx === "format" &&
            !FORMAT_LABEL_RE.test(String(it.detail ?? ""))
          )
            continue;
          // range is position-dependent; reassign on every request since
          // the cached items are reused across invocations
          it.range = wr;
          items.push(it);
        }
      }

      return items;
    },
  };
}
