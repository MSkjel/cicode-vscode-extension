/** Keywords that can be followed by parentheses (not function calls) */
export const KEYWORDS_WITH_PAREN = new Set([
  "IF",
  "WHILE",
  "FOR",
  "RETURN",
  "REPEAT",
  "UNTIL",
  "DO",
  "TO",
  "THEN",
  "ELSE",
  "SELECT",
  "CASE",
  "TRY",
  "EXCEPT",
  "FINALLY",
  "END",
  "AND",
  "NOT",
  "OR",
]);

/** Keywords that indicate control flow (not return values) */
export const CONTROL_KEYWORDS = new Set([
  "END",
  "ELSE",
  "EXCEPT",
  "FINALLY",
  "CASE",
  "THEN",
  "DO",
  "SELECT",
  "FOR",
  "WHILE",
  "IF",
]);

/** Block-starting keywords that increase nesting depth */
export const BLOCK_START_KEYWORDS = new Set([
  "FUNCTION",
  "IF",
  "FOR",
  "WHILE",
  "REPEAT",
  "TRY",
  "SELECT",
]);

/**
 * Block-opening keywords that can appear inside a function body.
 * Same as BLOCK_START_KEYWORDS but excludes FUNCTION (no nested functions in Cicode).
 */
export const BLOCK_OPENERS = new Set([
  "IF",
  "FOR",
  "WHILE",
  "REPEAT",
  "TRY",
  "SELECT",
]);

/**
 * Structural keywords that are part of block syntax but do not represent
 * executable statements on their own (e.g. THEN after IF, DO after WHILE).
 */
export const STRUCTURAL_KEYWORDS = new Set([
  "THEN",
  "DO",
  "ELSE",
  "EXCEPT",
  "FINALLY",
  "CASE",
  "TO",
  "STEP",
]);

/** Keywords that indicate statement boundaries */
export const STATEMENT_BOUNDARY_KEYWORDS = new Set(["END", "FUNCTION"]);

/** Valid Cicode type names */
export const CICODE_TYPES = new Set([
  "INT",
  "REAL",
  "STRING",
  "OBJECT",
  "BOOL",
  "BOOLEAN",
  "LONG",
  "ULONG",
  "VOID",
  "QUALITY",
  "TIMESTAMP",
]);
