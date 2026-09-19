import { expect, it } from "vitest";

import {
  createRequestId,
  createPlanningHandoff,
  createReviewId,
  createRunId,
  createWorkflowId,
  hashPlan,
} from "../../src/core/index.ts";
import { registerSessionLifecycle } from "../../src/events/index.ts";
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

it("stops an active Implementation Coordinator once before stale failure persistence", async () => {
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
    return new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
  };

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

  const shutdown = handlers.get("session_shutdown");
  if (shutdown === undefined) throw new Error("Missing session_shutdown");
  const first = Reflect.apply(shutdown, undefined, [undefined, context]);
  const second = Reflect.apply(shutdown, undefined, [undefined, context]);
  await Promise.resolve();
  expect(calls).toEqual(["stop"]);

  releaseStop?.();
  await Promise.all([first, second]);
  expect(calls).toEqual(["stop", "persist", "cleanup"]);
  expect(registry.getState()).toBeUndefined();
});
