import {
  validatePlanningArtifactReferences,
  type ApprovalIdentity,
} from "./plan.ts";
import {
  validateReadyForMergeResult,
  type ReadyForMergeResult,
} from "./readiness.ts";
import {
  hasOnlyKeys,
  invalidResult,
  isBoundedString,
  isRecord,
  validResult,
  type ValidationResult,
} from "./validation.ts";
import {
  TIMEOUTS,
  isValidArtifactRef,
  isValidPlanHashValue,
  isValidReviewId,
  isValidWorkflowId,
  isWorkflowType,
  validateCodeReviewResultSummary,
  type ArtifactRef,
  type CodeReviewResultSummary,
  type WorkflowId,
  type WorkflowType,
} from "./workflow.ts";

export const IMPLEMENTATION_COORDINATOR_CONTRACT_VERSION = 1 as const;

const ARTIFACT_REF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { const: "managed" },
    path: { type: "string", minLength: 1, maxLength: 4096 },
    mediaType: {
      type: "string",
      enum: ["text/markdown", "application/json", "text/plain", "text/x-diff"],
    },
  },
  required: ["kind", "path", "mediaType"],
} as const;

export const IMPLEMENTATION_COORDINATOR_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    contractVersion: { type: "integer", const: 1 },
    workflowId: { type: "string", minLength: 1, maxLength: 128 },
    status: { type: "string", enum: ["COMPLETED", "FAILED", "CANCELLED"] },
    trustedGateSummaryRef: ARTIFACT_REF_SCHEMA,
    findingDispositionSummaryRef: ARTIFACT_REF_SCHEMA,
    workerArtifactRefs: {
      type: "array",
      maxItems: 32,
      items: ARTIFACT_REF_SCHEMA,
    },
    reviewerArtifactRefs: {
      type: "array",
      maxItems: 32,
      items: ARTIFACT_REF_SCHEMA,
    },
    fixArtifactRefs: {
      type: "array",
      maxItems: 32,
      items: ARTIFACT_REF_SCHEMA,
    },
    reReviewArtifactRefs: {
      type: "array",
      maxItems: 32,
      items: ARTIFACT_REF_SCHEMA,
    },
    finalInspectionRef: ARTIFACT_REF_SCHEMA,
    codeReviewResult: {
      type: "object",
      additionalProperties: false,
      properties: {
        requestId: { type: "string", minLength: 1, maxLength: 4096 },
        status: {
          type: "string",
          enum: ["approved", "rejected", "unavailable", "timeout", "failed"],
        },
        approved: { type: "boolean" },
        feedbackRef: ARTIFACT_REF_SCHEMA,
        annotationsRef: ARTIFACT_REF_SCHEMA,
      },
      required: ["requestId", "status", "approved"],
    },
    readyForMerge: {
      type: "object",
      additionalProperties: false,
      properties: {
        ready: { type: "boolean" },
        status: { type: "string", enum: ["READY_FOR_MERGE", "BLOCKED"] },
        checks: { type: "array", minItems: 7, maxItems: 7 },
        blockers: { type: "array", maxItems: 7 },
      },
      required: ["ready", "status", "checks", "blockers"],
    },
    remainingBlockers: {
      type: "array",
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 4096 },
    },
  },
  required: [
    "contractVersion",
    "workflowId",
    "status",
    "workerArtifactRefs",
    "reviewerArtifactRefs",
    "fixArtifactRefs",
    "reReviewArtifactRefs",
    "readyForMerge",
    "remainingBlockers",
  ],
} as const;

export interface ImplementationCoordinatorResult {
  readonly contractVersion: typeof IMPLEMENTATION_COORDINATOR_CONTRACT_VERSION;
  readonly workflowId: WorkflowId;
  readonly status: "COMPLETED" | "FAILED" | "CANCELLED";
  readonly trustedGateSummaryRef?: ArtifactRef;
  readonly findingDispositionSummaryRef?: ArtifactRef;
  readonly workerArtifactRefs: readonly ArtifactRef[];
  readonly reviewerArtifactRefs: readonly ArtifactRef[];
  readonly fixArtifactRefs: readonly ArtifactRef[];
  readonly reReviewArtifactRefs: readonly ArtifactRef[];
  readonly finalInspectionRef?: ArtifactRef;
  readonly codeReviewResult?: CodeReviewResultSummary;
  readonly readyForMerge: ReadyForMergeResult;
  readonly remainingBlockers: readonly string[];
}

