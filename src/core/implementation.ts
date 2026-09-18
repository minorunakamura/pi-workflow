import {
  validatePlanningArtifactReferences,
  type ApprovalIdentity,
} from "./plan.ts";
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
  isValidPlanHashValue,
  isValidReviewId,
  isValidWorkflowId,
  isWorkflowType,
  type ArtifactRef,
  type WorkflowId,
  type WorkflowType,
} from "./workflow.ts";

export const IMPLEMENTATION_COORDINATOR_CONTRACT_VERSION = 1 as const;

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
