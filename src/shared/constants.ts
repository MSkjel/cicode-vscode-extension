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
  "MOD",
  "BITAND",
  "BITOR",
  "BITXOR",
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

/** Regex matching any block-opening keyword */
export const BLOCK_OPENER_RE = new RegExp(
  `\\b(${[...BLOCK_START_KEYWORDS].join("|")})\\b`,
  "gi",
);

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

/** Types valid in Cicode variable and function declarations */
export const CICODE_TYPES = new Set([
  "INT",
  "REAL",
  "STRING",
  "OBJECT",
  "QUALITY",
  "TIMESTAMP",
]);

/**
 * Tag data types. Valid in tag definitions and built-in signatures,
 * but NOT valid in Cicode variable or function declarations.
 */
export const TAG_ONLY_TYPES = new Set([
  "LONG",
  "ULONG",
  "BYTE",
  "DIGITAL",
  "UINT",
  "BCD",
  "LONGBCD",
  "VOID",
  "BOOLEAN",
]);

/** All recognized type names (Cicode + tag-only), for parsing/highlighting */
export const ALL_TYPES = new Set([...CICODE_TYPES, ...TAG_ONLY_TYPES]);

/** Pipe-separated pattern of all recognized types, for use in RegExp */
export const CICODE_TYPES_PATTERN = [...ALL_TYPES].join("|");

/** Matches function call syntax: identifier followed by "(" */
export const CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;

/** Matches any identifier token (with capture group) */
export const TOKEN_RE = /\b([A-Za-z_]\w*)\b/g;

/** Matches any identifier token (no capture group) */
export const WORD_RE = /\b[A-Za-z_]\w*\b/g;

/** Matches a variable declaration line */
export const DECLARATION_LINE_RE = new RegExp(
  `^\\s*(?:(?:GLOBAL|MODULE)\\s+)?(?:${[...CICODE_TYPES].join("|")})\\s+(?!FUNCTION\\b)\\w+`,
  "i",
);
