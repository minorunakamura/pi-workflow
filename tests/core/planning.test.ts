import { expect, it } from "vitest";

import {
  PLANNING_COORDINATOR_CONTRACT_VERSION,
  TIMEOUTS,
  createWorkflowId,
  getWorkflowPolicy,
  validatePlanningCoordinatorInput,
  validatePlanningCoordinatorResult,
} from "../../src/core/index.ts";

const UUID = "00000000-0000-4000-8000-000000000001";
const WORKFLOW_ID = createWorkflowId(UUID);

function completedResult() {
  return {
    contractVersion: PLANNING_COORDINATOR_CONTRACT_VERSION,
    workflowId: WORKFLOW_ID,
    status: "COMPLETED" as const,
    planArtifactRef: {
      kind: "managed" as const,
      path: "outputs/implementation-plan.md",
      mediaType: "text/markdown" as const,
    },
    planningHandoffRef: {
      kind: "managed" as const,
      path: "outputs/planning-handoff.json",
      mediaType: "application/json" as const,
    },
    selectedCapabilities: [
      {
        capability: "scout" as const,
        reason: "Repository evidence is required.",
      },
      {
        capability: "plan-composition" as const,
        reason: "A self-contained implementation plan is required.",
      },
    ],
    skippedCapabilities: [
      {
        capability: "researcher" as const,
        reason: "The request is repository-only.",
      },
    ],
    remainingBlockers: [],
  };
}

it("validates the bounded Planning Coordinator input contract", () => {
  const result = validatePlanningCoordinatorInput({
    contractVersion: 1,
    workflow: {
      workflowId: WORKFLOW_ID,
      workflowType: "feature",
      request: "Add the feature",
      cwd: "/repo",
    },
    policy: getWorkflowPolicy(),
    artifact: {
      planFileName: "implementation-plan.md",
      handoffFileName: "planning-handoff.json",
      outputMode: "file-only",
    },
    runtime: {
      maxChildCount: 32,
      timeoutMs: TIMEOUTS.coordinatorTimeoutMs,
    },
  });

  expect(result.valid).toBe(true);
  expect(
    validatePlanningCoordinatorInput({
      contractVersion: 1,
      workflow: {
        workflowId: WORKFLOW_ID,
        workflowType: "feature",
        request: "Add the feature",
        cwd: "/repo",
        transcript: "must not cross the boundary",
      },
      policy: getWorkflowPolicy(),
      artifact: {
        planFileName: "implementation-plan.md",
        handoffFileName: "planning-handoff.json",
        outputMode: "file-only",
      },
      runtime: { maxChildCount: 32, timeoutMs: TIMEOUTS.coordinatorTimeoutMs },
    }).valid,
  ).toBe(false);
});

it("requires both managed planning artifact references for a completed result", () => {
  const result = completedResult();
  expect(validatePlanningCoordinatorResult(result).valid).toBe(true);
  expect(
    validatePlanningCoordinatorResult({
      ...result,
      planningHandoffRef: undefined,
    }).valid,
  ).toBe(false);
  expect(
    validatePlanningCoordinatorResult({
      ...result,
      transcript: "raw planning transcript",
    }).valid,
  ).toBe(false);
});
