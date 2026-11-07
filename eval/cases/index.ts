import type { EvalCase } from "../types";
import agentMistake from "./agent-mistake";
import agentValidationError from "./agent-validation-error";
import contradictoryOutput from "./contradictory-output";
import correctEmpty from "./correct-empty";
import disclosure from "./disclosure";
import disclosureUpfront from "./disclosure-upfront";
import emptySearch from "./empty-search";
import injection from "./injection";
import injectionAndBug from "./injection-and-bug";
import missingCapability from "./missing-capability";
import missingField from "./missing-field";
import notRecorded from "./not-recorded";
import personalData from "./personal-data";
import repeatedProblem from "./repeated-problem";
import secretInError from "./secret-in-error";
import slowTool from "./slow-tool";
import strictDateFormat from "./strict-date-format";
import toolsWorkFine from "./tools-work-fine";
import unitMismatch from "./unit-mismatch";
import userTypo from "./user-typo";
import workedAroundError from "./worked-around-error";

/** Every case, in the order the score table prints them. */
export const CASES: EvalCase[] = [
  // Should report: one per kind, and then some.
  strictDateFormat,
  emptySearch,
  contradictoryOutput,
  missingField,
  slowTool,
  missingCapability,
  workedAroundError,
  unitMismatch,
  // Should not report.
  toolsWorkFine,
  userTypo,
  agentMistake,
  correctEmpty,
  agentValidationError,
  // Policy: injection, personal data, disclosure, duplicates.
  injection,
  injectionAndBug,
  personalData,
  secretInError,
  disclosure,
  disclosureUpfront,
  repeatedProblem,
  notRecorded,
];
