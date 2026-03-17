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
| `cicode.codeLens.enable`                           | `true`                                     | Show CodeLens references above function definitions                                                                                                                     |
| `cicode.diagnostics.enable`                        | `true`                                     | Enable diagnostics (undefined functions, duplicates)                                                                                                                    |
| `cicode.diagnostics.ignoredFunctions`              | `[]`                                       | Regex patterns for function names to exclude from undefined and argument count checks                                                                                   |
| `cicode.diagnostics.ignoredUndeclaredVariables`    | `[]`                                       | Regex patterns for variable names to exclude from the undeclared variable check                                                                                         |
| `cicode.diagnostics.warnInvalidTypes`              | `true`                                     | Warn when a variable or function is declared with a tag data type not valid in Cicode (e.g. `LONG`, `DIGITAL`, `BYTE`)                                                  |
| `cicode.diagnostics.warnUndeclaredVariables`       | `false`                                     | Warn about variables that are used but never declared                                                                                                                   |
| `cicode.format.enable`                             | `true`                                     | Enable the code formatter                                                                                                                                               |
| `cicode.format.maxConsecutiveBlankLines`           | `1`                                        | Max blank lines to allow                                                                                                                                                |
| `cicode.hover.showHelpLink`                        | `true`                                     | Show "Open full help" link in hovers                                                                                                                                    |
| `cicode.indexing.excludePatterns`                  | `[]`                                       | Regular expressions matched against workspace-relative file paths to exclude from indexing                                                                              |
| `cicode.lint.enable`                               | `true`                                     | Enable lint diagnostics                                                                                                                                                 |
| `cicode.lint.maxLineLength`                        | `160`                                      | Warn when lines exceed this length (0 = disable)                                                                                                                        |
| `cicode.lint.maxCallNestingDepth`                  | `5`                                        | Warn when function calls are nested deeper than this level (0 = disable)                                                                                                |
| `cicode.lint.maxBlockNestingDepth`                 | `6`                                        | Warn when control flow blocks are nested deeper than this level (0 = disable)                                                                                           |
| `cicode.lint.warnMixedIndent`                      | `true`                                     | Warn on mixed tabs/spaces                                                                                                                                               |
| `cicode.lint.warnUnusedVariables`                  | `true`                                     | Warn about unused variables                                                                                                                                             |
| `cicode.lint.warnMissingSemicolons`                | `true`                                     | Warn when declarations lack semicolons                                                                                                                                  |
| `cicode.lint.warnKeywordCase`                      | `false`                                    | Suggest uppercase keywords                                                                                                                                              |
| `cicode.lint.warnMagicNumbers`                     | `false`                                    | Warn about hardcoded numbers                                                                                                                                            |
| `cicode.documentation.docskeleton.useBlockComment` | `Block comment`                            | Style of comments used for the doc comment skeleton, where comments can either be surrounded by `/** ... */` or each line begins with `///`                             |
| `cicode.documentation.docskeleton.doxygenStyle`    | `XML Doxygen commands`                     | The style of Doxygen commands to be used by the doc comment skeleton, which can be either XML style commands, Javadoc commands (`@`), or regular Doxygen commands (`\`) |

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
## Debugger

The extension includes a debugger that lets you set breakpoints and inspect local variables in Cicode while a Plant SCADA runtime is running.

### Requirements

- AVEVA Plant SCADA must be running on the same machine
- The Cicode runtime must be running

### How to use

1. Open the **Run and Debug** panel (`Ctrl+Shift+D`)
2. Add a launch configuration of type **"Cicode: Attach to SCADA Runtime"** (VS Code will offer to add one automatically)
3. Click **Start Debugging** (or press `F5`)
4. Set breakpoints by clicking the gutter in any `.ci` file
5. Trigger the Cicode function in the runtime. Execution will pause at your breakpoint
6. Inspect local variables in the **Variables** panel
7. Use **Continue** (`F5`), **Step Over** (`F10`), **Step Into** (`F11`), or **Step Out** (`Shift+F11`) to control execution

### What it can do

- Set and remove breakpoints
- Conditional breakpoints with simple comparisons against local variables (e.g. `myVar == 5`, `myVar = "SomeCoolString"`)
- Pause at breakpoints and inspect local variable values
- Step over, into, and out of functions
- Show the current stopped location in the editor

### What it cannot do

- **Evaluate arbitrary expressions** or watch expressions
- **Modify variable values** at runtime
- **Complex conditions** in breakpoints (only simple `==`, `!=`, `<`, `>` comparisons against local variables)
- **Debug across multiple machines**
- **Pause the runtime**

> **Note:** Removing a breakpoint while execution is paused will take effect when you next continue. The debugger reconnects in the background to clear the runtime breakpoint.

## Requirements

- VS Code 1.88.0 or higher
- For built-in function docs: AVEVA Plant SCADA installation (optional, packaged fallback available)

## Links

- [GitHub Repository](https://github.com/MSkjel/cicode-vscode-extension)
- [Report Issues](https://github.com/MSkjel/cicode-vscode-extension/issues)
