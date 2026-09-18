import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  REQUIRED_PLAN_HEADINGS,
  createPlanningHandoff,
  createRunId,
  createWorkflowId,
  hashPlan,
  isRecord,
  type ImplementationCoordinatorInput,
  type RootWorkflowState,
} from "../../src/core/index.ts";
import {
  launchFreshImplementationCoordinator,
  resolveRepositoryGatesFromPackageScripts,
  type RepositoryGateResolver,
  type ImplementationLaunchRegistry,
} from "../../src/runtime/implementation-launch.ts";
import {
  PLANNOTATOR_REQUEST_EVENT,
  PLANNOTATOR_REVIEW_RESULT_EVENT,
  PlanReviewRootBridge,
  isPlanReviewRequest,
} from "../../src/runtime/plan-review.ts";
import { RootWorkflowRegistry } from "../../src/runtime/root-lifecycle.ts";
import type { ImplementationCoordinatorLaunchResult } from "../../src/runtime/subagents-rpc.ts";

class FakeEventBus {
  private readonly handlers = new Map<string, Set<(value: unknown) => void>>();

  public on(event: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(event);
    };
  }

  public emit(event: string, value: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      handler(value);
    }
  }
}

const WORKFLOW_ID = createWorkflowId("00000000-0000-4000-8000-000000000013");
const PLAN = `${REQUIRED_PLAN_HEADINGS.join("\n")}\n\nBounded plan.\n`;
const roots: string[] = [];

function writeArtifacts(root: string, plan = PLAN) {
  const planPath = join(root, "implementation-plan.md");
  const handoffPath = join(root, "planning-handoff.json");
  const handoff = createPlanningHandoff({
    workflowId: WORKFLOW_ID,
    planContent: plan,
    tddMode: "required",
    testStrategy: {
      kind: "unit",
      required: true,
      summary: "Run focused tests.",
    },
    testSeams: ["fresh Implementation launch"],
    constraints: ["Use only the approved phase-boundary inputs."],
    nonGoals: ["Do not implement Worker behavior in this step."],
    planningRunId: createRunId("planning-run"),
  });
  if (!handoff.valid) throw new Error(handoff.errors.join("; "));
  writeFileSync(planPath, plan);
  writeFileSync(handoffPath, `${JSON.stringify(handoff.value)}\n`);
  return { planPath, handoffPath, hash: hashPlan(plan).value };
}

function planningResult(
  planPath: string,
  handoffPath: string,
): Record<string, unknown> {
  return {
    contractVersion: 1,
    workflowId: WORKFLOW_ID,
    status: "COMPLETED",
    planArtifactRef: {
      kind: "managed",
      path: planPath,
      mediaType: "text/markdown",
    },
    planningHandoffRef: {
      kind: "managed",
      path: handoffPath,
      mediaType: "application/json",
    },
    selectedCapabilities: [
      { capability: "scout", reason: "Repository evidence." },
      { capability: "plan-composition", reason: "Plan is required." },
    ],
    skippedCapabilities: [
      { capability: "researcher", reason: "No external fact." },
      { capability: "grilling", reason: "No ambiguity remains." },
      { capability: "human-decision", reason: "No product choice remains." },
      {
        capability: "targeted-rescout",
        reason: "Scout assumptions remain current.",
      },
      { capability: "oracle", reason: "No strategy challenge." },
    ],
    remainingBlockers: [],
  };
}

