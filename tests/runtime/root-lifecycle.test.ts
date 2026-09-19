import { expect, it } from "vitest";

import { beforeTreeNavigation } from "../../src/events/index.ts";
import {
  createInitialWorkflowState,
  createPlanningHandoff,
  createRunId,
  createWorkflowId,
  hashPlan,
  transitionPhase,
  transitionRootWorkflowState,
  validateRootWorkflowState,
  type RootWorkflowState,
  type WorkflowPhase,
} from "../../src/core/index.ts";
import {
  ROOT_LIFECYCLE_ENTRY_TYPE,
  RootWorkflowRegistry,
  persistRootWorkflowState,
  restoreRootWorkflowState,
} from "../../src/runtime/root-lifecycle.ts";

const UUID = "00000000-0000-4000-8000-000000000001";
const SECOND_UUID = "00000000-0000-4000-8000-000000000002";

type LifecycleEntry = {
  type: "custom";
  customType: typeof ROOT_LIFECYCLE_ENTRY_TYPE;
  data: unknown;
};

function initialState(): RootWorkflowState {
  return createInitialWorkflowState(createWorkflowId(UUID), "feature");
}

function stateAt(phase: WorkflowPhase): RootWorkflowState {
  const state = initialState();
  switch (phase) {
    case "IDLE":
      return state;
    case "PLANNING":
      return { ...state, phase, planningStatus: "RUNNING" };
    case "PLAN_REVIEW":
      return { ...state, phase, planningStatus: "COMPLETED" };
    case "IMPLEMENTING":
      return {
        ...state,
        phase,
        planningStatus: "COMPLETED",
        implementationStatus: "RUNNING",
      };
    case "CODE_REVIEW":
      return {
        ...state,
        phase,
        planningStatus: "COMPLETED",
        implementationStatus: "COMPLETED",
      };
    case "READY_FOR_MERGE":
      return {
        ...state,
        phase,
        planningStatus: "COMPLETED",
        implementationStatus: "COMPLETED",
        finalStatus: "READY_FOR_MERGE",
      };
    case "FAILED":
      return { ...state, phase, finalStatus: "FAILED" };
    case "CANCELLED":
      return { ...state, phase, finalStatus: "CANCELLED" };
    default:
      throw new Error("Unsupported phase");
  }
}

function entry(data: RootWorkflowState): LifecycleEntry {
  return {
    type: "custom",
    customType: ROOT_LIFECYCLE_ENTRY_TYPE,
    data,
  };
}

function persistedEntries() {
  const entries: LifecycleEntry[] = [];
  return {
    entries,
    append: (customType: string, data?: unknown): void => {
      if (customType === ROOT_LIFECYCLE_ENTRY_TYPE) {
        entries.push({
          type: "custom",
          customType: ROOT_LIFECYCLE_ENTRY_TYPE,
          data,
        });
      }
    },
  };
}

it("persists only compact Root state and restores the latest valid branch snapshot", () => {
  const store = persistedEntries();
  const registry = new RootWorkflowRegistry(store.append);

  const started = registry.start(createWorkflowId(UUID), "feature");
  expect(started.started).toBe(true);
  if (!started.started) {
    return;
  }
  expect(store.entries).toHaveLength(1);
  expect(store.entries[0]?.data).toEqual(started.state);
  expect(Object.hasOwn(started.state, "request")).toBe(false);
  expect(Object.hasOwn(started.state, "cwd")).toBe(false);

  const restored = restoreRootWorkflowState([
    store.entries[0],
    entry(Object.assign({}, started.state, { request: "raw request" })),
    { type: "custom", customType: "other-extension", data: "ignored" },
  ]);
  expect(restored).toMatchObject({
    phase: "FAILED",
    finalStatus: "FAILED",
  });
});

