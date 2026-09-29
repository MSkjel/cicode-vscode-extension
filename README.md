# Cicode for VS Code

A VS Code extension providing syntax highlighting, IntelliSense, and navigation for **Cicode**, the scripting language used in AVEVA Plant SCADA (Citect).

> **Disclaimer:** This project is not affiliated with or endorsed by AVEVA. It is a community-driven tool to improve the Cicode development experience in VS Code.

The extension follows what the Plant SCADA compiler (CtCmp32) actually accepts, which is not always what the documentation says: keywords are case-insensitive, strings may span lines, a semicolon is never required, there is no `ELSE IF` (an `ELSE` holding a nested `IF` that needs its own `END`), and labels from `labels.DBF` are substituted before anything else, so a label hides a function or variable of the same name.

## Features

### Syntax Highlighting

Full syntax highlighting for `.ci` files including:

- Keywords (in any case), operators, and control flow
- Function declarations and calls, with built-in, AVEVA library and user functions told apart by semantic highlighting
- Labels from `labels.DBF` (such as `TRUE`, `FALSE` and `Print(...)` from the Include project)
- Strings with `^` escapes, also across lines
- Comments (line `//` and `!`, block `/* */`)
- Doc comments ([Doxygen](https://www.doxygen.nl/manual/xmlcmds.html) XML commands with `/** */` and `///` style)
- Format pictures after `:` (`:###.##`, `:#0##`, `:###EU`), and the width shortforms `:5` and `:-5.2`
- Names with the letters of the Windows-1252 code page (`nTempø`) and `\`

### IntelliSense

- **Autocompletion** for functions (built-in, AVEVA library and your own), variables, labels and keywords. Only what can come next is offered: no statements outside a function, no `FUNCTION`/`GLOBAL`/`MODULE` inside one, no declaration types inside an `IF`/`WHILE`/`FOR`/`SELECT` block, after the format operator `:` only labels that expand to a width, and local and module variables only after their declaration. `PRIVATE` functions of other files are left out, obsolete built-ins are hidden and deprecated ones are struck through. Internal `_` functions (`_PageGoto`, `_TimeSub`, ...) are listed last.
- **Signature help** with parameter documentation. By-reference arguments are shown as `var` (they need a variable, not a value), and callback arguments as `FUNCTION` (the name of a Cicode `INT` function without parameters).
- **Hover information** showing function signatures, label expansions and docs
- **Inlay hints** with parameter names at call sites

### Navigation

- **Go to Definition** for functions and variables
- **Find All References** across your workspace (names ignore the case of ASCII letters, as in Cicode; a variable in scope hides a function of the same name)
- **Rename Symbol** for functions, variables and parameters. Keywords, labels, built-ins and tags cannot be renamed, and the new name must be a valid Cicode name that is not a reserved word or a label.
- **Document Outline** showing functions in the current file
- **Workspace Symbol Search** (`Ctrl+T`) to find any function
- **CodeLens** reference counts above function definitions
- **Folding** of functions, `IF`/`WHILE`/`FOR`/`SELECT` blocks (per `ELSE` and `CASE`) and comment blocks

### Diagnostics

- Unknown functions, wrong argument counts, calls to obsolete built-ins and to `PRIVATE` functions of other files, duplicate functions, invalid declarations and types
- Where the compiler reports the same problem, the diagnostic carries its error code and wording (for example `E2022 Incorrect number of arguments for function`)
- Unused variables, and optionally names that are not declared (the compiler treats those as variable tags)
- Style checks: line length, mixed indentation, keyword case, missing semicolons, nesting depth

### Formatting

- Indents by the block structure the compiler sees (`END IF x THEN` is an `END` and a new `IF`, `END` and `SELECT` may be on separate lines, `ELSE IF` chains are kept flat)
- Continuation lines and argument lists keep their own layout and move with their statement
- Never changes strings (including multi-line ones) or the layout of block comments
- Collapses runs of blank lines

### Built-in Functions

- Built-in functions come from the compiler's own function table, `Bin\FUNC0.DBF` of your Plant SCADA installation: names, return and argument types, exact argument counts, and obsolete flags. Without an installation, a copy shipped with the extension is used.
- Functions that the documentation lists but that are really Cicode in AVEVA's library projects, and the function-like labels of the Include project, are known too.
- Descriptions and parameter docs are read from the local AVEVA help; hover over a function to see them, with a link to open the full help page.
- The Include project, which the compiler adds to every project, is found automatically, so its functions and labels (`TRUE`, `FALSE`, `Print(...)`, ...) are known even when it is not part of your workspace. Set `cicode.indexing.includeProjectPath` if it is somewhere else.

### Projects and Includes

- Every file is checked against what the compiler compiles with it: its project, the projects in its `include.DBF` (recursively) and the Include project. The extension climbs from a project to every top-level project that includes it, so a library also sees the functions, labels and GLOBALs of the projects that include it and of their other includes.
- Projects that are never compiled together don't affect each other: no duplicate-definition errors between them, and completion, hover, go to definition, references and rename stay within the projects compiled together.
- A duplicate function or GLOBAL is reported where the compiler reports it: at the definition compiled later.
- Project names are resolved through the `MASTER.DBF` of the User folder above the workspace, from `cicode.avevaPath` or from the installed versions. Included projects outside the workspace are read from disk, so opening a single project is enough; they are never checked, and rename refuses their definitions.

## Installation

1. Install from the VS Code Marketplace, or
2. Download the `.vsix` file and install via `Extensions: Install from VSIX...`

## Configuration

| Setting                                            | Default                                    | Description                                                                                                                                                             |
|----------------------------------------------------|--------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `cicode.avevaPath`                                 | `C:/Program Files (x86)/AVEVA Plant SCADA` | Path to the Plant SCADA installation. The compiler's function table (`Bin\FUNC0.DBF`) and the help files are found from it.                                             |
| `cicode.helpServerUrl`                             | `https://localhost:28808`                  | Root URL of the local AVEVA help server (Product Help Viewer Service, 2023 R2 and later), used to open help pages                                                      |
| `cicode.indexing.includeProjectPath`               | `""`                                       | Folder of the Include project (or its `labels.DBF`). Empty: found automatically from the workspace's User folder, `cicode.avevaPath` or the installed Plant SCADA versions               |
| `cicode.indexing.excludePatterns`                  | `[]`                                       | Regular expressions matched against workspace-relative file paths to exclude from indexing                                                                              |
| `cicode.signatureOverrides`                        | `[]`                                       | Extra or replacement function signatures, e.g. `"STRING MyDllFunc(STRING s, [INT n])"`. Only needed for functions the compiler's table doesn't know                  |
| `cicode.codeLens.enable`                           | `true`                                     | Show CodeLens references above function definitions                                                                                                                    |
| `cicode.hover.showHelpLink`                        | `true`                                     | Show "Open full help" link in hovers                                                                                                                                    |
| `cicode.explorer.expandFolders`                    | `true`                                     | Expand folders by default in the Cicode Explorer                                                                                                                        |
| `cicode.diagnostics.enable`                        | `true`                                     | Enable diagnostics (unknown functions, argument counts, duplicates)                                                                                                     |
| `cicode.diagnostics.ignoredFunctions`              | `[]`                                       | Regex patterns for function names to exclude from unknown-function and argument count checks                                                                            |
| `cicode.diagnostics.ignoredUndeclaredVariables`    | `[]`                                       | Regex patterns for variable names to exclude from the undeclared variable check                                                                                         |
| `cicode.diagnostics.warnInvalidTypes`              | `true`                                     | Report declarations whose type is not one of the six Cicode types (`INT`, `REAL`, `STRING`, `OBJECT`, `QUALITY`, `TIMESTAMP`), e.g. tag types such as `LONG`           |
| `cicode.diagnostics.warnUndeclaredVariables`       | `false`                                    | Warn about names that are not declared (the compiler reads them as variable tags, which the extension does not index)                                                  |
| `cicode.diagnostics.warnDeclarationsInBlocks`      | `true`                                     | Report variable declarations inside `IF`/`WHILE`/`FOR`/`SELECT` blocks, which the compiler rejects                                                                      |
| `cicode.format.enable`                             | `true`                                     | Enable the code formatter                                                                                                                                               |
| `cicode.format.maxConsecutiveBlankLines`           | `1`                                        | Max blank lines to allow                                                                                                                                                |
| `cicode.lint.enable`                               | `true`                                     | Enable lint diagnostics                                                                                                                                                 |
| `cicode.lint.maxLineLength`                        | `160`                                      | Warn when lines exceed this length (0 = disable)                                                                                                                        |
| `cicode.lint.maxCallNestingDepth`                  | `5`                                        | Warn when function calls are nested deeper than this level (0 = disable)                                                                                                |
| `cicode.lint.maxBlockNestingDepth`                 | `6`                                        | Warn when control flow blocks are nested deeper than this level (0 = disable)                                                                                           |
| `cicode.lint.warnMixedIndent`                      | `true`                                     | Warn on mixed tabs/spaces                                                                                                                                               |
| `cicode.lint.warnUnusedVariables`                  | `true`                                     | Warn about unused variables                                                                                                                                             |
| `cicode.lint.warnMissingSemicolons`                | `true`                                     | Hint when declarations lack semicolons (style only; the compiler never requires one)                                                                                    |
| `cicode.lint.warnKeywordCase`                      | `false`                                    | Suggest uppercase keywords (style only; keywords are case-insensitive)                                                                                                  |
| `cicode.lint.warnMagicNumbers`                     | `false`                                    | Warn about hardcoded numbers                                                                                                                                            |
| `cicode.documentation.docskeleton.useBlockComment` | `Block comment`                            | Style of comments used for the doc comment skeleton, where comments can either be surrounded by `/** ... */` or each line begins with `///`                             |
| `cicode.documentation.docskeleton.doxygenStyle`    | `Javadoc style (@)`                        | The style of Doxygen commands to be used by the doc comment skeleton, which can be either XML style commands, Javadoc commands (`@`), or regular Doxygen commands (`\`) |

## Commands

| Command                             | Description                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `Cicode: Rebuild Builtin Functions` | Re-read the compiler's function table and re-scan the AVEVA help for descriptions |
| `Cicode: Reindex All Files`         | Rebuild the workspace index                                                         |
| `Cicode: Open Help for Symbol`      | Open AVEVA help page for the symbol under cursor                                    |
| `Cicode: Insert Doc Skeleton`       | Insert a doc comment template above the current function                            |

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
REAL FUNCTION CalculateArea(REAL width, REAL height)
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
REAL FUNCTION CalculateArea(REAL width, REAL height)
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

- Set and remove breakpoints (also while paused; other paused tasks stay paused)
- Conditional breakpoints with simple comparisons against local variables (e.g. `myVar == 5`, `myVar = "SomeCoolString"`, `sName contains Pump`)
- Pause at breakpoints and inspect local variable values, per task, including several tasks paused at once
- Step over, into, and out of functions
- **Pause**: the runtime stops at the next Cicode statement a background task executes
- **Break on Cicode hardware errors** (e.g. `Tag not found`): the task stops at the failing statement and the error code, message and function are shown. Untick **Cicode hardware errors** under *Breakpoints* to only log the errors to the Debug Console and let the tasks carry on
- Evaluate expressions in the Debug Console (run through CtAPI); hovering a local variable shows its value. A function called from the Debug Console stops at its breakpoints like any other task; the console gives up waiting for its result after 5 seconds
- Show the current stopped location in the editor, and kernel output in the Debug Console

### What it cannot do

- **Modify variable values** at runtime
- **Complex conditions** in breakpoints (only simple comparisons against local variables)
- **Debug across multiple machines**
- **Debug foreground Cicode** (page animations and the like): the runtime does not suspend it
- **Debug Cicode in more than one process**: each runtime component (Client, IOServer, Alarm, Report, Trend) runs in its own process, and only one of them accepts the debugger, by default the **Client**. Set `[Debug]CodeDebug` to `IOServer`, `Alarm`, `Report` or `Trend` (or `<Cluster>.<Component>`, e.g. `Cluster1.IOServer`) in `citect.ini` and restart the runtime to debug another component. The Debug Console says which process you are attached to.
- **Share the runtime with another debugger**: while the Cicode Editor (or another VS Code window) is attached, the attach is refused

## Requirements

- VS Code 1.88.0 or higher
- For the compiler's function table and the function docs: an AVEVA Plant SCADA installation (optional; without one, the shipped copy of the function table and docs is used)

## Links

- [GitHub Repository](https://github.com/MSkjel/cicode-vscode-extension)
- [Report Issues](https://github.com/MSkjel/cicode-vscode-extension/issues)
