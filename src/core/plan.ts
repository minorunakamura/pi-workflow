import { createHash } from "node:crypto";

import {
  hasOnlyKeys,
  invalidResult,
  isBoundedString,
  isNormalizedOpaqueId,
  isRecord,
  isSafeRelativePath,
  validResult,
  type ValidationResult,
} from "./validation.ts";
import {
  isValidArtifactRef,
  isValidPlanHashValue,
  isValidReviewId,
  isValidRunId,
  isValidWorkflowId,
  type ArtifactRef,
  type PlanHash,
  type PlanHashValue,
  type ReviewId,
  type RunId,
  type TestStrategy,
  type TddMode,
  type WorkflowId,
} from "./workflow.ts";

export const PLAN_ARTIFACT_FILE_NAME = "implementation-plan.md" as const;
export const PLANNING_HANDOFF_FILE_NAME = "planning-handoff.json" as const;
export const PLANNING_HANDOFF_KIND = "pi-workflow.planning-handoff" as const;

export interface PlanningArtifactReferences {
  readonly planArtifactRef: ArtifactRef;
  readonly planningHandoffRef: ArtifactRef;
}

export interface PlanningHandoff {
  readonly schemaVersion: 1;
  readonly kind: typeof PLANNING_HANDOFF_KIND;
  readonly workflowId: WorkflowId;
  readonly planArtifact: {
    readonly path: typeof PLAN_ARTIFACT_FILE_NAME;
    readonly mediaType: "text/markdown";
  };
  readonly planHash: PlanHash;
  readonly tddMode: TddMode;
  readonly testStrategy: TestStrategy;
  readonly testSeams: readonly string[];
  readonly constraints: readonly string[];
  readonly nonGoals: readonly string[];
  readonly planningRunId?: RunId;
}

export interface PlanningHandoffInput {
  workflowId: WorkflowId;
  planContent: string | Uint8Array;
  tddMode: TddMode;
  testStrategy: TestStrategy;
  testSeams: readonly string[];
  constraints: readonly string[];
  nonGoals: readonly string[];
  planningRunId?: RunId;
}

export interface ApprovalIdentity {
  readonly approvedPlanHash: PlanHashValue;
  readonly reviewId: ReviewId;
  readonly approval: true;
  readonly approvalFeedback?: string;
}

const MAX_ARRAY_ITEMS = 32;
const MAX_ARRAY_STRING_BYTES = 4096;
const MAX_FEEDBACK_BYTES = 16 * 1024;

function isTestStrategyKind(value: unknown): value is TestStrategy["kind"] {
  return (
    value === "unit" ||
    value === "integration" ||
    value === "mixed" ||
    value === "none"
  );
}

function artifactBaseName(path: string): string {
  const normalized = path.replace(/\\/gu, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function artifactDirectory(path: string): string {
  const normalized = path.replace(/\\/gu, "/");
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "" : normalized.slice(0, separator);
}

function isAbsoluteManagedArtifactPath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/u.test(value)
  );
}

function isRelativeManagedPath(value: string): boolean {
  return isSafeRelativePath(value);
}

function isManagedArtifactPath(value: unknown): value is string {
  if (!isBoundedString(value, 4096, true) || /[\0\r\n]/u.test(value)) {
    return false;
  }
  const pathValue = value;
  const relativePath = isRelativeManagedPath(pathValue);
  if (relativePath) return true;
  if (!isAbsoluteManagedArtifactPath(pathValue)) return false;
  return pathValue.split(/[\\/]/u).every((segment) => segment !== "..");
}

function copyArtifactRef(value: ArtifactRef): ArtifactRef {
  return { kind: value.kind, path: value.path, mediaType: value.mediaType };
}

function isPlanningArtifactReference(
  value: unknown,
  expectedFileName: string,
  expectedMediaType: ArtifactRef["mediaType"],
): value is ArtifactRef {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["kind", "path", "mediaType"]) &&
    value.kind === "managed" &&
    isManagedArtifactPath(value.path) &&
    value.mediaType === expectedMediaType &&
    artifactBaseName(value.path) === expectedFileName
  );
}

function validatePlanningArtifactReference(
  value: unknown,
  expectedFileName: string,
  expectedMediaType: ArtifactRef["mediaType"],
  label: string,
): ValidationResult<ArtifactRef> {
  if (
    !isPlanningArtifactReference(value, expectedFileName, expectedMediaType)
  ) {
    return invalidResult(`${label} reference is invalid`);
  }
  return validResult(copyArtifactRef(value));
}