it("attaches one opaque planning run identity without advancing the phase", () => {
  const store = persistedEntries();
  const registry = new RootWorkflowRegistry(store.append);
  expect(registry.start(createWorkflowId(UUID), "feature").started).toBe(true);

  expect(registry.setPlanningRunId(createRunId("planning-run"))).toMatchObject({
    transitioned: true,
    state: {
      phase: "PLANNING",
      planningStatus: "RUNNING",
      planningRunId: "planning-run",
    },
  });
  expect(registry.setPlanningRunId(createRunId("second-run"))).toEqual({
    transitioned: false,
    reason: "Planning run identity cannot be attached",
  });
  expect(registry.setPlanningRunId("\ninvalid")).toEqual({
    transitioned: false,
    reason: "Planning run identity cannot be attached",
  });
  expect(store.entries).toHaveLength(2);
});

it("allows IDLE to PLANNING and active states to fail or cancel", () => {
  const failed = new RootWorkflowRegistry(() => undefined);
  expect(failed.start(createWorkflowId(UUID), "feature").started).toBe(true);
  expect(failed.transition("FAILED")).toMatchObject({
    transitioned: true,
    state: { phase: "FAILED", finalStatus: "FAILED" },
  });

  const cancelled = new RootWorkflowRegistry(() => undefined);
  expect(cancelled.start(createWorkflowId(SECOND_UUID), "bug").started).toBe(
    true,
  );
  expect(cancelled.transition("CANCELLED")).toMatchObject({
    transitioned: true,
    state: { phase: "CANCELLED", finalStatus: "CANCELLED" },
  });
});

it("rejects condition-blind phase advances in Root state mutation", () => {
  expect(
    transitionRootWorkflowState(stateAt("PLAN_REVIEW"), "IMPLEMENTING"),
  ).toEqual({
    valid: false,
    reason: "Phase advance requires a later Step precondition",
  });
  expect(
    transitionRootWorkflowState(stateAt("IMPLEMENTING"), "CODE_REVIEW"),
  ).toEqual({
    valid: false,
    reason: "Phase advance requires a later Step precondition",
  });
  expect(
    transitionRootWorkflowState(stateAt("CODE_REVIEW"), "READY_FOR_MERGE"),
  ).toEqual({
    valid: false,
    reason: "Phase advance requires a later Step precondition",
  });
  expect(
    transitionRootWorkflowState(stateAt("PLAN_REVIEW"), "PLAN_REVIEW"),
  ).toEqual({
    valid: false,
    reason: "Invalid transition: PLAN_REVIEW -> PLAN_REVIEW",
  });
  expect(
    transitionRootWorkflowState(stateAt("READY_FOR_MERGE"), "FAILED").valid,
  ).toBe(false);

  expect(transitionPhase("PLAN_REVIEW", "IMPLEMENTING").valid).toBe(true);
});

