import { expect, it } from "vitest";

import {
  createWorkerLaunchRequest,
  createWorkflowId,
  validateWorkerChangedPaths,
  validateWorkerHandoff,
  validateWorkerResult,
  validateWorkerTddEvidence,
  type WorkerHandoff,
} from "../../src/core/index.ts";

const WORKFLOW_ID = createWorkflowId("00000000-0000-4000-8000-000000000021");

function handoff(): WorkerHandoff {
  return {
    contractVersion: 1,
    workflow: {
      workflowId: WORKFLOW_ID,
      workflowType: "feature",
      cwd: "/repo",
    },
    requirements: ["Implement the approved behavior."],
    scope: {
      allowedPaths: ["src/feature.ts", "tests/core/feature.test.ts"],
      allowedAreas: [],
    },
    nonGoals: ["Do not change the public API."],
    tddMode: "required",
    testStrategy: {
      kind: "unit",
      required: true,
      summary: "Run the focused unit test.",
    },
    testSeams: ["the feature entry point"],
    verificationCommands: ["pnpm test:run -- tests/core/feature.test.ts"],
    trustedGateExpectations: ["Use only commands confirmed by the Plan."],
    stopCondition: "Stop when the approved behavior and focused test pass.",
  };
}

const tddEvidence = {
  red: {
    status: "FAIL" as const,
    failureKind: "behavioral" as const,
    command: "pnpm test:run -- tests/core/feature.test.ts",
    evidence: "Expected value was false, received true.",
  },
  green: {
    status: "PASS" as const,
    command: "pnpm test:run -- tests/core/feature.test.ts",
    evidence: "The focused test passed after the implementation.",
  },
  refactor: {
    status: "skipped" as const,
    reason: "No safe refactor is needed for this bounded change.",
  },
};

it("builds a fake Worker handoff with fresh context, bounded output, and explicit TDD", () => {
  const result = createWorkerLaunchRequest(handoff());

  expect(result.valid).toBe(true);
  if (!result.valid) return;

  expect(result.value).toMatchObject({
    agent: "worker",
    context: "fresh",
    output: "worker-summary.md",
    outputMode: "file-only",
    worktree: false,
    skill: ["tdd"],
  });
  expect(JSON.parse(result.value.task)).toMatchObject({
    contractVersion: 1,
    scope: handoff().scope,
    authority: {
      sourceWrite: "approved-scope-only",
      prohibitedOperations: [
        "merge",
        "push",
        "release",
        "deploy",
        "approval",
        "unapproved-architecture-change",
      ],
    },
  });
});

it("does not inject TDD Skill when TDD is not required", () => {
  const result = createWorkerLaunchRequest({
    ...handoff(),
    tddMode: "optional",
  });

  expect(result.valid).toBe(true);
  if (!result.valid) return;
  expect(result.value).not.toHaveProperty("skill");
});

it("accepts a Worker handoff when no file or area paths are known", () => {
  const result = validateWorkerHandoff({
    ...handoff(),
    scope: { allowedPaths: [], allowedAreas: [] },
  });

  expect(result.valid).toBe(true);
  if (!result.valid) return;
  expect(
    validateWorkerChangedPaths(["src/unknown.ts"], result.value.scope).valid,
  ).toBe(true);
});

it("accepts a valid behavioral RED/GREEN cycle and rejects infrastructure RED", () => {
  expect(validateWorkerTddEvidence(tddEvidence).valid).toBe(true);
  expect(
    validateWorkerTddEvidence({
      ...tddEvidence,
      red: { ...tddEvidence.red, failureKind: "infrastructure" },
    }).valid,
  ).toBe(false);
  expect(
    validateWorkerTddEvidence({
      ...tddEvidence,
      refactor: { status: "skipped" },
    }).valid,
  ).toBe(false);
});

it("accepts in-scope Worker changes and rejects paths outside the approved scope", () => {
  const validated = validateWorkerHandoff(handoff());
  expect(validated.valid).toBe(true);
  if (!validated.valid) return;

  expect(
    validateWorkerChangedPaths(
      ["src/feature.ts", "tests/core/feature.test.ts"],
      validated.value.scope,
    ).valid,
  ).toBe(true);
  expect(
    validateWorkerChangedPaths(["docs/feature.md"], validated.value.scope)
      .valid,
  ).toBe(false);
  expect(
    validateWorkerChangedPaths(["src/feature.ts.bak"], validated.value.scope)
      .valid,
  ).toBe(false);
});

it("accepts a completed fake Worker result only with required TDD evidence and in-scope paths", () => {
  const validated = validateWorkerHandoff(handoff());
  expect(validated.valid).toBe(true);
  if (!validated.valid) return;

  const result = validateWorkerResult(
    {
      contractVersion: 1,
      status: "COMPLETED",
      changedPaths: ["src/feature.ts", "tests/core/feature.test.ts"],
      tdd: tddEvidence,
    },
    validated.value,
  );
  expect(result.valid).toBe(true);
  expect(
    validateWorkerResult(
      {
        contractVersion: 1,
        status: "COMPLETED",
        changedPaths: ["src/feature.ts"],
      },
      validated.value,
    ).valid,
  ).toBe(false);
});
