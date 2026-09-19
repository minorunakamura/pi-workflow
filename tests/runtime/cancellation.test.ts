import { expect, it } from "vitest";

import {
  createRequestId,
  createPlanningHandoff,
  createReviewId,
  createRunId,
  createWorkflowId,
  hashPlan,
  isRecord,
} from "../../src/core/index.ts";
import { registerSessionLifecycle } from "../../src/events/index.ts";
import { RootCancellationController } from "../../src/runtime/cancellation.ts";
import { RootWorkflowRegistry } from "../../src/runtime/root-lifecycle.ts";
import type { SubagentRpcEventBus } from "../../src/runtime/subagents-rpc.ts";

const WORKFLOW_UUID = "00000000-0000-4000-8000-000000000091";
const REQUEST_UUID = "00000000-0000-4000-8000-000000000092";

type Handler = (...args: unknown[]) => unknown;

class FakeEventBus implements SubagentRpcEventBus {
  private readonly handlers = new Map<string, Set<(value: unknown) => void>>();

  public on(event: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  public emit(event: string, value: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(value);
  }
}

it("clears pending interaction on cancellation and keeps the terminal guard", () => {
  const entries: unknown[] = [];
  const registry = new RootWorkflowRegistry((_type, data) => {
    entries.push(data);
  });

  expect(
    registry.start(createWorkflowId(WORKFLOW_UUID), "feature").started,
  ).toBe(true);
  expect(
    registry.setPlanningRunId(createRunId("planning-run")).transitioned,
  ).toBe(true);
  expect(
    registry.setPendingInteraction({
      kind: "human",
      requestId: createRequestId(REQUEST_UUID),
      coordinatorRunId: createRunId("planning-run"),
    }).transitioned,
  ).toBe(true);

  expect(registry.transition("CANCELLED")).toMatchObject({
    transitioned: true,
    state: { phase: "CANCELLED", finalStatus: "CANCELLED" },
  });
  expect(registry.getState()).not.toHaveProperty("pendingInteraction");
  expect(registry.transition("CANCELLED").transitioned).toBe(false);
  expect(registry.transition("PLANNING").transitioned).toBe(false);
  expect(entries).toHaveLength(4);
});

it("persists CANCELLED before terminalizing bridges, stops once, and replays the terminal result", async () => {
  const entries: unknown[] = [];
  const calls: string[] = [];
  const registry = new RootWorkflowRegistry((_type, data) => {
    entries.push(data);
  });
  const workflowId = createWorkflowId(WORKFLOW_UUID);
  expect(registry.start(workflowId, "feature").started).toBe(true);
  expect(registry.setPlanningRunId("planning-run").transitioned).toBe(true);

  const controller = new RootCancellationController({
    registry,
    getBridges: () => [
      {
        dispose: (options) => {
          calls.push(`bridge:${String(options?.preserveRootState)}`);
        },
      },
      {
        dispose: (options) => {
          calls.push(`plan:${String(options?.preserveRootState)}`);
        },
      },
      {
        dispose: (options) => {
          calls.push(`code:${String(options?.preserveRootState)}`);
        },
      },
    ],
    stopCoordinator: async () => {
      calls.push("stop");
      return { success: false, error: { code: "unknown", message: "stop" } };
    },
  });

  const first = await controller.requestWorkflowCancellation(workflowId);
  expect(first).toMatchObject({
    accepted: true,
    duplicate: false,
    state: {
      phase: "CANCELLED",
      finalStatus: "CANCELLED",
      cancellationOutcome: {
        coordinatorRunId: "planning-run",
        stop: "failed",
      },
      diagnostics: [
        expect.objectContaining({
          kind: "cancellation",
          code: "COORDINATOR_STOP_FAILED",
          runId: "planning-run",
        }),
      ],
    },
  });
  expect(calls).toEqual(["bridge:true", "plan:true", "code:true", "stop"]);
  const persistedStates = entries.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null,
  );
  const cancelledIndex = persistedStates.findIndex(
    (entry) => entry.phase === "CANCELLED",
  );
  const outcomeIndex = persistedStates.findIndex(
    (entry) => typeof entry.cancellationOutcome === "object",
  );
  expect(cancelledIndex).toBeGreaterThanOrEqual(0);
  expect(outcomeIndex).toBeGreaterThan(cancelledIndex);

  const duplicate = await controller.requestWorkflowCancellation(workflowId);
  expect(duplicate).toMatchObject({
    accepted: true,
    duplicate: true,
    stopStatus: "failed",
  });
  expect(calls).toEqual(["bridge:true", "plan:true", "code:true", "stop"]);
  expect(registry.transition("PLANNING").transitioned).toBe(false);
});

it("keeps CANCELLED when the stop outcome is unavailable", async () => {
  const registry = new RootWorkflowRegistry(() => undefined);
  const workflowId = createWorkflowId("00000000-0000-4000-8000-000000000093");
  expect(registry.start(workflowId, "bug").started).toBe(true);
  expect(registry.setPlanningRunId("planning-run").transitioned).toBe(true);
  const controller = new RootCancellationController({
    registry,
    getBridges: () => [],
  });

  const result = await controller.requestWorkflowCancellation(workflowId);
  expect(result).toMatchObject({
    accepted: true,
    state: { phase: "CANCELLED", finalStatus: "CANCELLED" },
    stopStatus: "unknown",
  });
});

