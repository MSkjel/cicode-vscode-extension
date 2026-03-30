import type { Rule } from "../rule";
import { functionCallsRule } from "./functionCalls";
import { functionDefsRule } from "./functionDefs";
import { controlFlowRule } from "./controlFlow";
import { returnTypeRule } from "./returnType";
import { unusedVarsRule } from "./unusedVars";
import { undeclaredVarsRule } from "./undeclaredVars";
import { unreachableCodeRule } from "./unreachableCode";
import { invalidTypesRule } from "./invalidTypes";
import {
  lineLengthRule,
  mixedIndentRule,
  missingSemicolonRule,
  keywordCaseRule,
  magicNumbersRule,
  callNestingRule,
  blockNestingRule,
} from "./lint";
import { invalidDeclarationsRule } from "./invalidDeclarations";

/**
 * All registered diagnostic rules.
 */
export const ALL_RULES: Rule[] = [
  // Validation (always-on when diagnostics are enabled)
  functionCallsRule,
  functionDefsRule,
  controlFlowRule,
  returnTypeRule,
  unreachableCodeRule,
  invalidTypesRule,

  // Configurable checks
  unusedVarsRule,
  undeclaredVarsRule,

  // Lint rules
  lineLengthRule,
  mixedIndentRule,
  missingSemicolonRule,
  keywordCaseRule,
  magicNumbersRule,
  callNestingRule,
  blockNestingRule,
  invalidDeclarationsRule,
];