function planningReviewRegistry(artifacts: {
  planPath: string;
  handoffPath: string;
}) {
  const registry = new RootWorkflowRegistry(() => undefined);
  expect(registry.start(WORKFLOW_ID, "feature").started).toBe(true);
  expect(
    registry.bindWorkflowRequest({
      workflowId: WORKFLOW_ID,
      workflowType: "feature",
      request: "launch the implementation coordinator",
      cwd: "/repo",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  ).toBe(true);
  expect(registry.setPlanningRunId("planning-run").transitioned).toBe(true);
  expect(
    registry.completePlanning(
      "planning-run",
      planningResult(artifacts.planPath, artifacts.handoffPath),
    ).transitioned,
  ).toBe(true);
  return registry;
}

function approvedRegistry(
  artifacts: {
    planPath: string;
    handoffPath: string;
  },
  cwd = "/repo",
) {
  const registry = new RootWorkflowRegistry(() => undefined);
  const request = {
    workflowId: WORKFLOW_ID,
    workflowType: "feature" as const,
    request: "launch the implementation coordinator",
    cwd,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  expect(registry.start(WORKFLOW_ID, "feature").started).toBe(true);
  expect(registry.bindWorkflowRequest(request)).toBe(true);
  expect(
    registry.setPlanningRunId(createRunId("planning-run")).transitioned,
  ).toBe(true);
  expect(
    registry.completePlanning(
      "planning-run",
      planningResult(artifacts.planPath, artifacts.handoffPath),
    ).transitioned,
  ).toBe(true);
  expect(
    registry.setPlanReviewPending(
      "00000000-0000-4000-8000-000000000014",
      "review-1",
    ).transitioned,
  ).toBe(true);
  const handoff: unknown = JSON.parse(
    readFileSync(artifacts.handoffPath, "utf8"),
  );
  if (
    !isRecord(handoff) ||
    !isRecord(handoff.planHash) ||
    typeof handoff.planHash.value !== "string"
  ) {
    throw new Error("Expected a valid Planning Handoff");
  }
  expect(
    registry.recordPlanApproval(
      {
        approvedPlanHash: handoff.planHash.value,
        reviewId: "review-1",
        approval: true,
      },
      handoff.planHash.value,
      handoff,
    ).transitioned,
  ).toBe(true);
  return registry;
}

function launch(
  registry: ImplementationLaunchRegistry,
  spawn: (
    input: ImplementationCoordinatorInput,
  ) =>
    | ImplementationCoordinatorLaunchResult
    | Promise<ImplementationCoordinatorLaunchResult>,
  repositoryGateResolver: RepositoryGateResolver = async (_cwd, gates) => gates,
) {
  return launchFreshImplementationCoordinator({
    registry,
    repositoryGateResolver,
    spawnImplementationCoordinator: async (input) => spawn(input),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it("validates the three phase-boundary artifacts before spawning a fresh Coordinator", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "pi-workflow-implementation-launch-"),
  );
  roots.push(root);
  const artifacts = writeArtifacts(root);
  const registry = approvedRegistry(artifacts);
  let received: ImplementationCoordinatorInput | undefined;

  const result = await launch(registry, async (input) => {
    received = input;
    return {
      requestId: "00000000-0000-4000-8000-000000000015",
      runId: createRunId("implementation-run"),
    };
  });

  expect(result).toMatchObject({
    started: true,
    requestId: "00000000-0000-4000-8000-000000000015",
    runId: "implementation-run",
  });
  expect(received).toEqual({
    contractVersion: 1,
    workflow: {
      workflowId: WORKFLOW_ID,
      workflowType: "feature",
      cwd: "/repo",
    },
    planArtifactRef: {
      kind: "managed",
      path: artifacts.planPath,
      mediaType: "text/markdown",
    },
    planningHandoffRef: {
      kind: "managed",
      path: artifacts.handoffPath,
      mediaType: "application/json",
    },
    approval: {
      approvedPlanHash: artifacts.hash,
      reviewId: "review-1",
      approval: true,
    },
    runtime: {
      timeoutMs: 43_200_000,
      maxSubagentDepth: 2,
      outputMode: "file-only",
    },
  });
  expect(received).not.toHaveProperty("workflow.request");
  expect(received).not.toHaveProperty("planningTranscript");
});

function planWithGates(
  declarations: readonly Record<string, string>[],
): string {
  return PLAN.replace(
    "## Risks / assumptions",
    `<!-- pi-workflow-trusted-gates: ${JSON.stringify(declarations)} -->\n\n## Risks / assumptions`,
  );
}

it("resolves approved Plan Gates against current repository evidence before spawning", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "pi-workflow-implementation-gate-resolution-"),
  );
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { check: "vitest run" } }),
  );
  const artifacts = writeArtifacts(
    root,
    planWithGates([
      {
        name: "package-check",
        command: "pnpm check",
        requirement: "required",
        source: "package-script",
      },
    ]),
  );
  const registry = approvedRegistry(artifacts, root);
  let spawnCount = 0;
  const spawn = async () => {
    spawnCount += 1;
    return {
      requestId: "00000000-0000-4000-8000-000000000015",
      runId: createRunId("implementation-run"),
    };
  };

  expect(
    (await launch(registry, spawn, resolveRepositoryGatesFromPackageScripts))
      .started,
  ).toBe(true);
  expect(spawnCount).toBe(1);
});