export function validatePlanArtifactReference(
  value: unknown,
): ValidationResult<ArtifactRef> {
  return validatePlanningArtifactReference(
    value,
    PLAN_ARTIFACT_FILE_NAME,
    "text/markdown",
    "Plan Artifact",
  );
}

export function validatePlanningHandoffReference(
  value: unknown,
): ValidationResult<ArtifactRef> {
  return validatePlanningArtifactReference(
    value,
    PLANNING_HANDOFF_FILE_NAME,
    "application/json",
    "Planning Handoff",
  );
}

export function validatePlanningArtifactReferences(
  planArtifact: unknown,
  planningHandoff: unknown,
): ValidationResult<PlanningArtifactReferences> {
  const plan = validatePlanArtifactReference(planArtifact);
  const handoff = validatePlanningHandoffReference(planningHandoff);
  if (!plan.valid || !handoff.valid) {
    return invalidResult(
      ...(!plan.valid ? plan.errors : []),
      ...(!handoff.valid ? handoff.errors : []),
    );
  }
  if (
    artifactDirectory(plan.value.path) !== artifactDirectory(handoff.value.path)
  ) {
    return invalidResult(
      "Plan Artifact and Planning Handoff must share a directory",
    );
  }
  return validResult({
    planArtifactRef: plan.value,
    planningHandoffRef: handoff.value,
  });
}

function isTddMode(value: unknown): value is TddMode {
  return (
    value === "required" || value === "optional" || value === "not-applicable"
  );
}

export const REQUIRED_PLAN_HEADINGS = [
  "# Implementation Plan",
  "## Goal",
  "## Requirements",
  "## Non-goals",
  "## Constraints",
  "## Expected change areas",
  "## Implementation approach",
  "## TDD mode",
  "## Test strategy",
  "## Test seams",
  "## Verification",
  "## Trusted Gate expectations",
  "## Risks / assumptions",
] as const;

export function canonicalizePlan(content: string | Uint8Array): string {
  const text =
    typeof content === "string"
      ? content
      : new TextDecoder("utf-8", { fatal: true }).decode(content);
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const withLf = withoutBom.replace(/\r\n?/gu, "\n");
  return withLf.endsWith("\n") ? withLf : `${withLf}\n`;
}

export function validatePlanArtifactTemplate(
  content: string | Uint8Array,
): ValidationResult<true> {
  let canonical: string;
  try {
    canonical = canonicalizePlan(content);
  } catch {
    return invalidResult("Plan Artifact is not valid UTF-8");
  }
  const headings = new Set(
    canonical
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("#")),
  );
  const missing = REQUIRED_PLAN_HEADINGS.filter(
    (heading) => !headings.has(heading),
  );
  return missing.length === 0
    ? validResult(true)
    : invalidResult(`Plan Artifact is missing headings: ${missing.join(", ")}`);
}

export function hashPlan(content: string | Uint8Array): PlanHash {
  const canonical = canonicalizePlan(content);
  const value = createHash("sha256")
    .update(new TextEncoder().encode(canonical))
    .digest("hex");
  if (!isValidPlanHashValue(value)) {
    throw new TypeError("Plan hash is invalid");
  }
  return { algorithm: "SHA-256", encoding: "hex", value };
}

export function validatePlanHash(value: unknown): ValidationResult<PlanHash> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["algorithm", "encoding", "value"])
  ) {
    return invalidResult("Plan hash has unknown or missing fields");
  }
  if (
    value.algorithm !== "SHA-256" ||
    value.encoding !== "hex" ||
    !isValidPlanHashValue(value.value)
  ) {
    return invalidResult("Plan hash is invalid");
  }
  return validResult({
    algorithm: "SHA-256",
    encoding: "hex",
    value: value.value,
  });
}

function validateStringArray(
  value: unknown,
  fieldName: string,
): ValidationResult<string[]> {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) {
    return invalidResult(
      `${fieldName} must contain at most ${MAX_ARRAY_ITEMS} items`,
    );
  }
  const values: string[] = [];
  const errors: string[] = [];
  for (const [index, item] of value.entries()) {
    if (isBoundedString(item, MAX_ARRAY_STRING_BYTES)) {
      values.push(item);
    } else {
      errors.push(`${fieldName}[${index}] is too long or not a string`);
    }
  }
  return errors.length > 0 ? invalidResult(...errors) : validResult(values);
}

