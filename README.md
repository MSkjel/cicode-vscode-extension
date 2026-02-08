# Cicode for VS Code

A VS Code extension providing syntax highlighting, IntelliSense, and navigation for **Cicode**, the scripting language used in AVEVA Plant SCADA (Citect).

> **Disclaimer:** This project is not affiliated with or endorsed by AVEVA. It is a community-driven tool to improve the Cicode development experience in VS Code.

## Features

### Syntax Highlighting

Full syntax highlighting for `.ci` files including:

- Keywords, operators, and control flow
- Function declarations and calls
- Variables and type annotations
- Strings with escape sequences
- Comments (line `//`, `!`, `|` and block `/* */`)
- Doc comments ([Doxygen](https://www.doxygen.nl/manual/xmlcmds.html) XML commands with `/** **/` and `///` style)
- Format picture specifiers (`:###,##0.00`)

### IntelliSense

- **Autocompletion** for functions (built-in and user-defined)
- **Signature help** with parameter documentation
- **Hover information** showing function signatures and docs

### Navigation

- **Go to Definition** for functions and variables
- **Find All References** across your workspace
- **Rename Symbol** for variables and parameters
- **Document Outline** showing functions in the current file
- **Workspace Symbol Search** (`Ctrl+T`) to find any function

### Diagnostics

- Undefined function warnings
- Argument count validation
- Duplicate function detection
- Unused variable warnings
- Line length and indentation checks

### Formatting

- Basic code formatter with configurable options
- Consistent indentation for control blocks

### Built-in Functions

- Automatically parses function documentation from your Plant SCADA installation
- Falls back to packaged builtins if Plant SCADA is not installed
- Hover over built-in functions to see docs with a link to open the full help page

## Installation

1. Install from the VS Code Marketplace, or
2. Download the `.vsix` file and install via `Extensions: Install from VSIX...`

## Configuration

| Setting                                            | Default                                    | Description                                                                                                                                                             |
|----------------------------------------------------|--------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `cicode.avevaPath`                                 | `C:/Program Files (x86)/AVEVA Plant SCADA` | Path to AVEVA Plant SCADA installation. The extension auto-finds help files.                                                                                            |
| `cicode.diagnostics.enable`                        | `true`                                     | Enable diagnostics (undefined functions, duplicates)                                                                                                                    |
| `cicode.diagnostics.ignoredFunctions`              | `[]`                                       | Function names to exclude from checks                                                                                                                                   |
| `cicode.format.enable`                             | `true`                                     | Enable the code formatter                                                                                                                                               |
| `cicode.format.maxConsecutiveBlankLines`           | `1`                                        | Max blank lines to allow                                                                                                                                                |
| `cicode.hover.showHelpLink`                        | `true`                                     | Show "Open full help" link in hovers                                                                                                                                    |
| `cicode.indexing.excludeGlobs`                     | `["**/node_modules/**"]`                   | Patterns to exclude from indexing                                                                                                                                       |
| `cicode.lint.enable`                               | `true`                                     | Enable lint diagnostics                                                                                                                                                 |
| `cicode.lint.maxLineLength`                        | `140`                                      | Warn when lines exceed this length                                                                                                                                      |
| `cicode.lint.warnMixedIndent`                      | `true`                                     | Warn on mixed tabs/spaces                                                                                                                                               |
| `cicode.lint.warnUnusedVariables`                  | `true`                                     | Warn about unused variables                                                                                                                                             |
| `cicode.lint.warnMissingSemicolons`                | `true`                                     | Warn when declarations lack semicolons                                                                                                                                  |
| `cicode.lint.warnKeywordCase`                      | `false`                                    | Suggest uppercase keywords                                                                                                                                              |
| `cicode.lint.warnMagicNumbers`                     | `false`                                    | Warn about hardcoded numbers                                                                                                                                            |
| `cicode.documentation.docskeleton.useBlockComment` | `Block comment`                            | Style of comments used for the doc comment skeleton, where comments can either be surrounded by `/** ... */` or each line begins with `///`                             |
| `cicode.documentation.docskeleton.doxygenStyle`    | `XML Doxygen commands`                     | The style of doxygen commands to be used by the doc comment skeleton, which can be either XML style commands, Javadoc commands (`@`), or regular doxygen commands (`\`) |

## Commands

| Command                             | Description                                              |
| ----------------------------------- | -------------------------------------------------------- |
| `Cicode: Rebuild Builtin Functions` | Re-parse built-in functions from help files              |
| `Cicode: Reindex All Files`         | Rebuild the workspace index                              |
| `Cicode: Open Help for Symbol`      | Open AVEVA help page for the symbol under cursor         |
| `Cicode: Insert Doc Skeleton`       | Insert a doc comment template above the current function |

## Keybindings

| Key          | Command                                     |
| ------------ | ------------------------------------------- |
| `Ctrl+Alt+D` | Insert Doc Skeleton (when in a Cicode file) |

## Doc Comments

The extension supports both [Doxygen XML](https://www.doxygen.nl/manual/xmlcmds.html), and [regular Doxygen commands](https://www.doxygen.nl/manual/commands.html) doc comments for documenting your functions:

```cicode
// Example of XML style doc comment
/// <summary>
/// Calculates the area of a rectangle.
/// </summary>
/// <param name="width">The width of the rectangle.</param>
/// <param name="height">The height of the rectangle.</param>
/// <returns>The calculated area.</returns>
FUNCTION CalculateArea(REAL width, REAL height)
    RETURN width * height;
END
```

```cicode
// Example of Javadoc style doc comment
/**
 * @brief Calculates the area of a rectangle.
 * @param width The width of the rectangle.
 * @param height The height of the rectangle.
 * @returns The calculated area.
 */
FUNCTION CalculateArea(REAL width, REAL height)
    RETURN width * height;
END
```
Use `Ctrl+Alt+D` to automatically generate a doc skeleton for the function at your cursor.

The style of doc comment can be configured in the `cicode.documentation.docskeleton.useBlockComment` and `cicode.documentation.docskeleton.doxygenStyle` configuration options.
## Requirements

- VS Code 1.88.0 or higher
- For built-in function docs: AVEVA Plant SCADA installation (optional, packaged fallback available)

## Links

- [GitHub Repository](https://github.com/MSkjel/cicode-vscode-extension)
- [Report Issues](https://github.com/MSkjel/cicode-vscode-extension/issues)