const IMPLEMENTATION_RESULT_KEYS = [
  "contractVersion",
  "workflowId",
  "status",
  "trustedGateSummaryRef",
  "findingDispositionSummaryRef",
  "workerArtifactRefs",
  "reviewerArtifactRefs",
  "fixArtifactRefs",
  "reReviewArtifactRefs",
  "finalInspectionRef",
  "codeReviewResult",
  "readyForMerge",
  "remainingBlockers",
] as const;
const MAX_IMPLEMENTATION_ARTIFACT_REFS = 32;
const MAX_IMPLEMENTATION_BLOCKERS = 32;
const MAX_IMPLEMENTATION_TEXT_BYTES = 4096;

function isImplementationResultStatus(
  value: unknown,
): value is ImplementationCoordinatorResult["status"] {
  return value === "COMPLETED" || value === "FAILED" || value === "CANCELLED";
}

function validateArtifactRefs(
  value: unknown,
  fieldName: string,
): ValidationResult<ArtifactRef[]> {
  if (
    !Array.isArray(value) ||
    value.length > MAX_IMPLEMENTATION_ARTIFACT_REFS
  ) {
    return invalidResult(`${fieldName} must contain at most 32 references`);
  }
  const refs: ArtifactRef[] = [];
  for (const item of value) {
    if (!isValidArtifactRef(item)) {
      return invalidResult(`${fieldName} contains an invalid reference`);
    }
    refs.push({ kind: item.kind, path: item.path, mediaType: item.mediaType });
  }
  return validResult(refs);
}

function validateOptionalArtifactRef(
  value: unknown,
  fieldName: string,
): ValidationResult<ArtifactRef | undefined> {
  if (value === undefined) return validResult(undefined);
  if (!isValidArtifactRef(value)) {
    return invalidResult(`${fieldName} is invalid`);
  }
  return validResult({
    kind: value.kind,
    path: value.path,
    mediaType: value.mediaType,
  });
}

function validateImplementationBlockers(
  value: unknown,
): ValidationResult<string[]> {
  if (!Array.isArray(value) || value.length > MAX_IMPLEMENTATION_BLOCKERS) {
    return invalidResult("remainingBlockers must contain at most 32 items");
  }
  const blockers: string[] = [];
  for (const item of value) {
    if (!isBoundedString(item, MAX_IMPLEMENTATION_TEXT_BYTES, true)) {
      return invalidResult("remainingBlockers contains an invalid item");
    }
    blockers.push(item);
  }
  return validResult(blockers);
}

