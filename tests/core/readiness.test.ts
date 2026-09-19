import { expect, it } from "vitest";

import {
  createFindingId,
  createPlanningHandoff,
  createWorkflowId,
  evaluateReadyForMerge,
  hashPlan,
  validateReadyForMergeResult,
  type ReadyForMergeInput,
  type TrustedGate,
} from "../../src/core/index.ts";

const WORKFLOW_ID = createWorkflowId("00000000-0000-4000-8000-000000000031");
const FINDING_ID = createFindingId("00000000-0000-4000-8000-000000000032");
const PLAN = "approved plan";

function gate(
  status: TrustedGate["status"],
  requirement: TrustedGate["requirement"] = "required",
): TrustedGate {
  return {
    name: "package-check",
    command: "pnpm check",
    requirement,
    status,
    source: "package-script",
    ...(status === "PASS"
      ? {
          evidence: {
            kind: "managed",
            path: "/managed/gates/package-check.log",
            mediaType: "text/plain",
          },
        }
      : { reason: `${status} evidence` }),
  };
}

function readyInput(): ReadyForMergeInput {
  const handoff = createPlanningHandoff({
    workflowId: WORKFLOW_ID,
    planContent: PLAN,
    tddMode: "not-applicable",
    testStrategy: {
      kind: "unit",
      required: true,
      summary: "Run the package check.",
    },
    testSeams: ["readiness evaluator"],
    constraints: ["Keep the evaluator pure."],
    nonGoals: ["Do not merge."],
  });
  if (!handoff.valid) throw new Error(handoff.errors.join("; "));

  return {
    handoff: handoff.value,
    currentPlanHash: hashPlan(PLAN).value,
    approval: {
      approvedPlanHash: hashPlan(PLAN).value,
      reviewId: "plan-review-31",
      approval: true,
    },
    implementationComplete: true,
    approvedGates: [gate("UNKNOWN")],
    gates: [gate("PASS")],
    requiredGateKeys: ["package-check"],
    findings: [
      {
        findingId: FINDING_ID,
        disposition: "DEFERRED",
        resolved: false,
        reason: "Outside the approved scope.",
      },
    ],
    fixWave: null,
    focusedReReview: null,
    finalDiffInspection: "PASS",
    codeReview: { status: "approved", approved: true },
  };
}

it("returns a structured ready result only when every condition passes", () => {
  const result = evaluateReadyForMerge(readyInput());

  expect(result).toMatchObject({
    ready: true,
    status: "READY_FOR_MERGE",
    blockers: [],
  });
  expect(result.checks).toHaveLength(7);
  expect(result.checks.every(({ status }) => status === "PASS")).toBe(true);
  expect(validateReadyForMergeResult(result).valid).toBe(true);
});

it("does not block on an explicitly recorded optional SKIPPED Gate", () => {
  const input = readyInput();
  input.approvedGates = [];
  input.gates = [gate("SKIPPED", "optional")];
  input.requiredGateKeys = [];

  expect(evaluateReadyForMerge(input).ready).toBe(true);
});

it("blocks each missing or failed readiness condition", () => {
  const cases: Array<[string, Partial<ReadyForMergeInput>]> = [
    ["approval", { approval: { approval: false } }],
    ["implementation", { implementationComplete: false }],
    ["required Gate", { gates: [gate("SKIPPED")] }],
    [
      "accepted Finding",
      {
        findings: [
          {
            findingId: FINDING_ID,
            disposition: "FIX_NOW",
            resolved: false,
            reason: "Must be fixed.",
          },
        ],
      },
    ],
    [
      "Focused Re-review",
      {
        fixWave: { waveNumber: 1, acceptedFindingIds: [FINDING_ID] },
        focusedReReview: null,
      },
    ],
    ["Final Diff Inspection", { finalDiffInspection: "UNKNOWN" }],
    ["Code Review", { codeReview: { status: "rejected", approved: false } }],
  ];

  for (const [name, overrides] of cases) {
    const result = evaluateReadyForMerge({ ...readyInput(), ...overrides });
    expect(result.ready, name).toBe(false);
    expect(result.status, name).toBe("BLOCKED");
    expect(result.blockers.length, name).toBeGreaterThan(0);
  }
});

it("fails closed for a non-boolean completion signal", () => {
  const input = readyInput();
  Reflect.set(input, "implementationComplete", "true");
  const result = evaluateReadyForMerge(input);

  expect(result.ready).toBe(false);
  expect(result.checks).toContainEqual(
    expect.objectContaining({
      id: "implementation-complete",
      status: "FAIL",
    }),
  );
});

it("rejects inconsistent structured readiness results", () => {
  const result = evaluateReadyForMerge(readyInput());

  expect(
    validateReadyForMergeResult({ ...result, ready: true, status: "BLOCKED" }),
  ).toMatchObject({ valid: false });
  expect(
    validateReadyForMergeResult({ ...result, checks: result.checks.slice(1) }),
  ).toMatchObject({ valid: false });
});
