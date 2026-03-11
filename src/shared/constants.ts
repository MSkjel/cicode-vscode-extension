/** Keywords that can be followed by parentheses (not function calls) */
export const KEYWORDS_WITH_PAREN = new Set([
  "IF",
  "WHILE",
  "FOR",
  "RETURN",
  "DO",
  "TO",
  "THEN",
  "ELSE",
  "SELECT",
  "CASE",
  "END",
  "AND",
  "NOT",
  "OR",
  "IS",
]);

/** Keywords that indicate control flow (not return values) */
export const CONTROL_KEYWORDS = new Set([
  "END",
  "ELSE",
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
  "SELECT",
]);

/**
 * Block-opening keywords that can appear inside a function body.
 * Same as BLOCK_START_KEYWORDS but excludes FUNCTION (no nested functions in Cicode).
 */
export const BLOCK_OPENERS = new Set(["IF", "FOR", "WHILE", "SELECT"]);

/**
 * Structural keywords that are part of block syntax but do not represent
 * executable statements on their own (e.g. THEN after IF, DO after WHILE).
 */
export const STRUCTURAL_KEYWORDS = new Set([
  "THEN",
  "DO",
  "ELSE",
  "CASE",
  "TO",
  "IS",
]);

/** Keywords that indicate statement boundaries */
export const STATEMENT_BOUNDARY_KEYWORDS = new Set(["END", "FUNCTION"]);

/** Scope and flow keywords that are not variables or function calls */
export const MISC_KEYWORDS = new Set([
  // Storage modifiers
  "GLOBAL",
  "MODULE",
  "PRIVATE",
  "PUBLIC",
  // Operator keywords
  "AND",
  "OR",
  "NOT",
  "MOD",
  "BITAND",
  "BITOR",
  "BITXOR",
  // Literals
  "TRUE",
  "FALSE",
]);

/** Valid Cicode type names */
export const CICODE_TYPES = new Set([
  "INT",
  "REAL",
  "STRING",
  "OBJECT",
  "VOID",
  "QUALITY",
  "TIMESTAMP",
  "BOOLEAN",
]);

/** Pipe-separated pattern of all valid Cicode types, for use in RegExp */
export const CICODE_TYPES_PATTERN = [...CICODE_TYPES].join("|");
