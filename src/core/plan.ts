import { createHash } from "node:crypto";

import {
  hasOnlyKeys,
  invalidResult,
  isBoundedString,
  isNormalizedOpaqueId,
  isRecord,
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

export function canonicalizePlan(content: string | Uint8Array): string {
  const text =
    typeof content === "string"
      ? content
      : new TextDecoder("utf-8", { fatal: true }).decode(content);
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const withLf = withoutBom.replace(/\r\n?/gu, "\n");
  return withLf.endsWith("\n") ? withLf : `${withLf}\n`;
}

export function hashPlan(content: string | Uint8Array): PlanHash {
  const canonical = canonicalizePlan(content);
  const value = createHash("sha256")
    .update(new TextEncoder().encode(canonical))
    .digest("hex") as PlanHashValue;
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
  return validResult(value as unknown as PlanHash);
}

function validateStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) {
    return [`${fieldName} must contain at most ${MAX_ARRAY_ITEMS} items`];
  }
  const errors = value.flatMap((item, index) =>
    isBoundedString(item, MAX_ARRAY_STRING_BYTES)
      ? []
      : [`${fieldName}[${index}] is too long or not a string`],
  );
  return errors;
}

function validateTestStrategy(value: unknown): ValidationResult<TestStrategy> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["kind", "required", "summary"])
  ) {
    return invalidResult("Test strategy has unknown or missing fields");
  }
  if (
    !["unit", "integration", "mixed", "none"].includes(value.kind as string) ||
    typeof value.required !== "boolean" ||
    !isBoundedString(value.summary, 8192)
  ) {
    return invalidResult("Test strategy is invalid");
  }
  return validResult(value as unknown as TestStrategy);
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
  const arrayErrors = [
    ...validateStringArray(value.testSeams, "testSeams"),
    ...validateStringArray(value.constraints, "constraints"),
    ...validateStringArray(value.nonGoals, "nonGoals"),
  ];
  if (
    value.schemaVersion !== 1 ||
    value.kind !== PLANNING_HANDOFF_KIND ||
    !isValidWorkflowId(value.workflowId) ||
    !["required", "optional", "not-applicable"].includes(
      value.tddMode as string,
    ) ||
    !isRecord(planArtifact) ||
    !hasOnlyKeys(planArtifact, ["path", "mediaType"]) ||
    planArtifact.path !== PLAN_ARTIFACT_FILE_NAME ||
    planArtifact.mediaType !== "text/markdown" ||
    !hash.valid ||
    !strategy.valid ||
    arrayErrors.length > 0 ||
    ("planningRunId" in value && !isValidRunId(value.planningRunId))
  ) {
    return invalidResult(
      "Planning Handoff is invalid",
      ...(!hash.valid ? hash.errors : []),
      ...(!strategy.valid ? strategy.errors : []),
      ...arrayErrors,
    );
  }

  return validResult(value as unknown as PlanningHandoff);
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

function handoffHash(value: unknown): unknown {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value) || !isRecord(value.planHash)) {
    return undefined;
  }
  return value.planHash.value;
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
  const handoffIsValid =
    typeof handoff === "string"
      ? isValidPlanHashValue(handoff)
      : validatePlanningHandoff(handoff).valid;
  const expectedHandoffHash = handoffIsValid ? handoffHash(handoff) : undefined;
  if (
    value.approval !== true ||
    !isValidPlanHashValue(value.approvedPlanHash) ||
    !isValidPlanHashValue(currentPlanHash) ||
    !isValidPlanHashValue(expectedHandoffHash) ||
    value.approvedPlanHash !== currentPlanHash ||
    value.approvedPlanHash !== expectedHandoffHash ||
    !isValidReviewId(value.reviewId) ||
    ("approvalFeedback" in value &&
      !isBoundedString(value.approvalFeedback, MAX_FEEDBACK_BYTES))
  ) {
    return invalidResult("Approval Identity is not valid for the current plan");
  }
  return validResult(value as unknown as ApprovalIdentity);
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