export function validateImplementationCoordinatorResult(
  value: unknown,
): ValidationResult<ImplementationCoordinatorResult> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, IMPLEMENTATION_RESULT_KEYS) ||
    value.contractVersion !== IMPLEMENTATION_COORDINATOR_CONTRACT_VERSION ||
    !isValidWorkflowId(value.workflowId) ||
    !isImplementationResultStatus(value.status)
  ) {
    return invalidResult("Implementation Coordinator result is invalid");
  }

  const workerRefs = validateArtifactRefs(
    value.workerArtifactRefs,
    "workerArtifactRefs",
  );
  const reviewerRefs = validateArtifactRefs(
    value.reviewerArtifactRefs,
    "reviewerArtifactRefs",
  );
  const fixRefs = validateArtifactRefs(
    value.fixArtifactRefs,
    "fixArtifactRefs",
  );
  const reReviewRefs = validateArtifactRefs(
    value.reReviewArtifactRefs,
    "reReviewArtifactRefs",
  );
  const trustedGateRef = validateOptionalArtifactRef(
    value.trustedGateSummaryRef,
    "trustedGateSummaryRef",
  );
  const findingRef = validateOptionalArtifactRef(
    value.findingDispositionSummaryRef,
    "findingDispositionSummaryRef",
  );
  const finalInspectionRef = validateOptionalArtifactRef(
    value.finalInspectionRef,
    "finalInspectionRef",
  );
  const codeReview =
    value.codeReviewResult === undefined
      ? validResult<CodeReviewResultSummary | undefined>(undefined)
      : validateCodeReviewResultSummary(value.codeReviewResult);
  const readiness = validateReadyForMergeResult(value.readyForMerge);
  const blockers = validateImplementationBlockers(value.remainingBlockers);
  if (
    !workerRefs.valid ||
    !reviewerRefs.valid ||
    !fixRefs.valid ||
    !reReviewRefs.valid ||
    !trustedGateRef.valid ||
    !findingRef.valid ||
    !finalInspectionRef.valid ||
    !codeReview.valid ||
    !readiness.valid ||
    !blockers.valid
  ) {
    return invalidResult(
      ...(!workerRefs.valid ? workerRefs.errors : []),
      ...(!reviewerRefs.valid ? reviewerRefs.errors : []),
      ...(!fixRefs.valid ? fixRefs.errors : []),
      ...(!reReviewRefs.valid ? reReviewRefs.errors : []),
      ...(!trustedGateRef.valid ? trustedGateRef.errors : []),
      ...(!findingRef.valid ? findingRef.errors : []),
      ...(!finalInspectionRef.valid ? finalInspectionRef.errors : []),
      ...(!codeReview.valid ? codeReview.errors : []),
      ...(!readiness.valid ? readiness.errors : []),
      ...(!blockers.valid ? blockers.errors : []),
    );
  }
  if (
    (value.status === "COMPLETED" && !readiness.value.ready) ||
    (value.status !== "COMPLETED" && readiness.value.ready)
  ) {
    return invalidResult(
      "Implementation Coordinator status does not match readiness",
    );
  }

  return validResult({
    contractVersion: IMPLEMENTATION_COORDINATOR_CONTRACT_VERSION,
    workflowId: value.workflowId,
    status: value.status,
    ...(trustedGateRef.value === undefined
      ? {}
      : { trustedGateSummaryRef: trustedGateRef.value }),
    ...(findingRef.value === undefined
      ? {}
      : { findingDispositionSummaryRef: findingRef.value }),
    workerArtifactRefs: workerRefs.value,
    reviewerArtifactRefs: reviewerRefs.value,
    fixArtifactRefs: fixRefs.value,
    reReviewArtifactRefs: reReviewRefs.value,
    ...(finalInspectionRef.value === undefined
      ? {}
      : { finalInspectionRef: finalInspectionRef.value }),
    ...(codeReview.value === undefined
      ? {}
      : { codeReviewResult: codeReview.value }),
    readyForMerge: readiness.value,
    remainingBlockers: blockers.value,
  });
}

export interface ImplementationCoordinatorInput {
  contractVersion: typeof IMPLEMENTATION_COORDINATOR_CONTRACT_VERSION;
  workflow: {
    workflowId: WorkflowId;
    workflowType: WorkflowType;
    cwd: string;
  };
  planArtifactRef: ArtifactRef;
  planningHandoffRef: ArtifactRef;
  approval: ApprovalIdentity;
  runtime: {
    timeoutMs: number;
    maxSubagentDepth: 2;
    outputMode: "file-only";
  };
}

function validateWorkflow(
  value: unknown,
): ValidationResult<ImplementationCoordinatorInput["workflow"]> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["workflowId", "workflowType", "cwd"])
  ) {
    return invalidResult(
      "Implementation Coordinator workflow has unknown or missing fields",
    );
  }
  if (
    !isValidWorkflowId(value.workflowId) ||
    !isWorkflowType(value.workflowType) ||
    !isBoundedString(value.cwd, 4096, true) ||
    /[\0\r\n]/u.test(value.cwd)
  ) {
    return invalidResult("Implementation Coordinator workflow is invalid");
  }
  return validResult({
    workflowId: value.workflowId,
    workflowType: value.workflowType,
    cwd: value.cwd,
  });
}

