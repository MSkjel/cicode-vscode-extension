import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import type { ScopeType } from "../../shared/types";
import { isInCommentOrString, leftWordRangeAt } from "../../shared/textUtils";
import { CICODE_TYPES_PATTERN } from "../../shared/constants";
import { formatScopeType } from "../../shared/utils";

// ---------------------------------------------------------------------------
// Keyword categories
// ---------------------------------------------------------------------------

const KW_CONTROL_FLOW = new Set([
  "for",
  "while",
  "if",
  "repeat",
  "do",
  "select",
  "case",
]);

const KW_CONTROL = new Set([
  "then",
  "else",
  "end",
  "end select",
  "to",
  "until",
  "break",
  "continue",
  "return",
  "exit",
  "abort",
  "goto",
  "raise",
  "try",
  "except",
  "finally",
]);

const KW_TYPES = new Set([
  "int",
  "real",
  "string",
  "object",
  "boolean",
  "void",
  "long",
  "ulong",
  "quality",
  "timestamp",
]);

const KW_SCOPE = new Set(["module", "global", "function", "private"]);

const KW_OPERATORS = new Set([
  "and",
  "or",
  "not",
  "mod",
  "bitand",
  "bitor",
  "bitxor",
]);

const KW_OTHER = new Set([]);

/** All keywords in a single iterable for the completion loop. */
const ALL_KEYWORDS = [
  ...KW_CONTROL_FLOW,
  ...KW_CONTROL,
  ...KW_TYPES,
  ...KW_SCOPE,
  ...KW_OPERATORS,
  ...KW_OTHER,
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
} as const;

// ---------------------------------------------------------------------------
// Context detection
// ---------------------------------------------------------------------------

type CursorContext =
  | "statement"
  | "expression"
  | "type"
  | "declaration"
  | "funcdef"
  | "default";

// "declaration": after TYPE_KW + space + at least one identifier char being typed
// e.g. "INT i", "REAL myV", "STRING s"
const DECL_RE = new RegExp(`\\b(?:${CICODE_TYPES_PATTERN})\\s+\\w+$`, "i");

// "funcdef": after FUNCTION keyword + space (+ optional chars being typed as function name)
// e.g. "FUNCTION foo", "INT FUNCTION My"
const FUNCDEF_RE = /\bFUNCTION\s+\w*$/i;