it("fails closed on required Gate command/source/missing drift", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "pi-workflow-implementation-gate-drift-"),
  );
  roots.push(root);
  const artifacts = writeArtifacts(
    root,
    planWithGates([
      {
        name: "package-check",
        command: "pnpm check",
        requirement: "required",
        source: "package-script",
      },
    ]),
  );
  const registry = approvedRegistry(artifacts, root);
  const spawn = async () => ({
    requestId: "00000000-0000-4000-8000-000000000015",
    runId: createRunId("implementation-run"),
  });
  const driftResolvers: RepositoryGateResolver[] = [
    async (_cwd, gates) =>
      gates.map((gate) => ({ ...gate, command: "pnpm test" })),
    async (_cwd, gates) =>
      gates.map((gate) => ({ ...gate, source: "ci-config" as const })),
    async () => [],
  ];

  for (const repositoryGateResolver of driftResolvers) {
    const result = await launch(registry, spawn, repositoryGateResolver);
    expect(result.started).toBe(false);
    expect(registry.getState()?.phase).toBe("PLAN_REVIEW");
  }
});

it("does not reject a Plan containing only optional Gates", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "pi-workflow-implementation-optional-gate-"),
  );
  roots.push(root);
  const artifacts = writeArtifacts(
    root,
    planWithGates([
      {
        name: "optional-check",
        command: "pnpm check",
        requirement: "optional",
        source: "package-script",
      },
    ]),
  );
  const registry = approvedRegistry(artifacts, root);
  let resolverCalled = false;
  const result = await launch(
    registry,
    async () => ({
      requestId: "00000000-0000-4000-8000-000000000015",
      runId: createRunId("implementation-run"),
    }),
    async () => {
      resolverCalled = true;
      throw new Error("optional Gate resolution is not required");
    },
  );

  expect(result.started).toBe(true);
  expect(resolverCalled).toBe(false);
});

it("transitions to IMPLEMENTING only after Root approval and a fresh run", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "pi-workflow-implementation-bridge-"),
  );
  roots.push(root);
  const artifacts = writeArtifacts(root);
  const registry = planningReviewRegistry(artifacts);
  const events = new FakeEventBus();
  let launchState: string | undefined;
  let launchCount = 0;
  events.on(PLANNOTATOR_REQUEST_EVENT, (value) => {
    if (!isPlanReviewRequest(value) || value.action !== "plan-review") return;
    value.respond({
      status: "handled",
      result: { status: "pending", reviewId: "review-1" },
    });
  });

  const bridge = new PlanReviewRootBridge({
    events,
    registry,
    launchFreshImplementationCoordinator: async (state) => {
      launchCount += 1;
      launchState = state.phase;
      return {
        requestId: "00000000-0000-4000-8000-000000000015",
        runId: createRunId("implementation-run"),
      };
    },
    timeoutMs: 1_000,
  });
  expect((await bridge.start()).started).toBe(true);
  events.emit(PLANNOTATOR_REVIEW_RESULT_EVENT, {
    reviewId: "review-1",
    approved: true,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  expect(launchCount).toBe(1);
  expect(launchState).toBe("PLAN_REVIEW");
  expect(registry.getState()).toMatchObject({
    phase: "IMPLEMENTING",
    planningStatus: "COMPLETED",
    implementationStatus: "RUNNING",
    implementationRunId: "implementation-run",
  });
  bridge.dispose();
});

