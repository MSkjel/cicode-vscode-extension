import * as vscode from "vscode";
import type { Indexer } from "../../core/indexer/indexer";
import { leftWordRangeAt } from "../../shared/textUtils";

const CI_KEYWORDS = [
  "function",
  "if",
  "then",
  "else",
  "do",
  "to",
  "until",
  "goto",
  "break",
  "continue",
  "exit",
  "abort",
  "raise",
  "return",
  "try",
  "except",
  "finally",
  "select",
  "case",
  "end",
  "end select",
  "repeat",
  "while",
  "for",
  "and",
  "or",
  "not",
  "mod",
  "bitand",
  "bitor",
  "bitxor",
  "module",
  "global",
  "boolean",
  "int",
  "real",
  "void",
  "long",
  "ulong",
  "string",
  "object",
  "quality",
  "timestamp",
];

function matchCasing(src: string, sample: string) {
  if (!sample) return src;
  const allUpper = /^[A-Z_]+$/.test(sample);
  const allLower = /^[a-z_]+$/.test(sample);
  if (allUpper) return src.toUpperCase();
  if (allLower) return src.toLowerCase();
  return /^[A-Z]/.test(sample)
    ? src[0].toUpperCase() + src.slice(1).toLowerCase()
    : src;
}

export function makeCompletion(
  indexer: Indexer,
): vscode.CompletionItemProvider {
  return {
    provideCompletionItems(document, position) {
      const items: vscode.CompletionItem[] = [];
      for (const [key, f] of indexer.getAllFunctions()) {
        const display = f.name || key;
        const signature = `${f.returnType || "VOID"} ${display}(${(f.params || []).join(", ")})`;
        const it = new vscode.CompletionItem(
          display,
          vscode.CompletionItemKind.Function,
        );
        it.insertText = display;
        it.detail = signature;
        it.sortText = `0_${display}`;
        if (f.doc || f.returns) {
          const md = new vscode.MarkdownString();
          if (f.doc) md.appendMarkdown(f.doc);
          if (f.returns) md.appendMarkdown(`\n\n**Returns:** ${f.returns}`);
          it.documentation = md;
        }
        items.push(it);
      }

      const wr = leftWordRangeAt(document, position);
      const typed = wr ? document.getText(wr) : "";
      for (const kw of CI_KEYWORDS) {
        const text = matchCasing(kw, typed);
        const it = new vscode.CompletionItem(
          text,
          vscode.CompletionItemKind.Keyword,
        );
        it.sortText = `0A_${kw}`;
        it.commitCharacters = [" ", "\t", "\n", "(", ")", ",", ";"];
        it.filterText = kw;
        it.command = {
          command: "cicode.addSpaceIfNeeded",
          title: "Add space if needed",
        };
        if (wr) it.range = wr;
        it.insertText = text;
        items.push(it);
      }

      const file = document.uri.fsPath;
      const current = (indexer as any).findEnclosingFunction(
        document,
        position,
      );
      const seen = new Set<string>();
      const pushVar = (v: any) => {
        const k = `${v.name}|${v.scopeType}|${v.scopeId}`;
        if (seen.has(k)) return;
        seen.add(k);
        const detail =
          v.scopeType === "global"
            ? `Global ${v.type}`
            : v.scopeType === "module"
              ? `Module ${v.type}`
              : `Local ${v.type}`;
        const it = new vscode.CompletionItem(
          v.name,
          vscode.CompletionItemKind.Variable,
        );
        it.detail = detail;
        it.sortText = `1_${v.name}`;
        items.push(it);
      };

      if (current) {
        for (const v of indexer.getVariablesByPredicate(
          (x) =>
            x.scopeType === "local" &&
            x.scopeId === (indexer as any).localScopeId(file, current.name),
        ))
          pushVar(v);
      }
      for (const v of indexer.getVariablesByPredicate(
        (x) => x.scopeType === "module" && x.scopeId === file,
      ))
        pushVar(v);
      for (const v of indexer.getVariablesByPredicate(
        (x) => x.scopeType === "global",
      ))
        pushVar(v);

      return items;
    },
  };
}
