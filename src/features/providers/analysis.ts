import { cleanParamName } from "../../shared/textUtils";

export interface Token {
  kind: string;
  value: string;
  start: number;
  end: number;
}
export interface FunctionInfo {
  name: string;
  returnType: string;
  params: string[];
  start: number;
  end: number;
  returns: boolean;
}
export interface CallInfo {
  name: string;
  args: string[];
  start: number;
  end: number;
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /\w+|".*?"|'.*?'|\/\/.*|\/\*[\s\S]*?\*\/|[()=,;+*/-]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)))
    tokens.push({
      kind: "raw",
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  return tokens;
}

export function analyze(text: string): {
  functions: FunctionInfo[];
  calls: CallInfo[];
  errors: string[];
} {
  const tokens = tokenize(text);
  const functions: FunctionInfo[] = [];
  const calls: CallInfo[] = [];
  const errors: string[] = [];

  const blockStack: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];

    if (/^function$/i.test(t.value)) {
      const prev = tokens[i - 1];
      const returnType =
        prev && /^[A-Za-z]+$/.test(prev.value)
          ? prev.value.toUpperCase()
          : "VOID";
      const nameTok = tokens[i + 1];
      const name = nameTok?.value ?? "?";
      let params: string[] = [];
      const lpar = tokens.findIndex((tt, j) => j > i && tt.value === "(");
      const rpar = tokens.findIndex((tt, j) => j > lpar && tt.value === ")");
      if (lpar !== -1 && rpar !== -1) {
        const paramSlice = tokens
          .slice(lpar + 1, rpar)
          .map((tk) => tk.value)
          .join("");
        params = paramSlice.split(",").map(cleanParamName).filter(Boolean);
      }
      functions.push({
        name,
        returnType,
        params,
        start: t.start,
        end: t.end,
        returns: false,
      });
      i = rpar + 1;
      continue;
    }

    if (
      /^IF$/i.test(t.value) ||
      /^FOR$/i.test(t.value) ||
      /^WHILE$/i.test(t.value) ||
      /^REPEAT$/i.test(t.value) ||
      (/^SELECT$/i.test(t.value) &&
        tokens[i + 1]?.value.toUpperCase() === "CASE")
    )
      blockStack.push(t.value.toUpperCase());
    if (/^END$/i.test(t.value) || /^UNTIL$/i.test(t.value)) {
      if (!blockStack.length)
        errors.push(`Extra closing block at offset ${t.start}`);
      else blockStack.pop();
    }

    if (/^RETURN$/i.test(t.value) && functions.length)
      functions[functions.length - 1].returns = true;

    if (/^[A-Za-z_]\w*$/.test(t.value) && tokens[i + 1]?.value === "(") {
      const lpar = i + 1;
      let depth = 1;
      let j = lpar + 1;
      let args: string[] = [];
      let current = "";
      while (j < tokens.length && depth > 0) {
        const v = tokens[j].value;
        if (v === "(") {
          depth++;
          current += v;
        } else if (v === ")") {
          depth--;
          if (depth === 0) {
            args.push(current.trim());
            break;
          }
          current += v;
        } else if (v === "," && depth === 1) {
          args.push(current.trim());
          current = "";
        } else current += v;
        j++;
      }
      calls.push({
        name: t.value,
        args,
        start: t.start,
        end: tokens[j]?.end ?? t.end,
      });
      i = j;
      continue;
    }

    i++;
  }

  if (blockStack.length)
    errors.push(`Unbalanced blocks: ${blockStack.length} unterminated`);
  return { functions, calls, errors };
}