function validateApproval(value: unknown): ValidationResult<ApprovalIdentity> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "approvedPlanHash",
      "reviewId",
      "approval",
      "approvalFeedback",
    ])
  ) {
    return invalidResult(
      "Implementation Coordinator approval has unknown or missing fields",
    );
  }
  if (
    value.approval !== true ||
    !isValidPlanHashValue(value.approvedPlanHash) ||
    !isValidReviewId(value.reviewId)
  ) {
    return invalidResult(
      "Implementation Coordinator approval is not a true identity",
    );
  }
  const approvalFeedback = value.approvalFeedback;
  if (
    "approvalFeedback" in value &&
    !isBoundedString(approvalFeedback, 16 * 1024)
  ) {
    return invalidResult(
      "Implementation Coordinator approval feedback is invalid",
    );
  }
  const approval: ApprovalIdentity = {
    approvedPlanHash: value.approvedPlanHash,
    reviewId: value.reviewId,
    approval: true,
  };
  if ("approvalFeedback" in value) {
    if (!isBoundedString(approvalFeedback, 16 * 1024)) {
      return invalidResult(
        "Implementation Coordinator approval feedback is invalid",
      );
    }
    return validResult({
      ...approval,
      approvalFeedback,
    });
  }
  return validResult(approval);
}

function validateRuntime(
  value: unknown,
): ValidationResult<ImplementationCoordinatorInput["runtime"]> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["timeoutMs", "maxSubagentDepth", "outputMode"])
  ) {
    return invalidResult(
      "Implementation Coordinator runtime has unknown or missing fields",
    );
  }
  if (
    value.timeoutMs !== TIMEOUTS.coordinatorTimeoutMs ||
    value.maxSubagentDepth !== 2 ||
    value.outputMode !== "file-only"
  ) {
    return invalidResult(
      "Implementation Coordinator runtime is not fresh and bounded",
    );
  }
  return validResult({
    timeoutMs: TIMEOUTS.coordinatorTimeoutMs,
    maxSubagentDepth: 2,
    outputMode: "file-only",
  });
}

export function validateImplementationCoordinatorInput(
  value: unknown,
): ValidationResult<ImplementationCoordinatorInput> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "contractVersion",
      "workflow",
      "planArtifactRef",
      "planningHandoffRef",
      "approval",
      "runtime",
    ])
  ) {
    return invalidResult(
      "Implementation Coordinator input has unknown or missing fields",
    );
  }

  const workflow = validateWorkflow(value.workflow);
  const references = validatePlanningArtifactReferences(
    value.planArtifactRef,
    value.planningHandoffRef,
  );
  const approval = validateApproval(value.approval);
  const runtime = validateRuntime(value.runtime);
  if (
    value.contractVersion !== IMPLEMENTATION_COORDINATOR_CONTRACT_VERSION ||
    !workflow.valid ||
    !references.valid ||
    !approval.valid ||
    !runtime.valid
  ) {
    return invalidResult(
      "Implementation Coordinator input is invalid",
      ...(!workflow.valid ? workflow.errors : []),
      ...(!references.valid ? references.errors : []),
      ...(!approval.valid ? approval.errors : []),
      ...(!runtime.valid ? runtime.errors : []),
    );
  }

  return validResult({
    contractVersion: IMPLEMENTATION_COORDINATOR_CONTRACT_VERSION,
    workflow: workflow.value,
    planArtifactRef: references.value.planArtifactRef,
    planningHandoffRef: references.value.planningHandoffRef,
    approval: approval.value,
    runtime: runtime.value,
  });
}

export function isImplementationCoordinatorInput(
  value: unknown,
): value is ImplementationCoordinatorInput {
  return validateImplementationCoordinatorInput(value).valid;
}
