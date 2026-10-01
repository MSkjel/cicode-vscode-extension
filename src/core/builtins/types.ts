import type { FunctionOrigin } from "../../shared/types";

export interface BuiltinFunction {
  name: string;
  returnType: string;
  params: string[];
  doc: string;
  returns?: string;
  paramDocs?: Record<string, string>;
  /** Local Flare help filename, e.g. "AlarmAckRec.html" (2020/Flare installs). */
  helpPath?: string;
  /** Author-it portal topic id, e.g. "1033446" (2023 R2). */
  helpId?: string;
  /** builtin = compiler's built-in table, cicode = library .ci source, label = function-like label. */
  origin?: FunctionOrigin;
  /** Compiler FLAGS: 1 = obsolete (E2101), 2-4 = deprecated (W1008-W1010). */
  obsolete?: number;
  /** Exact argument bounds when known; maxArgs -1 = any number. */
  minArgs?: number;
  maxArgs?: number;
  /** Compiler argument kinds per parameter: a type, "var <type>" (by reference), FUNCTION, VARIANT or a final VARARG. */
  argTypes?: string[];
  /** Label macro expansion (origin "label"). */
  expr?: string;
  /** AVEVA library project that defines a cicode or label entry, e.g. "Include". */
  library?: string;
}