function validateTestStrategy(value: unknown): ValidationResult<TestStrategy> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["kind", "required", "summary"])
  ) {
    return invalidResult("Test strategy has unknown or missing fields");
  }
  const kind = value.kind;
  const required = value.required;
  const summary = value.summary;
  if (
    !isTestStrategyKind(kind) ||
    typeof required !== "boolean" ||
    !isBoundedString(summary, 8192)
  ) {
    return invalidResult("Test strategy is invalid");
  }
  return validResult({ kind, required, summary });
}

export function validatePlanningHandoff(
  value: unknown,
): ValidationResult<PlanningHandoff> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "kind",
      "workflowId",
      "planArtifact",
      "planHash",
      "tddMode",
      "testStrategy",
      "testSeams",
      "constraints",
      "nonGoals",
      "planningRunId",
    ])
  ) {
    return invalidResult("Planning Handoff has unknown or missing fields");
  }

  const planArtifact = value.planArtifact;
  const hash = validatePlanHash(value.planHash);
  const strategy = validateTestStrategy(value.testStrategy);
  const testSeams = validateStringArray(value.testSeams, "testSeams");
  const constraints = validateStringArray(value.constraints, "constraints");
  const nonGoals = validateStringArray(value.nonGoals, "nonGoals");
  if (
    value.schemaVersion !== 1 ||
    value.kind !== PLANNING_HANDOFF_KIND ||
    !isValidWorkflowId(value.workflowId) ||
    !isTddMode(value.tddMode) ||
    !isRecord(planArtifact) ||
    !hasOnlyKeys(planArtifact, ["path", "mediaType"]) ||
    planArtifact.path !== PLAN_ARTIFACT_FILE_NAME ||
    planArtifact.mediaType !== "text/markdown" ||
    !hash.valid ||
    !strategy.valid ||
    !testSeams.valid ||
    !constraints.valid ||
    !nonGoals.valid
  ) {
    return invalidResult(
      "Planning Handoff is invalid",
      ...(!hash.valid ? hash.errors : []),
      ...(!strategy.valid ? strategy.errors : []),
      ...(!testSeams.valid ? testSeams.errors : []),
      ...(!constraints.valid ? constraints.errors : []),
      ...(!nonGoals.valid ? nonGoals.errors : []),
    );
  }

  const base = {
    schemaVersion: 1 as const,
    kind: PLANNING_HANDOFF_KIND,
    workflowId: value.workflowId,
    planArtifact: {
      path: PLAN_ARTIFACT_FILE_NAME,
      mediaType: "text/markdown" as const,
    },
    planHash: hash.value,
    tddMode: value.tddMode,
    testStrategy: strategy.value,
    testSeams: testSeams.value,
    constraints: constraints.value,
    nonGoals: nonGoals.value,
  };
  if ("planningRunId" in value) {
    if (!isValidRunId(value.planningRunId)) {
      return invalidResult("Planning Handoff is invalid");
    }
    return validResult({ ...base, planningRunId: value.planningRunId });
  }
  return validResult(base);
}

