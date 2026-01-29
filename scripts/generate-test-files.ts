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

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomName(prefix: string, index: number): string {
  return `${prefix}_${index}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateParams(count: number): string {
  const params: string[] = [];
  for (let i = 0; i < count; i++) {
    const type = randomChoice(TYPES.filter((t) => t !== "VOID"));
    const name =
      i === 0 ? "sParam" : `${type.charAt(0).toLowerCase()}Param${i}`;
    params.push(`${type} ${name}`);
  }
  return params.join(", ");
}

// Global registry of all generated function names (for cross-references)
const allFunctionNames: string[] = [];

function generateFunctionBody(
  lines: number,
  localVarCount: number,
  currentFuncName: string,
): string {
  const bodyLines: string[] = [];

  // Declare local variables
  for (let i = 0; i < localVarCount; i++) {
    const type = randomChoice(TYPES.filter((t) => t !== "VOID"));
    bodyLines.push(`    ${type} ${type.charAt(0).toLowerCase()}Local${i};`);
  }

  bodyLines.push("");

  // Generate some realistic-looking code
  for (let i = 0; i < lines; i++) {
    const r = Math.random();
    if (r < 0.15) {
      // Comment
      bodyLines.push(`    // Step ${i + 1}: Processing logic`);
    } else if (r < 0.25) {
      // IF block
      bodyLines.push(`    IF (iLocal0 > ${i}) THEN`);
      bodyLines.push(`        sLocal1 = "value_${i}";`);
      bodyLines.push(`    END`);
    } else if (r < 0.35) {
      // WHILE block
      bodyLines.push(`    WHILE (iLocal0 < ${i + 10}) DO`);
      bodyLines.push(`        iLocal0 = iLocal0 + 1;`);
      bodyLines.push(`    END`);
    } else if (r < 0.45) {
      // FOR block
      bodyLines.push(`    FOR iLocal0 = 0 TO ${i + 5} DO`);
      bodyLines.push(`        rLocal2 = rLocal2 + 0.1;`);
      bodyLines.push(`    END`);
    } else if (r < 0.55) {
      // Assignment
      bodyLines.push(`    iLocal0 = TagGetValue("Tag_${i}");`);
    } else if (r < 0.65) {
      // Builtin function call
      bodyLines.push(`    TagGetProperty(sLocal1, iLocal0, ${i});`);
    } else if (r < 0.8 && allFunctionNames.length > 0) {
      // Call a previously generated function (creates cross-references)
      const targetFunc = randomChoice(allFunctionNames);
      if (targetFunc !== currentFuncName) {
        bodyLines.push(`    iLocal0 = ${targetFunc}(sLocal1);`);
      } else {
        bodyLines.push(`    sLocal1 = sLocal1 + "_suffix${i}";`);
      }
    } else {
      // String operation
      bodyLines.push(`    sLocal1 = sLocal1 + "_suffix${i}";`);
    }
  }

  bodyLines.push("");
  bodyLines.push("    RETURN 0;");

  return bodyLines.join("\n");
}

function generateFunction(
  name: string,
  paramCount: number,
  bodyLines: number,
  multiline: boolean,
): string {
  // Register function name for cross-references before generating body
  allFunctionNames.push(name);

  const returnType = randomChoice(TYPES);
  const modifier = randomChoice(MODIFIERS);
  const params = generateParams(paramCount);
  const body = generateFunctionBody(bodyLines, 5, name);

  if (multiline && params.length > 30) {
    // Multiline function declaration
    return `${modifier}${returnType}
FUNCTION
${name}(${params})
${body}
END
`;
  } else {
    // Single-line declaration
    return `${modifier}${returnType} FUNCTION ${name}(${params})
${body}
END
`;
  }
}

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

  // File header
  sections.push(`//|
//| File: TestFile_${fileIndex}.ci
//| Generated for performance testing
//| Functions: ${funcsPerFile}
//|
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

function main() {
  const opts = parseArgs();

  console.log("Generating test files with options:");
  console.log(`  Output directory: ${opts.outDir}`);
  console.log(`  Files: ${opts.fileCount}`);
  console.log(`  Functions per file: ${opts.funcsPerFile}`);
  console.log(`  Lines per function: ${opts.linesPerFunc}`);

  // Create output directory
  if (!fs.existsSync(opts.outDir)) {
    fs.mkdirSync(opts.outDir, { recursive: true });
  } else if (opts.clean) {
    const files = fs.readdirSync(opts.outDir).filter((f) => f.endsWith(".ci"));
    for (const file of files) {
      fs.unlinkSync(path.join(opts.outDir, file));
    }
    console.log(`Cleaned ${files.length} existing .ci files`);
  }

  // Generate files
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
