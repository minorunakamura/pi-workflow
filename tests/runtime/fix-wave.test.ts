import { expect, it } from "vitest";

import {
  createFindingId,
  createWorkflowId,
  normalizeFinding,
  validateFindingDisposition,
  isRecord,
  type DispositionedFinding,
  type TrustedGate,
} from "../../src/core/index.ts";
import {
  createFocusedReReviewRequest,
  executeFixWave,
  prepareFixWave,
  selectAffectedGates,
  type FixWavePreparationInput,
} from "../../src/runtime/fix-wave.ts";

const WORKFLOW_ID = createWorkflowId("00000000-0000-4000-8000-000000000041");
const ACCEPTED_ID = createFindingId("00000000-0000-4000-8000-000000000042");
const DEFERRED_ID = createFindingId("00000000-0000-4000-8000-000000000043");

function finding(
  id: ReturnType<typeof createFindingId>,
  disposition: "BLOCKER" | "FIX_NOW" | "DEFERRED" | "REJECTED",
): DispositionedFinding {
  const normalized = normalizeFinding(
    {
      source: "reviewer",
      location: "src/feature.ts:12",
      evidence: `${id} normalized evidence`,
      reason: `${id} normalized reason`,
      recommendedAction: "Make the approved bounded change.",
    },
    id,
  );
  if (!normalized.valid) throw new Error(normalized.errors.join("; "));
  const result = validateFindingDisposition({
    findingId: id,
    disposition,
    reason: `Coordinator disposition for ${id}.`,
  });
  if (!result.valid) throw new Error(result.errors.join("; "));
  return { finding: normalized.value, disposition: result.value };
}

function gate(
  name: string,
  command: string,
  requirement: TrustedGate["requirement"],
): TrustedGate {
  return {
    name,
    command,
    requirement,
    status: "UNKNOWN",
    source: "package-script",
    reason: "Awaiting Fix Wave re-gate execution.",
  };
}

function passedGate(
  name: string,
  command: string,
  requirement: TrustedGate["requirement"],
): TrustedGate {
  return {
    name,
    command,
    requirement,
    status: "PASS",
    source: "package-script",
    evidence: {
      kind: "managed",
      path: `baseline/${name}.log`,
      mediaType: "text/plain",
    },
  };
}

function parseTask(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("Expected a structured task");
  return parsed;
}

function passedGateRun(command: string) {
  return {
    ok: true,
    results: [
      {
        acceptance: {
          evidenceStatus: "verified",
          verifyRuns: [
            {
              command,
              status: "passed",
              artifactPath: `/managed/gates/${command.replaceAll(" ", "-")}.log`,
            },
          ],
        },
      },
    ],
  };
}

function workerResult() {
  return {
    contractVersion: 1 as const,
    status: "COMPLETED" as const,
    changedPaths: ["src/feature.ts"],
    tdd: {
      red: {
        status: "FAIL" as const,
        failureKind: "behavioral" as const,
        command: "pnpm test:run -- feature",
        evidence: "The focused behavior failed before the Fix Worker change.",
      },
      green: {
        status: "PASS" as const,
        command: "pnpm test:run -- feature",
        evidence: "The focused behavior passed after the Fix Worker change.",
      },
      refactor: {
        status: "skipped" as const,
        reason: "No safe refactor is needed for this bounded Fix Wave.",
      },
    },
  };
}

function input(
  findings: readonly DispositionedFinding[] = [
    finding(ACCEPTED_ID, "FIX_NOW"),
    finding(DEFERRED_ID, "DEFERRED"),
  ],
): FixWavePreparationInput {
  return {
    workflow: {
      workflowId: WORKFLOW_ID,
      workflowType: "feature",
      cwd: "/repo",
    },
    findings,
    scope: { allowedPaths: ["src/feature.ts"], allowedAreas: [] },
    nonGoals: ["Do not change the public API."],
    tddMode: "required",
    testStrategy: {
      kind: "unit",
      required: true,
      summary: "Run the focused behavior test.",
    },
    testSeams: ["the feature entry point"],
    verificationCommands: ["pnpm test:run -- feature"],
    trustedGateExpectations: ["Use only Plan-approved Gates."],
    stopCondition:
      "Stop after the bounded fix and verification evidence are recorded.",
  };
}

const planArtifactRef = {
  kind: "managed" as const,
  path: "implementation-plan.md",
  mediaType: "text/markdown" as const,
};
const handoffRef = {
  kind: "managed" as const,
  path: "planning-handoff.json",
  mediaType: "application/json" as const,
};
const diffRef = {
  kind: "managed" as const,
  path: "fix-worker.diff",
  mediaType: "text/x-diff" as const,
};
const reviewRef = {
  kind: "managed" as const,
  path: "focused-re-review.md",
  mediaType: "text/markdown" as const,
};

