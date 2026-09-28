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

// Name characters as the compiler reads them: letters of the ANSI code page
// (cp1252, as the code points its bytes decode to), `_`, digits and `\`.

/** RegExp class body: characters that can start a name (ASCII and cp1252 letters, `_`) */
export const NAME_START_CHARS =
  "A-Za-z_\\u00AA\\u00B5\\u00BA\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u00FF\\u0152\\u0153\\u0160\\u0161\\u0178\\u017D\\u017E\\u0192";

/** RegExp class body: characters inside a name (start characters, digits incl. ² ³ ¹, `\`) */
export const NAME_CHARS = `${NAME_START_CHARS}0-9\\u00B2\\u00B3\\u00B9\\\\`;

/** RegExp source matching one name, e.g. `nTempø` or `a\b` */
export const NAME_PATTERN = `[${NAME_START_CHARS}][${NAME_CHARS}]*`;

/** The compiler's reserved words (case-insensitive). LOCAL, TRUE and FALSE are not among them. */
export const RESERVED_WORDS = new Set([
  "AND",
  "BITAND",
  "BITOR",
  "BITXOR",
  "CASE",
  "CICODE",
  "CIVBA",
  "DO",
  "ELSE",
  "END",
  "FOR",
  "FUNCTION",
  "GLOBAL",
  "IF",
  "INT",
  "IS",
  "MOD",
  "MODULE",
  "NOP",
  "NOT",
  "OBJECT",
  "OR",
  "PRIVATE",
  "PUBLIC",
  "QUALITY",
  "REAL",
  "RETURN",
  "SELECT",
  "STRING",
  "THEN",
  "TIMESTAMP",
  "TO",
  "VAR",
  "WHILE",
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

/** Symbol operators that indicate an expression continues on the next line */
export const SYMBOL_CONTINUATION_RE = /[+\-*\/,]/;

/** Word operators that indicate an expression continues on the next line */
export const WORD_CONTINUATION_OPS = new Set([
  "AND",
  "OR",
  "NOT",
  "MOD",
  "BITAND",
  "BITOR",
  "BITXOR",
]);

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

/**
 * Labels from the Include project's labels.DBF (TRUE = 1, FALSE = 0). Not
 * keywords: every project compiles with them, so they are known even when
 * the Include folder is not in the workspace.
 */
export const INCLUDE_BOOL_LABELS = new Set(["TRUE", "FALSE"]);

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
 * Tag data types, and VOID from built-in signatures. None of them is a
 * Cicode type: the compiler never takes them as a declaration type.
 */
export const TAG_ONLY_TYPES = new Set([
  "VOID",
  "LONG",
  "ULONG",
  "BYTE",
  "DIGITAL",
  "UINT",
  "BCD",
  "LONGBCD",
]);

/**
 * All recognized type names (Cicode + tag-only), for parsing.
 * BOOLEAN is included so declarations using it are still parsed; it is not a
 * Cicode type either, and the invalidTypes rule flags it like the tag-only types.
 */
export const ALL_TYPES = new Set([
  ...CICODE_TYPES,
  ...TAG_ONLY_TYPES,
  "BOOLEAN",
]);

/** Pipe-separated pattern of all recognized types, for use in RegExp */
export const CICODE_TYPES_PATTERN = [...ALL_TYPES].join("|");

// Not inside a longer name or right after a digit, so `0x1F` yields no name `x1F`
const NAME_START = `(?<![${NAME_CHARS}])`;

/** Matches function call syntax: identifier followed by "(" */
export const CALL_RE = new RegExp(`${NAME_START}(${NAME_PATTERN})\\s*\\(`, "g");

/** Matches any identifier token (with capture group) */
export const TOKEN_RE = new RegExp(`${NAME_START}(${NAME_PATTERN})`, "g");

/** Matches a variable declaration line */
export const DECLARATION_LINE_RE = new RegExp(
  `^\\s*(?:(?:GLOBAL|MODULE)\\s+)?(?:${[...CICODE_TYPES].join("|")})\\s+(?!FUNCTION(?![${NAME_CHARS}]))${NAME_PATTERN}`,
  "i",
);
