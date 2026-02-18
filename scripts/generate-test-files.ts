/**
 * Generates test .ci files for performance and parsing tests.
 *
 * Usage:
 *   npx ts-node scripts/generate-test-files.ts [options]
 *
 * Options:
 *   --out <dir>       Output directory (default: ./test-fixtures)
 *   --files <n>       Number of files to generate (default: 10)
 *   --funcs <n>       Functions per file (default: 50)
 *   --lines <n>       Lines per function body (default: 20)
 *   --clean           Remove existing files in output directory first
 */

import * as fs from "fs";
import * as path from "path";

interface Options {
  outDir: string;
  fileCount: number;
  funcsPerFile: number;
  linesPerFunc: number;
  clean: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const opts: Options = {
    outDir: "./test-fixtures",
    fileCount: 10,
    funcsPerFile: 50,
    linesPerFunc: 20,
    clean: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--out":
        opts.outDir = args[++i];
        break;
      case "--files":
        opts.fileCount = parseInt(args[++i], 10);
        break;
      case "--funcs":
        opts.funcsPerFile = parseInt(args[++i], 10);
        break;
      case "--lines":
        opts.linesPerFunc = parseInt(args[++i], 10);
        break;
      case "--clean":
        opts.clean = true;
        break;
    }
  }
  return opts;
}

const TYPES = ["INT", "STRING", "REAL", "OBJECT", "VOID"];
const MODIFIERS = ["", "PRIVATE ", "PUBLIC "];

const DESCRIPTIONS = [
  "Processes the incoming data and updates the internal state.",
  "Validates the input parameters against configured limits.",
  "Reads the current value from the hardware device.",
  "Writes the specified value to the output channel.",
  "Calculates the scaled engineering value from raw counts.",
  "Checks the alarm state and triggers the appropriate response.",
  "Initialises the subsystem with default configuration values.",
  "Performs a controlled shutdown sequence for the server.",
  "^Logs the event to the alarm database^",
];

const PARAM_DESCRIPTIONS: Record<string, string> = {
  INT: "integer input value",
  STRING: "string identifier or tag name",
  REAL: "floating point measurement value",
  OBJECT: "handle to the target object",
  BOOL: "flag indicating enabled state",
};

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomName(prefix: string, index: number): string {
  return `${prefix}_${index}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateParams(count: number): Array<{ type: string; name: string }> {
  const params: Array<{ type: string; name: string }> = [];
  for (let i = 0; i < count; i++) {
    const type = randomChoice(TYPES.filter((t) => t !== "VOID"));
    const name =
      i === 0 ? "sParam" : `${type.charAt(0).toLowerCase()}Param${i}`;
    params.push({ type, name });
  }
  return params;
}

// Global registry of all generated function names (for cross-references)
const allFunctionNames: string[] = [];

// ---------------------------------------------------------------------------
// Comment generators
// ---------------------------------------------------------------------------

function generateDocComment(
  name: string,
  params: Array<{ type: string; name: string }>,
  returnType: string,
): string {
  const lines: string[] = [];
  const desc = randomChoice(DESCRIPTIONS);

  lines.push("/**");
  lines.push(` * ${desc}`);

  // Randomly add a description paragraph
  if (Math.random() < 0.4) {
    lines.push(` *`);
    lines.push(
      ` * This function is part of the ${name.split("_")[0]} subsystem`,
    );
  }

  if (params.length > 0) {
    lines.push(` *`);
    for (const p of params) {
      const pdesc = PARAM_DESCRIPTIONS[p.type] ?? "parameter value";
      lines.push(` * @param ${p.name} - The ${pdesc}.`);
    }
  }

  if (returnType !== "VOID") {
    lines.push(` *`);
    lines.push(
      ` * @return ${PARAM_DESCRIPTIONS[returnType] ?? "result value"}.`,
    );
  }

  lines.push(` */`);
  return lines.join("\n");
}

function generateMultilineBlockComment(indent: string): string {
  const topics = [
    [
      "NOTE: This section handles edge cases where the hardware may",
      "return invalid data during startup or communication loss.",
    ],
    ["TODO: Refactor this logic once the new API is available."],
    [
      "WORKAROUND: The device firmware v2.1 has a bug where rapid",
      "successive reads can corrupt the internal state. Adding a",
      "small delay here resolves the issue until patched.",
    ],
    [
      "This algorithm was originally implemented in",
      "the legacy PLC.",
      "Could be improved but behaviour must remain identical.",
    ],
  ];

  const topic = randomChoice(topics);
  const lines: string[] = [];
  lines.push(`${indent}/*`);
  for (const line of topic) {
    lines.push(`${indent} * ${line}`);
  }
  lines.push(`${indent} */`);
  return lines.join("\n");
}

function generateCommentedOutBlock(indent: string, varName: string): string {
  // A realistic chunk of commented-out code
  const blocks = [
    [
      `// Disabled. old polling approach replaced by event-driven model`,
      `// WHILE (${varName} < 100) DO`,
      `//     ${varName} = TagGetValue("PollTag");`,
      `//     Sleep(10);`,
      `// END`,
    ],
    [
      `// Legacy validation removed after requirements change (v3.2)`,
      `// IF (${varName} < 0) OR (${varName} > 9999) THEN`,
      `//     TraceMsg("Range check failed: " + IntToStr(${varName}));`,
      `//     RETURN -1;`,
      `// END`,
    ],
    [
      `// Debug output — remove before production deployment`,
      `// TraceMsg("${varName} = " + IntToStr(${varName}));`,
      `// TraceMsg("Stack depth: " + IntToStr(StackDepth()));`,
    ],
    [
      `/* Old retry logic — superseded by WatchdogRetry helper`,
      ` * INT iRetry;`,
      ` * FOR iRetry = 0 TO 3 DO`,
      ` *     IF WriteTag("OutputTag", ${varName}) = 0 THEN`,
      ` *         BREAK;`,
      ` *     END`,
      ` * END`,
      ` */`,
    ],
  ];

  const block = randomChoice(blocks);
  return block.map((l) => `${indent}${l}`).join("\n");
}