const TYPE_KW_RE = new RegExp(`\\b(?:${CICODE_TYPES_PATTERN})\\s*$`, "i");
const EXPR_TAIL_RE = /[=+\-*/<>!&|^(,]\s*$/;
const STATEMENT_RE = /^[\t ]*\w*$/; // only whitespace + possibly the word being typed

function detectContext(
  document: vscode.TextDocument,
  position: vscode.Position,
): CursorContext {
  const lineText = document
    .lineAt(position.line)
    .text.slice(0, position.character);

  // Most specific checks first
  if (DECL_RE.test(lineText)) return "declaration";
  if (FUNCDEF_RE.test(lineText)) return "funcdef";
  if (TYPE_KW_RE.test(lineText)) return "type";
  if (EXPR_TAIL_RE.test(lineText)) return "expression";
  if (STATEMENT_RE.test(lineText)) {
    // Multiline function declaration: if the previous non-empty line ends with
    // the FUNCTION keyword (e.g. "INT FUNCTION\nMyFunc|"), the cursor is in
    // the function-name position even though the current line looks like a statement.
    for (let i = position.line - 1; i >= Math.max(0, position.line - 3); i--) {
      const prev = document.lineAt(i).text.trim();
      if (!prev) continue; // skip blank lines
      if (/\bFUNCTION\s*$/i.test(prev)) return "funcdef";
      break; // first non-blank line is not a funcdef continuation
    }
    return "statement";
  }
  return "default";
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
  if (KW_OPERATORS.has(kw)) {
    return ctx === "expression" ? SORT.KW_HIGH : SORT.KW_LOW;
  }
  // KW_OTHER
  return SORT.KW_LOW;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function makeCompletion(
  indexer: Indexer,
): vscode.CompletionItemProvider {
  // Cache function completion items — rebuilt only when the indexer changes
  let cachedUserFuncItems: vscode.CompletionItem[] | null = null;
  let cachedBuiltinFuncItems: vscode.CompletionItem[] | null = null;

  indexer.onIndexed(() => {
    cachedUserFuncItems = null;
    cachedBuiltinFuncItems = null;
  });

  function buildFunctionItems(): void {
    const userItems: vscode.CompletionItem[] = [];
    const builtinItems: vscode.CompletionItem[] = [];
    for (const [key, f] of indexer.getAllFunctions()) {
      const display = f.name || key;
      const signature = `${f.returnType || "VOID"} ${display}(${(f.params || []).join(", ")})`;
      const it = new vscode.CompletionItem(
        display,
        vscode.CompletionItemKind.Function,
      );
      it.insertText = display;
      it.detail = signature;

      const isBuiltin = f.file === null;
      it.sortText = `${isBuiltin ? SORT.BUILTIN_FUNC : SORT.USER_FUNC}${display}`;

      if (f.doc || f.returns) {
        const md = new vscode.MarkdownString();
        if (f.doc) md.appendMarkdown(f.doc);
        if (f.returns) md.appendMarkdown(`\n\n**Returns:** ${f.returns}`);
        it.documentation = md;
      }

      if (isBuiltin) {
        builtinItems.push(it);
      } else {
        userItems.push(it);
      }
    }
    cachedUserFuncItems = userItems;
    cachedBuiltinFuncItems = builtinItems;
  }

  function getFunctionItems(): vscode.CompletionItem[] {
    if (!cachedUserFuncItems || !cachedBuiltinFuncItems) buildFunctionItems();
    return [...cachedUserFuncItems!, ...cachedBuiltinFuncItems!];
  }

  return {
    provideCompletionItems(document, position) {
      // No completions inside strings or comments
      if (isInCommentOrString(document, position)) return [];

      const ctx = detectContext(document, position);
      const wr = leftWordRangeAt(document, position);

      // Naming a new function — nothing useful to complete
      if (ctx === "funcdef") return [];

      const items: vscode.CompletionItem[] = [];

      // Functions — skip when the user is about to name something
      // ("type": right after a type kw; "declaration": type kw + partial identifier,
      //  e.g. "INT F" should still show FUNCTION keyword but not existing functions)
      if (ctx !== "type" && ctx !== "declaration") {
        items.push(...getFunctionItems());
      }

      // Keywords always uppercase in Cicode, filtered by context
      for (const kw of ALL_KEYWORDS) {
        // Hide keywords that are irrelevant in the current context
        if (ctx === "expression") {
          // In expressions only operators are useful; control flow, scope, and
          // type keywords are never valid inside an expression
          if (
            KW_CONTROL_FLOW.has(kw) ||
            KW_CONTROL.has(kw) ||
            KW_SCOPE.has(kw) ||
            KW_TYPES.has(kw)
          )
            continue;
        } else if (ctx === "statement") {
          // At line-start, operator keywords (AND, OR, NOT) are never valid
          if (KW_OPERATORS.has(kw)) continue;
        } else if (ctx === "type" || ctx === "declaration") {
          // After a type keyword (with or without a partial name typed),
          // only FUNCTION is meaningful. e.g. "INT F" suggest "FUNCTION"
          if (kw !== "function") continue;
        }

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

      // Variables, skip when the user is about to name something
      if (ctx !== "type" && ctx !== "declaration") {
        const file = document.uri.fsPath;
        const current = indexer.findEnclosingFunction(document, position);
        const seen = new Set<string>();
        const pushVar = (v: {
          name: string;
          type: string;
          scopeType: ScopeType;
          scopeId: string;
        }) => {
          const k = `${v.name}|${v.scopeType}|${v.scopeId}`;
          if (seen.has(k)) return;
          seen.add(k);
          const detail = formatScopeType(v.scopeType, {
            includeType: true,
            type: v.type,
          });
          const it = new vscode.CompletionItem(
            v.name,
            vscode.CompletionItemKind.Variable,
          );
          it.detail = detail;
          const prefix =
            v.scopeType === "local"
              ? SORT.LOCAL_VAR
              : v.scopeType === "module"
                ? SORT.MODULE_VAR
                : SORT.GLOBAL_VAR;
          it.sortText = `${prefix}${v.name}`;
          items.push(it);
        };

        // Single pass through variables with compound predicate
        const localScopeId = current
          ? indexer.localScopeId(file, current.name)
          : null;
        for (const v of indexer.getVariablesByPredicate(
          (x) =>
            (x.scopeType === "local" &&
              localScopeId &&
              x.scopeId === localScopeId) ||
            (x.scopeType === "module" && x.scopeId === file) ||
            x.scopeType === "global",
        ))
          pushVar(v);
      }

      // Label constants from labels.DBF
      if (ctx !== "type" && ctx !== "declaration") {
        for (const [, label] of indexer.getAllLabels()) {
          const it = new vscode.CompletionItem(
            label.name,
            vscode.CompletionItemKind.Constant,
          );
          it.detail = label.expr || undefined;
          it.sortText = `1_${label.name}`;
          if (label.comment) {
            it.documentation = new vscode.MarkdownString(label.comment);
          }
          if (wr) it.range = wr;
          items.push(it);
        }
      }

      return items;
    },
  };
}
