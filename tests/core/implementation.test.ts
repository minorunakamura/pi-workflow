import { expect, it } from "vitest";

import {
  TIMEOUTS,
  createReviewId,
  createWorkflowId,
  hashPlan,
  validateImplementationCoordinatorInput,
  validateImplementationCoordinatorResult,
  type ImplementationCoordinatorInput,
} from "../../src/core/index.ts";

const WORKFLOW_ID = createWorkflowId("00000000-0000-4000-8000-000000000012");
const PLAN_HASH = hashPlan("approved plan").value;

function input(): ImplementationCoordinatorInput {
  return {
    contractVersion: 1,
    workflow: {
      workflowId: WORKFLOW_ID,
      workflowType: "feature",
      cwd: "/repo",
    },
    planArtifactRef: {
      kind: "managed",
      path: "/managed/run/implementation-plan.md",
      mediaType: "text/markdown",
    },
    planningHandoffRef: {
      kind: "managed",
      path: "/managed/run/planning-handoff.json",
      mediaType: "application/json",
    },
    approval: {
      approvedPlanHash: PLAN_HASH,
      reviewId: createReviewId("review-12"),
      approval: true,
    },
    runtime: {
      timeoutMs: TIMEOUTS.coordinatorTimeoutMs,
      maxSubagentDepth: 2,
      outputMode: "file-only",
    },
  };
}

it("accepts the minimal fresh Implementation Coordinator contract", () => {
  const result = validateImplementationCoordinatorInput(input());

  expect(result.valid).toBe(true);
  expect(result.valid && result.value).toEqual(input());
});

it("rejects Planning context and non-fresh runtime settings", () => {
  const withPlanningContext = {
    ...input(),
    planningTranscript: "must not cross the phase boundary",
  };
  expect(
    validateImplementationCoordinatorInput(withPlanningContext).valid,
  ).toBe(false);

  expect(
    validateImplementationCoordinatorInput({
      ...input(),
      runtime: { ...input().runtime, maxSubagentDepth: 3 },
    }).valid,
  ).toBe(false);
  expect(
    validateImplementationCoordinatorInput({
      ...input(),
      runtime: { ...input().runtime, timeoutMs: 1 },
    }).valid,
  ).toBe(false);
});

it("validates the final Implementation Coordinator readiness contract", () => {
  const readyForMerge = {
    ready: true,
    status: "READY_FOR_MERGE" as const,
    checks: [
      "approved-plan-identity",
      "implementation-complete",
      "required-gates",
      "accepted-findings",
      "focused-re-review",
      "final-diff-inspection",
      "code-review",
    ].map((id) => ({ id, status: "PASS" as const, reason: "passed" })),
    blockers: [],
  };
  const result = {
    contractVersion: 1 as const,
    workflowId: WORKFLOW_ID,
    status: "COMPLETED" as const,
    workerArtifactRefs: [],
    reviewerArtifactRefs: [],
    fixArtifactRefs: [],
    reReviewArtifactRefs: [],
    readyForMerge,
    remainingBlockers: [],
  };

  expect(validateImplementationCoordinatorResult(result)).toMatchObject({
    valid: true,
  });
  expect(
    validateImplementationCoordinatorResult({
      ...result,
      readyForMerge: { ...readyForMerge, ready: false, status: "BLOCKED" },
    }),
  ).toMatchObject({ valid: false });
});

it("requires a true approval identity bound to a plan-shaped pair of refs", () => {
  expect(
    validateImplementationCoordinatorInput({
      ...input(),
      approval: { ...input().approval, approval: false },
    }).valid,
  ).toBe(false);
  expect(
    validateImplementationCoordinatorInput({
      ...input(),
      planningHandoffRef: {
        ...input().planningHandoffRef,
        path: "/managed/other/planning-handoff.json",
      },
    }).valid,
  ).toBe(false);
});