// ---------------------------------------------------------------------------
// Body generator
// ---------------------------------------------------------------------------

function generateFunctionBody(
  lines: number,
  localVarCount: number,
  currentFuncName: string,
): string {
  const bodyLines: string[] = [];
  const indent = "    ";

  // Declare local variables
  const localVars: string[] = [];
  for (let i = 0; i < localVarCount; i++) {
    const type = randomChoice(TYPES.filter((t) => t !== "VOID"));
    const varName = `${type.charAt(0).toLowerCase()}Local${i}`;
    localVars.push(varName);
    bodyLines.push(`${indent}${type} ${varName};`);
  }

  // Ensure we always have at least iLocal0 and sLocal1 for templates
  if (!localVars.includes("iLocal0")) localVars.push("iLocal0");
  if (!localVars.includes("sLocal1")) localVars.push("sLocal1");

  bodyLines.push("");

  let i = 0;
  while (i < lines) {
    const r = Math.random();

    if (r < 0.08) {
      // Single-line comment
      bodyLines.push(`${indent}// Step ${i + 1}: Processing logic`);
      i++;
    } else if (r < 0.13) {
      // Multiline block comment
      bodyLines.push(generateMultilineBlockComment(indent));
      i += 2;
    } else if (r < 0.18) {
      // Commented-out code block
      const vn = randomChoice(localVars);
      bodyLines.push(generateCommentedOutBlock(indent, vn));
      i += 3;
    } else if (r < 0.27) {
      // IF/ELSE block
      bodyLines.push(`${indent}IF (iLocal0 > ${i}) THEN`);
      bodyLines.push(`${indent}    sLocal1 = "value_${i}";`);
      if (Math.random() < 0.4) {
        bodyLines.push(`${indent}ELSE`);
        bodyLines.push(`${indent}    sLocal1 = "default";`);
      }
      bodyLines.push(`${indent}END`);
      i += 3;
    } else if (r < 0.34) {
      // WHILE block
      bodyLines.push(`${indent}WHILE (iLocal0 < ${i + 10}) DO`);
      bodyLines.push(`${indent}    iLocal0 = iLocal0 + 1;`);
      bodyLines.push(`${indent}END`);
      i += 3;
    } else if (r < 0.41) {
      // FOR block
      bodyLines.push(`${indent}FOR iLocal0 = 0 TO ${i + 5} DO`);
      bodyLines.push(`${indent}    rLocal2 = rLocal2 + 0.1;`);
      bodyLines.push(`${indent}END`);
      i += 3;
    } else if (r < 0.47) {
      // REPEAT/UNTIL
      bodyLines.push(`${indent}REPEAT`);
      bodyLines.push(`${indent}    iLocal0 = iLocal0 + 1;`);
      bodyLines.push(`${indent}UNTIL (iLocal0 >= ${i + 5});`);
      i += 3;
    } else if (r < 0.54) {
      // SELECT CASE
      const caseVal = randomInt(0, 3);
      bodyLines.push(`${indent}SELECT CASE (iLocal0)`);
      bodyLines.push(`${indent}CASE ${caseVal}:`);
      bodyLines.push(`${indent}    sLocal1 = "case_${caseVal}";`);
      bodyLines.push(`${indent}CASE ${caseVal + 1}:`);
      bodyLines.push(`${indent}    sLocal1 = "case_${caseVal + 1}";`);
      bodyLines.push(`${indent}CASE ELSE:`);
      bodyLines.push(`${indent}    sLocal1 = "unknown";`);
      bodyLines.push(`${indent}END SELECT`);
      i += 5;
    } else if (r < 0.6) {
      // Assignment with tag read
      bodyLines.push(`${indent}iLocal0 = TagGetValue("Tag_${i}");`);
      i++;
    } else if (r < 0.76) {
      // Builtin function call
      bodyLines.push(`${indent}TagGetProperty(sLocal1, iLocal0, ${i});`);
      i++;
    } else if (r < 0.88 && allFunctionNames.length > 0) {
      // Call a previously generated function (cross-reference)
      const targetFunc = randomChoice(allFunctionNames);
      if (targetFunc !== currentFuncName) {
        bodyLines.push(`${indent}iLocal0 = ${targetFunc}(sLocal1);`);
      } else {
        bodyLines.push(`${indent}sLocal1 = sLocal1 + "_suffix${i}";`);
      }
      i++;
    } else {
      // String operation
      bodyLines.push(`${indent}sLocal1 = sLocal1 + "_suffix${i}";`);
      i++;
    }
  }

  bodyLines.push("");
  bodyLines.push(`${indent}RETURN 0;`);

  return bodyLines.join("\n");
}

