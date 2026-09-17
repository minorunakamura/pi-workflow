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
      {
        capability: "grilling" as const,
        reason: "Repository evidence resolves the implementation ambiguity.",
      },
      {
        capability: "human-decision" as const,
        reason: "No product or scope choice remains for the coordinator.",
      },
      {
        capability: "targeted-rescout" as const,
        reason: "The initial Scout assumptions remain current.",
      },
      {
        capability: "oracle" as const,
        reason:
          "One implementation strategy remains after repository evidence.",
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

it("keeps Workflow Type policy focused on Scout evidence", () => {
  const policy = getWorkflowPolicy();

  expect(policy.typePolicies.feature.scoutFocus).toEqual([
    "existing implementation",
    "impact scope",
    "related tests",
    "existing patterns",
    "extension points",
  ]);
  expect(policy.typePolicies.bug.scoutFocus).toContain(
    "evidence-based root-cause hypothesis",
  );
  expect(policy.typePolicies.chore.scoutFocus).toContain(
    "generated files/lockfiles",
  );
  expect(policy.typePolicies.hotfix.scoutFocus).toContain("data/security risk");
  expect(Object.keys(policy.typePolicies.feature)).toEqual([
    "workflowType",
    "scoutFocus",
  ]);
});

it("requires both managed planning artifact references and all capability decisions", () => {
  const result = completedResult();
  expect(validatePlanningCoordinatorResult(result).valid).toBe(true);
  const missingHandoffRef = { ...result };
  Reflect.deleteProperty(missingHandoffRef, "planningHandoffRef");
  expect(validatePlanningCoordinatorResult(missingHandoffRef).valid).toBe(
    false,
  );
  const missingPlanRef = { ...result };
  Reflect.deleteProperty(missingPlanRef, "planArtifactRef");
  expect(validatePlanningCoordinatorResult(missingPlanRef).valid).toBe(false);
  const missingConditionalDecision = {
    ...result,
    skippedCapabilities: result.skippedCapabilities.slice(0, -1),
  };
  expect(
    validatePlanningCoordinatorResult(missingConditionalDecision).valid,
  ).toBe(false);
  expect(
    validatePlanningCoordinatorResult({
      ...result,
      transcript: "raw planning transcript",
    }).valid,
  ).toBe(false);
});