function clonePlanningHandoff(value: PlanningHandoff): PlanningHandoff {
  const base = {
    schemaVersion: 1 as const,
    kind: PLANNING_HANDOFF_KIND,
    workflowId: value.workflowId,
    planArtifact: {
      path: PLAN_ARTIFACT_FILE_NAME,
      mediaType: "text/markdown" as const,
    },
    planHash: {
      algorithm: "SHA-256" as const,
      encoding: "hex" as const,
      value: value.planHash.value,
    },
    tddMode: value.tddMode,
    testStrategy: {
      kind: value.testStrategy.kind,
      required: value.testStrategy.required,
      summary: value.testStrategy.summary,
    },
    testSeams: [...value.testSeams],
    constraints: [...value.constraints],
    nonGoals: [...value.nonGoals],
  };
  return value.planningRunId === undefined
    ? base
    : { ...base, planningRunId: value.planningRunId };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function createImmutablePlanningHandoff(
  value: unknown,
): ValidationResult<PlanningHandoff> {
  const validation = validatePlanningHandoff(value);
  if (!validation.valid) {
    return validation;
  }
  return validResult(deepFreeze(clonePlanningHandoff(validation.value)));
}

export function createPlanningHandoff(
  input: PlanningHandoffInput,
): ValidationResult<PlanningHandoff> {
  try {
    const planHash = hashPlan(input.planContent);
    const base = {
      schemaVersion: 1 as const,
      kind: PLANNING_HANDOFF_KIND,
      workflowId: input.workflowId,
      planArtifact: {
        path: PLAN_ARTIFACT_FILE_NAME,
        mediaType: "text/markdown" as const,
      },
      planHash,
      tddMode: input.tddMode,
      testStrategy: input.testStrategy,
      testSeams: [...input.testSeams],
      constraints: [...input.constraints],
      nonGoals: [...input.nonGoals],
    };
    const value =
      input.planningRunId === undefined
        ? base
        : { ...base, planningRunId: input.planningRunId };
    return createImmutablePlanningHandoff(value);
  } catch {
    return invalidResult("Planning Handoff input is invalid");
  }
}

export function isPlanHashBound(
  handoff: unknown,
  currentPlanHash: unknown,
): boolean {
  const validation = validatePlanningHandoff(handoff);
  return (
    validation.valid &&
    isValidPlanHashValue(currentPlanHash) &&
    validation.value.planHash.value === currentPlanHash
  );
}

export function validatePlanHashBinding(
  handoff: unknown,
  currentPlanHash: unknown,
): ValidationResult<true> {
  return isPlanHashBound(handoff, currentPlanHash)
    ? validResult(true)
    : invalidResult("Plan hash does not match the Planning Handoff");
}

export function validatePlanningHandoffAgainstPlan(
  value: unknown,
  planContent: string | Uint8Array,
  workflowId?: unknown,
): ValidationResult<PlanningHandoff> {
  const handoff = validatePlanningHandoff(value);
  if (!handoff.valid) return handoff;
  if (
    workflowId !== undefined &&
    (!isValidWorkflowId(workflowId) || handoff.value.workflowId !== workflowId)
  ) {
    return invalidResult("Planning Handoff workflow identity does not match");
  }
  let planHash: PlanHash;
  try {
    planHash = hashPlan(planContent);
  } catch {
    return invalidResult("Plan Artifact cannot be hashed");
  }
  return handoff.value.planHash.value === planHash.value
    ? handoff
    : invalidResult("Planning Handoff is not bound to the Plan Artifact");
}

export function validateApprovalIdentity(
  value: unknown,
  currentPlanHash: unknown,
  handoff: unknown,
): ValidationResult<ApprovalIdentity> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "approvedPlanHash",
      "reviewId",
      "approval",
      "approvalFeedback",
    ])
  ) {
    return invalidResult("Approval Identity has unknown or missing fields");
  }
  const handoffValidation = validatePlanningHandoff(handoff);
  if (
    !handoffValidation.valid ||
    value.approval !== true ||
    !isValidReviewId(value.reviewId) ||
    !isValidPlanHashValue(value.approvedPlanHash) ||
    !isValidPlanHashValue(currentPlanHash)
  ) {
    return invalidResult("Approval Identity is not valid for the current plan");
  }
  const handoffPlanHash = handoffValidation.value.planHash.value;
  if (
    value.approvedPlanHash !== currentPlanHash ||
    handoffPlanHash !== currentPlanHash
  ) {
    return invalidResult("Approval Identity is not valid for the current plan");
  }
  const identity: ApprovalIdentity = {
    approvedPlanHash: value.approvedPlanHash,
    reviewId: value.reviewId,
    approval: true,
  };
  if ("approvalFeedback" in value) {
    if (!isBoundedString(value.approvalFeedback, MAX_FEEDBACK_BYTES)) {
      return invalidResult(
        "Approval Identity is not valid for the current plan",
      );
    }
    return validResult({
      ...identity,
      approvalFeedback: value.approvalFeedback,
    });
  }
  return validResult(identity);
}

export function isApprovalIdentityValid(
  value: unknown,
  currentPlanHash: unknown,
  handoff: unknown,
): boolean {
  return validateApprovalIdentity(value, currentPlanHash, handoff).valid;
}

export function isValidArtifactReference(value: unknown): value is ArtifactRef {
  return isValidArtifactRef(value);
}

export function isValidPlanningRunId(value: unknown): value is RunId {
  return isNormalizedOpaqueId(value);
}