// ---------------------------------------------------------------------------
// Function generator
// ---------------------------------------------------------------------------

function generateFunction(
  name: string,
  paramCount: number,
  bodyLines: number,
  multiline: boolean,
): string {
  allFunctionNames.push(name);

  const returnType = randomChoice(TYPES);
  const modifier = randomChoice(MODIFIERS);
  const params = generateParams(paramCount);
  const paramStr = params.map((p) => `${p.type} ${p.name}`).join(", ");
  const body = generateFunctionBody(bodyLines, 5, name);
  const doc = generateDocComment(name, params, returnType);

  let header: string;
  if (multiline && paramStr.length > 30) {
    // Multiline function declaration
    header = `${modifier}${returnType}\nFUNCTION\n${name}(${paramStr})`;
  } else {
    header = `${modifier}${returnType} FUNCTION ${name}(${paramStr})`;
  }

  return `${doc}\n${header}\n${body}\nEND\n`;
}

// ---------------------------------------------------------------------------
// File generator
// ---------------------------------------------------------------------------

function generateModuleVariables(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const type = randomChoice(TYPES.filter((t) => t !== "VOID"));
    lines.push(`${type} m_${type.charAt(0).toLowerCase()}Module${i};`);
  }
  return lines.join("\n");
}

function generateFile(
  fileIndex: number,
  funcsPerFile: number,
  linesPerFunc: number,
): string {
  const sections: string[] = [];

  // File header block comment
  sections.push(`/*
 * File: TestFile_${fileIndex}.ci
 * Generated for performance testing
 * Functions: ${funcsPerFile}
 *
 * This file is auto-generated and should not be manually edited.
 * It is used to validate indexer performance and reference caching.
 */
`);

  // Module variables
  sections.push(generateModuleVariables(10));
  sections.push("");

  // Functions
  for (let f = 0; f < funcsPerFile; f++) {
    const name = randomName(`TestFunc${fileIndex}`, f);
    const paramCount = Math.floor(Math.random() * 5) + 1;
    const multiline = Math.random() < 0.3;
    sections.push(generateFunction(name, paramCount, linesPerFunc, multiline));
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs();

  console.log("Generating test files with options:");
  console.log(`  Output directory: ${opts.outDir}`);
  console.log(`  Files: ${opts.fileCount}`);
  console.log(`  Functions per file: ${opts.funcsPerFile}`);
  console.log(`  Lines per function: ${opts.linesPerFunc}`);

  if (!fs.existsSync(opts.outDir)) {
    fs.mkdirSync(opts.outDir, { recursive: true });
  } else if (opts.clean) {
    const files = fs.readdirSync(opts.outDir).filter((f) => f.endsWith(".ci"));
    for (const file of files) {
      fs.unlinkSync(path.join(opts.outDir, file));
    }
    console.log(`Cleaned ${files.length} existing .ci files`);
  }

  let totalFuncs = 0;
  let totalLines = 0;

  for (let i = 0; i < opts.fileCount; i++) {
    const content = generateFile(i, opts.funcsPerFile, opts.linesPerFunc);
    const filename = `TestFile_${i.toString().padStart(3, "0")}.ci`;
    const filepath = path.join(opts.outDir, filename);
    fs.writeFileSync(filepath, content);

    totalFuncs += opts.funcsPerFile;
    totalLines += content.split("\n").length;

    if ((i + 1) % 10 === 0 || i === opts.fileCount - 1) {
      console.log(`  Generated ${i + 1}/${opts.fileCount} files...`);
    }
  }

  console.log("\nDone!");
  console.log(`  Total files: ${opts.fileCount}`);
  console.log(`  Total functions: ${totalFuncs}`);
  console.log(`  Total lines: ~${totalLines}`);
  console.log(`\nFiles written to: ${path.resolve(opts.outDir)}`);
}

main();