function options(
  overrides: Partial<Parameters<typeof executeFixWave>[1]> = {},
) {
  return {
    approvedGates: [
      gate("package-check", "pnpm check", "required"),
      passedGate("type-check", "pnpm typecheck", "required"),
      gate("docs-check", "pnpm docs", "optional"),
    ],
    affectedGateNames: ["package-check", "docs-check"],
    planArtifactRef,
    planningHandoffRef: handoffRef,
    fixWorkerRunner: async (_key: string, _request: unknown) => ({
      result: workerResult(),
      diffRef,
    }),
    gateRunner: async (_key: string, params: { gate: string }) =>
      passedGateRun(params.gate),
    focusedReviewRunner: async (_key: string, _request: unknown) => ({
      result: { status: "RESOLVED", fresh: true, readOnly: true },
      reportRef: reviewRef,
    }),
    ...overrides,
  };
}

it("consolidates accepted findings, re-gates selected commands, and runs a fresh focused review", async () => {
  const calls = {
    worker: 0,
    gates: [] as string[],
    reviewer: 0,
  };
  let workerFinished = false;
  const result = await executeFixWave(input(), {
    ...options(),
    fixWorkerRunner: async (_key, request) => {
      calls.worker += 1;
      const task = parseTask(request.task);
      expect(task).toMatchObject({
        fixWave: { acceptedFindingIds: [ACCEPTED_ID] },
      });
      expect(Array.isArray(task.requiredChanges)).toBe(true);
      if (Array.isArray(task.requiredChanges)) {
        expect(task.requiredChanges).toHaveLength(1);
        expect(task.requiredChanges[0]).not.toHaveProperty("rawReport");
        expect(task.requiredChanges[0]).not.toHaveProperty("recommendedAction");
      }
      expect(request).toMatchObject({
        agent: "worker",
        context: "fresh",
        output: "fix-worker-summary.md",
        outputMode: "file-only",
        worktree: false,
        skill: ["tdd"],
      });
      workerFinished = true;
      return { result: workerResult(), diffRef };
    },
    affectedGateSelector: (selectionInput) => {
      expect(workerFinished).toBe(true);
      expect(selectionInput.changedPaths).toEqual(["src/feature.ts"]);
      expect(selectionInput.acceptedFindingLocations).toEqual([
        "src/feature.ts:12",
      ]);
      return selectAffectedGates(selectionInput);
    },
    gateRunner: async (_key, params) => {
      calls.gates.push(params.gate);
      return passedGateRun(params.gate);
    },
    focusedReviewRunner: async (_key, request) => {
      calls.reviewer += 1;
      const task = parseTask(request.task);
      expect(task).toMatchObject({
        acceptedFindingIds: [ACCEPTED_ID],
        fixWorkerDiffRef: { path: diffRef.path },
        readOnly: true,
      });
      expect(request).toMatchObject({
        agent: "reviewer",
        context: "fresh",
        output: "focused-re-review.md",
        outputMode: "file-only",
        artifacts: true,
        worktree: false,
      });
      return {
        result: { status: "RESOLVED", fresh: true, readOnly: true },
        reportRef: reviewRef,
      };
    },
  });

  expect(result.status).toBe("COMPLETED");
  if (result.status !== "COMPLETED") return;
  expect(result.wave.acceptedFindingIds).toEqual([ACCEPTED_ID]);
  expect(calls).toEqual({
    worker: 1,
    gates: ["pnpm check", "pnpm docs"],
    reviewer: 1,
  });
  expect(result.gates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "type-check",
        command: "pnpm typecheck",
        status: "PASS",
      }),
    ]),
  );
  expect(result.skippedGates).toEqual([
    {
      name: "type-check",
      requirement: "required",
      reason:
        "Gate was not selected by bounded Fix evidence: 1 changed path(s), 1 accepted Finding location(s).",
    },
  ]);
  expect(result.skippedOptionalGates).toHaveLength(0);
});