it("binds Pi quit shutdown to the Root cancellation use-case", async () => {
  const events = new FakeEventBus();
  const entries: unknown[] = [];
  const calls: string[] = [];
  const registry = new RootWorkflowRegistry((_type, data) => {
    entries.push(data);
  });
  const handlers = new Map<string, Handler>();
  registerSessionLifecycle(
    {
      on(event, handler) {
        handlers.set(event, (eventValue, context) =>
          Reflect.apply(handler, undefined, [eventValue, context]),
        );
      },
      events,
    },
    registry,
    () => calls.push("cleanup"),
    async () => {
      calls.push("stop");
      return { success: true };
    },
  );
  const context = {
    mode: "tui",
    sessionManager: {
      getBranch: () => [],
      getSessionFile: () => "/sessions/current.jsonl",
      getSessionId: () => "session-current",
    },
  };
  const sessionStart = handlers.get("session_start");
  if (sessionStart === undefined) throw new Error("Missing session_start");
  Reflect.apply(sessionStart, undefined, [undefined, context]);
  const workflowId = createWorkflowId("00000000-0000-4000-8000-000000000096");
  expect(registry.start(workflowId, "feature").started).toBe(true);
  expect(registry.setPlanningRunId("planning-run").transitioned).toBe(true);

  const shutdown = handlers.get("session_shutdown");
  if (shutdown === undefined) throw new Error("Missing session_shutdown");
  await Reflect.apply(shutdown, undefined, [{ reason: "quit" }, context]);

  expect(calls).toEqual(["stop", "cleanup"]);
  expect(registry.getState()).toBeUndefined();
  expect(
    entries.some((entry) => {
      if (!isRecord(entry)) return false;
      return entry.phase === "CANCELLED" && entry.finalStatus === "CANCELLED";
    }),
  ).toBe(true);
});

it("cancels an active Implementation Coordinator once and keeps CANCELLED on stop failure", async () => {
  const events = new FakeEventBus();
  const calls: string[] = [];
  const workflowId = createWorkflowId(WORKFLOW_UUID);
  const plan = "approved plan";
  const handoff = createPlanningHandoff({
    workflowId,
    planContent: plan,
    tddMode: "not-applicable",
    testStrategy: { kind: "unit", required: true, summary: "Run tests." },
    testSeams: ["cancellation"],
    constraints: [],
    nonGoals: ["Do not merge."],
    planningRunId: createRunId("planning-run"),
  });
  if (!handoff.valid) throw new Error(handoff.errors.join("; "));
  const registry = new RootWorkflowRegistry((_type, data) => {
    void data;
    calls.push("persist");
  });
  const handlers = new Map<string, Handler>();
  let releaseStop: (() => void) | undefined;
  const stop = () => {
    calls.push("stop");
    return new Promise<unknown>((resolve) => {
      releaseStop = () =>
        resolve({
          success: false,
          error: { code: "stop-failed", message: "stop failed" },
        });
    });
  };

  const cancellation = registerSessionLifecycle(
    {
      on(event, handler) {
        handlers.set(event, (eventValue, context) =>
          Reflect.apply(handler, undefined, [eventValue, context]),
        );
      },
      events,
    },
    registry,
    () => calls.push("cleanup"),
    async () => undefined,
    undefined,
    undefined,
    stop,
  );

  const context = {
    mode: "tui",
    sessionManager: {
      getBranch: () => [],
      getSessionFile: () => "/sessions/current.jsonl",
      getSessionId: () => "session-current",
    },
  };
  const sessionStart = handlers.get("session_start");
  if (sessionStart === undefined) throw new Error("Missing session_start");
  await Reflect.apply(sessionStart, undefined, [undefined, context]);

  expect(registry.start(workflowId, "feature").started).toBe(true);
  expect(
    registry.bindWorkflowRequest({
      workflowId,
      workflowType: "feature",
      request: "cancel safely",
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
        { capability: "plan-composition", reason: "A plan is required." },
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
      createRequestId(REQUEST_UUID),
      createReviewId("plan-review"),
    ).transitioned,
  ).toBe(true);
  expect(
    registry.recordPlanApproval(
      {
        approvedPlanHash: hashPlan(plan).value,
        reviewId: createReviewId("plan-review"),
        approval: true,
      },
      hashPlan(plan).value,
      handoff.value,
    ).transitioned,
  ).toBe(true);
  expect(registry.startImplementation("implementation-run").transitioned).toBe(
    true,
  );
  calls.length = 0;

  const first = cancellation.requestWorkflowCancellation(workflowId);
  const second = cancellation.requestWorkflowCancellation(workflowId);
  await Promise.resolve();
  expect(calls).toEqual(["persist", "stop"]);

  releaseStop?.();
  const results = await Promise.all([first, second]);
  expect(results[0]).toMatchObject({
    accepted: true,
    duplicate: false,
    stopStatus: "failed",
    state: {
      phase: "CANCELLED",
      implementationRunId: "implementation-run",
    },
  });
  expect(results[1]).toMatchObject({
    accepted: true,
    duplicate: false,
    stopStatus: "failed",
  });
  expect(calls).toEqual(["persist", "stop", "persist", "persist"]);
  expect(registry.getState()).toMatchObject({
    phase: "CANCELLED",
    finalStatus: "CANCELLED",
    cancellationOutcome: {
      coordinatorRunId: "implementation-run",
      stop: "failed",
    },
  });
});