it("records Ready-for-Merge only from a completed approved coordinator result", () => {
  const registry = new RootWorkflowRegistry(() => undefined);
  const workflowId = createWorkflowId("00000000-0000-4000-8000-000000000003");
  const plan = "approved plan";
  const handoff = createPlanningHandoff({
    workflowId,
    planContent: plan,
    tddMode: "not-applicable",
    testStrategy: { kind: "unit", required: true, summary: "Run tests." },
    testSeams: ["readiness"],
    constraints: [],
    nonGoals: ["Do not merge."],
    planningRunId: createRunId("planning-run"),
  });
  if (!handoff.valid) throw new Error(handoff.errors.join("; "));

  expect(registry.start(workflowId, "feature").started).toBe(true);
  expect(
    registry.bindWorkflowRequest({
      workflowId,
      workflowType: "feature",
      request: "complete the workflow",
      cwd: "/repo",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  ).toBe(true);
  expect(registry.setPlanningRunId("planning-run").transitioned).toBe(true);
  expect(
    registry.completePlanning("planning-run", {
      contractVersion: 1,
      workflowId,
      status: "COMPLETED",
      planArtifactRef: {
        kind: "managed",
        path: "run/implementation-plan.md",
        mediaType: "text/markdown",
      },
      planningHandoffRef: {
        kind: "managed",
        path: "run/planning-handoff.json",
        mediaType: "application/json",
      },
      selectedCapabilities: [
        { capability: "scout", reason: "Repository evidence." },
        {
          capability: "plan-composition",
          reason: "A Plan Artifact is required.",
        },
      ],
      skippedCapabilities: [
        { capability: "researcher", reason: "No external fact." },
        { capability: "grilling", reason: "No ambiguity." },
        { capability: "human-decision", reason: "No product decision." },
        { capability: "targeted-rescout", reason: "No changed evidence." },
        { capability: "oracle", reason: "No challenge needed." },
      ],
      remainingBlockers: [],
    }).transitioned,
  ).toBe(true);
  expect(
    registry.setPlanReviewPending(
      "00000000-0000-4000-8000-000000000004",
      "plan-review",
    ).transitioned,
  ).toBe(true);
  expect(
    registry.recordPlanApproval(
      {
        approvedPlanHash: hashPlan(plan).value,
        reviewId: "plan-review",
        approval: true,
      },
      hashPlan(plan).value,
      handoff.value,
    ).transitioned,
  ).toBe(true);
  expect(registry.startImplementation("implementation-run").transitioned).toBe(
    true,
  );
  expect(
    registry.setCodeReviewPending(
      "00000000-0000-4000-8000-000000000005",
      "implementation-run",
    ).transitioned,
  ).toBe(true);
  expect(
    registry.recordCodeReviewResult({
      requestId: "00000000-0000-4000-8000-000000000005",
      status: "approved",
      approved: true,
    }).transitioned,
  ).toBe(true);

  const result = registry.completeImplementation("implementation-run", {
    contractVersion: 1,
    workflowId,
    status: "COMPLETED",
    workerArtifactRefs: [],
    reviewerArtifactRefs: [],
    fixArtifactRefs: [],
    reReviewArtifactRefs: [],
    readyForMerge: {
      ready: true,
      status: "READY_FOR_MERGE",
      checks: [
        "approved-plan-identity",
        "implementation-complete",
        "required-gates",
        "accepted-findings",
        "focused-re-review",
        "final-diff-inspection",
        "code-review",
      ].map((id) => ({ id, status: "PASS", reason: "passed" })),
      blockers: [],
    },
    remainingBlockers: [],
  });

  expect(result).toMatchObject({
    transitioned: true,
    state: { phase: "READY_FOR_MERGE", finalStatus: "READY_FOR_MERGE" },
  });
});

it("blocks tree navigation only while a workflow is active", () => {
  const none = new RootWorkflowRegistry(() => undefined);
  expect(beforeTreeNavigation(none)).toBeUndefined();

  const active = new RootWorkflowRegistry(() => undefined);
  expect(active.start(createWorkflowId(UUID), "feature").started).toBe(true);
  expect(beforeTreeNavigation(active)).toEqual({ cancel: true });

  expect(active.transition("FAILED").transitioned).toBe(true);
  expect(beforeTreeNavigation(active)).toBeUndefined();
});

it("blocks terminal mutation and does not create a cross-session lock", () => {
  const first = new RootWorkflowRegistry(() => undefined);
  const second = new RootWorkflowRegistry(() => undefined);

  expect(first.start(createWorkflowId(UUID), "feature").started).toBe(true);
  expect(first.transition("PLANNING")).toEqual({
    transitioned: false,
    reason: "Invalid transition: PLANNING -> PLANNING",
  });
  expect(first.transition("FAILED").transitioned).toBe(true);
  expect(first.transition("PLANNING").transitioned).toBe(false);
  expect(second.start(createWorkflowId(SECOND_UUID), "bug").started).toBe(true);
});

it("restores terminal snapshots and converts active snapshots to persisted stale failure", () => {
  const activeStore = persistedEntries();
  const active = new RootWorkflowRegistry(activeStore.append);
  expect(active.start(createWorkflowId(UUID), "feature").started).toBe(true);

  const restarted = new RootWorkflowRegistry(activeStore.append);
  const restored = restarted.restore(activeStore.entries);
  expect(restored).toMatchObject({ phase: "FAILED", finalStatus: "FAILED" });
  expect(activeStore.entries).toHaveLength(2);
  expect(activeStore.entries.at(-1)?.data).toMatchObject({
    phase: "FAILED",
    finalStatus: "FAILED",
  });
  expect(restarted.start(createWorkflowId(SECOND_UUID), "chore").started).toBe(
    true,
  );

  const terminalStore = persistedEntries();
  const terminal = new RootWorkflowRegistry(terminalStore.append);
  terminalStore.entries.push(entry(stateAt("FAILED")));
  expect(terminal.restore(terminalStore.entries)).toMatchObject({
    phase: "FAILED",
    finalStatus: "FAILED",
  });
  expect(terminalStore.entries).toHaveLength(1);
});

it("persists stale failure before clearing the registry on shutdown", () => {
  const store = persistedEntries();
  const registry = new RootWorkflowRegistry(store.append);
  expect(registry.start(createWorkflowId(UUID), "feature").started).toBe(true);

  registry.shutdown();

  expect(registry.getState()).toBeUndefined();
  expect(store.entries.at(-1)?.data).toMatchObject({
    phase: "FAILED",
    finalStatus: "FAILED",
  });
});

it("fails closed when stale failure persistence fails", () => {
  let appendCount = 0;
  const registry = new RootWorkflowRegistry((customType, data) => {
    appendCount += 1;
    if (appendCount > 1) {
      throw new Error("persistence failed");
    }
    void customType;
    void data;
  });
  expect(registry.start(createWorkflowId(UUID), "feature").started).toBe(true);

  expect(() => registry.shutdown()).toThrow("persistence failed");
  expect(registry.getState()).toBeUndefined();
});

it("keeps bounded transition counters at zero or one across validation and persistence", () => {
  const initial = initialState();
  expect(initial.planResubmissionCount).toBe(0);
  expect(initial.codeReviewChangeCycleCount).toBe(0);
  expect(
    validateRootWorkflowState({
      ...initial,
      planResubmissionCount: 1,
      codeReviewChangeCycleCount: 1,
    }).valid,
  ).toBe(true);

  for (const invalidCount of [-1, 2, 1.5, Number.NaN, "1"]) {
    expect(
      validateRootWorkflowState({
        ...initial,
        planResubmissionCount: invalidCount,
      }).valid,
    ).toBe(false);
    expect(
      validateRootWorkflowState({
        ...initial,
        codeReviewChangeCycleCount: invalidCount,
      }).valid,
    ).toBe(false);
  }

  const store = persistedEntries();
  const counted = {
    ...initial,
    planResubmissionCount: 1,
    codeReviewChangeCycleCount: 1,
  };
  persistRootWorkflowState(store.append, counted);
  const registry = new RootWorkflowRegistry(store.append);
  expect(registry.restore(store.entries)).toMatchObject(counted);
  expect(
    transitionRootWorkflowState(stateAt("PLAN_REVIEW"), "IMPLEMENTING"),
  ).toEqual({
    valid: false,
    reason: "Phase advance requires a later Step precondition",
  });
});

it("refuses invalid snapshots and raw content", () => {
  const state = initialState();
  expect(
    restoreRootWorkflowState([
      entry({ ...state, planResubmissionCount: 2 }),
      entry(Object.assign({}, state, { request: "raw request" })),
    ]),
  ).toBeUndefined();
  expect(() =>
    persistRootWorkflowState(
      () => undefined,
      Object.assign({}, state, { request: "raw request" }),
    ),
  ).toThrow("invalid Root workflow state");
});