it("keeps required Gates and records unselected optional Gates without inventing a Gate", () => {
  const result = selectAffectedGates({
    approvedGates: [
      gate("package-check", "pnpm check", "required"),
      gate("docs-check", "pnpm docs", "optional"),
    ],
    changedPaths: ["src/feature.ts"],
    acceptedFindingLocations: ["src/feature.ts:12"],
  });

  expect(result.valid).toBe(true);
  if (!result.valid) return;
  expect(result.value.gates).toHaveLength(0);
  expect(result.value.finalGates).toEqual([
    gate("package-check", "pnpm check", "required"),
    gate("docs-check", "pnpm docs", "optional"),
  ]);
  expect(result.value.requiredGateKeys).toEqual([
    "package-check\u0000pnpm check",
  ]);
  expect(result.value.skippedGates).toEqual([
    {
      name: "package-check",
      requirement: "required",
      reason:
        "Gate was not selected by bounded Fix evidence: 1 changed path(s), 1 accepted Finding location(s).",
    },
    {
      name: "docs-check",
      requirement: "optional",
      reason:
        "Gate was not selected by bounded Fix evidence: 1 changed path(s), 1 accepted Finding location(s).",
    },
  ]);
  expect(result.value.skippedOptionalGates).toEqual([
    {
      name: "docs-check",
      reason:
        "Gate was not selected by bounded Fix evidence: 1 changed path(s), 1 accepted Finding location(s).",
    },
  ]);
});

it("fails closed when an unselected required Gate is unresolved", async () => {
  let reviewerCalls = 0;
  const result = await executeFixWave(input(), {
    ...options({
      approvedGates: [
        gate("package-check", "pnpm check", "required"),
        gate("type-check", "pnpm typecheck", "required"),
      ],
      affectedGateNames: ["package-check"],
    }),
    focusedReviewRunner: async () => {
      reviewerCalls += 1;
      return {
        result: { status: "RESOLVED", fresh: true, readOnly: true },
        reportRef: reviewRef,
      };
    },
  });

  expect(result.status).toBe("FAILED");
  if (result.status !== "FAILED") return;
  expect(result.reason).toContain("Required Gate type-check is UNKNOWN");
  expect(reviewerCalls).toBe(0);
});

it("does not start a wave when no finding is accepted", async () => {
  let calls = 0;
  const result = await executeFixWave(
    input([finding(DEFERRED_ID, "DEFERRED")]),
    {
      ...options(),
      fixWorkerRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
      focusedReviewRunner: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    },
  );

  expect(result).toEqual({
    status: "NO_WAVE",
    reason: "NO_ACCEPTED_FINDINGS",
  });
  expect(calls).toBe(0);
});

it("rejects a second automatic wave and never retries a still-present finding", async () => {
  const secondWave = prepareFixWave({ ...input(), completedWaveCount: 1 });
  expect(secondWave).toMatchObject({
    prepared: false,
    reason: "MAX_FIX_WAVES_REACHED",
  });

  let reviewerCalls = 0;
  const result = await executeFixWave(input(), {
    ...options(),
    focusedReviewRunner: async () => {
      reviewerCalls += 1;
      return {
        result: { status: "STILL_PRESENT", fresh: true, readOnly: true },
        reportRef: reviewRef,
      };
    },
  });

  expect(result.status).toBe("FAILED");
  if (result.status !== "FAILED") return;
  expect(result.focusedReReview?.status).toBe("STILL_PRESENT");
  expect(reviewerCalls).toBe(1);
});

it("fails closed on Fix Worker scope escape before running Gates or review", async () => {
  let gateCalls = 0;
  let reviewerCalls = 0;
  const result = await executeFixWave(input(), {
    ...options(),
    fixWorkerRunner: async () => ({
      result: { ...workerResult(), changedPaths: ["docs/outside.md"] },
      diffRef,
    }),
    gateRunner: async () => {
      gateCalls += 1;
      return passedGateRun("pnpm check");
    },
    focusedReviewRunner: async () => {
      reviewerCalls += 1;
      return {
        result: { status: "RESOLVED", fresh: true, readOnly: true },
        reportRef: reviewRef,
      };
    },
  });

  expect(result.status).toBe("FAILED");
  expect(gateCalls).toBe(0);
  expect(reviewerCalls).toBe(0);
});

it("limits focused re-review scope to accepted IDs and managed references", () => {
  const result = createFocusedReReviewRequest({
    workflow: input().workflow,
    planArtifactRef,
    planningHandoffRef: handoffRef,
    acceptedFindingIds: [ACCEPTED_ID],
    fixWorkerDiffRef: diffRef,
    scope: input().scope,
    nonGoals: input().nonGoals,
  });

  expect(result.valid).toBe(true);
  if (!result.valid) return;
  const task = parseTask(result.value.task);
  expect(task).toMatchObject({
    acceptedFindingIds: [ACCEPTED_ID],
    fixWorkerDiffRef: diffRef,
    planArtifactRef,
    planningHandoffRef: handoffRef,
    readOnly: true,
  });
  expect(task).not.toHaveProperty("rawReviewerProse");
});