it("refuses invalid pre-launch state categories without spawning", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "pi-workflow-implementation-prelaunch-state-"),
  );
  roots.push(root);
  const artifacts = writeArtifacts(root);
  const approved = approvedRegistry(artifacts);
  const baseState = approved.getState();
  const request = approved.getActiveWorkflowRequest();
  if (baseState === undefined || request === undefined) {
    throw new Error("Expected an approved workflow state");
  }

  const missingPlanningRun = { ...baseState };
  delete missingPlanningRun.planningRunId;
  const missingHandoff = { ...baseState };
  delete missingHandoff.planningHandoffRef;
  const cases: Array<{ name: string; state: RootWorkflowState }> = [
    {
      name: "wrong workflow phase",
      state: { ...baseState, phase: "PLANNING" },
    },
    {
      name: "Planning Coordinator is not completed",
      state: { ...baseState, planningStatus: "RUNNING" },
    },
    { name: "missing Planning run identity", state: missingPlanningRun },
    { name: "missing Plan/Handoff boundary", state: missingHandoff },
    {
      name: "missing Approval Identity",
      state: { ...baseState, approval: null },
    },
    {
      name: "mismatched Approval Identity",
      state: {
        ...baseState,
        approvedPlanHash: hashPlan("different approved plan").value,
      },
    },
    {
      name: "active Implementation Coordinator",
      state: {
        ...baseState,
        implementationStatus: "RUNNING",
        implementationRunId: createRunId("existing-implementation-run"),
      },
    },
  ];

  for (const testCase of cases) {
    let spawnCalled = false;
    const result = await launch(
      {
        getState: () => testCase.state,
        getActiveWorkflowRequest: () => request,
      },
      async () => {
        spawnCalled = true;
        return {
          requestId: "00000000-0000-4000-8000-000000000015",
          runId: createRunId("unexpected-implementation-run"),
        };
      },
    );

    expect(result.started, testCase.name).toBe(false);
    expect(spawnCalled, testCase.name).toBe(false);
  }
});

it("refuses every invalid phase-boundary input without spawning", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "pi-workflow-implementation-invalid-"),
  );
  roots.push(root);
  const artifacts = writeArtifacts(root);
  const registry = approvedRegistry(artifacts);
  let spawnCount = 0;
  const spawn = async (_input: ImplementationCoordinatorInput) => {
    spawnCount += 1;
    return {
      requestId: "unexpected",
      runId: createRunId("implementation-run"),
    };
  };
  const validHandoff = readFileSync(artifacts.handoffPath, "utf8");

  rmSync(artifacts.planPath);
  expect((await launch(registry, spawn)).started).toBe(false);
  expect(spawnCount).toBe(0);

  writeFileSync(artifacts.planPath, "# Implementation Plan\n");
  expect((await launch(registry, spawn)).started).toBe(false);
  expect(spawnCount).toBe(0);

  writeFileSync(artifacts.planPath, PLAN);
  rmSync(artifacts.handoffPath);
  expect((await launch(registry, spawn)).started).toBe(false);
  expect(spawnCount).toBe(0);

  writeFileSync(artifacts.handoffPath, validHandoff);
  writeFileSync(artifacts.planPath, `${PLAN}changed after approval\n`);
  expect((await launch(registry, spawn)).started).toBe(false);
  expect(spawnCount).toBe(0);

  writeFileSync(artifacts.planPath, PLAN);
  writeFileSync(
    artifacts.handoffPath,
    `${JSON.stringify({
      ...JSON.parse(readFileSync(artifacts.handoffPath, "utf8")),
      approval: true,
    })}\n`,
  );
  expect((await launch(registry, spawn)).started).toBe(false);
  expect(spawnCount).toBe(0);

  const noApproval = new RootWorkflowRegistry(() => undefined);
  expect(noApproval.start(WORKFLOW_ID, "feature").started).toBe(true);
  expect(
    noApproval.bindWorkflowRequest({
      workflowId: WORKFLOW_ID,
      workflowType: "feature",
      request: "request",
      cwd: "/repo",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  ).toBe(true);
  expect(noApproval.setPlanningRunId("planning-run").transitioned).toBe(true);
  expect(
    noApproval.completePlanning(
      "planning-run",
      planningResult(artifacts.planPath, artifacts.handoffPath),
    ).transitioned,
  ).toBe(true);
  expect((await launch(noApproval, spawn)).started).toBe(false);
  expect(spawnCount).toBe(0);
});

it("rejects a run ID reused from Planning", async () => {
  const root = mkdtempSync(
    join(tmpdir(), "pi-workflow-implementation-run-id-"),
  );
  roots.push(root);
  const artifacts = writeArtifacts(root);
  const registry = approvedRegistry(artifacts);
  let spawnCount = 0;

  const result = await launch(registry, async () => {
    spawnCount += 1;
    return {
      requestId: "00000000-0000-4000-8000-000000000015",
      runId: createRunId("planning-run"),
    };
  });

  expect(result.started).toBe(false);
  expect(spawnCount).toBe(1);
  expect(registry.getState()).toMatchObject({
    phase: "PLAN_REVIEW",
    approval: true,
  });
});
