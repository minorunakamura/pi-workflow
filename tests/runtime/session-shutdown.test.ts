import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

import {
  createPlanningHandoff,
  createRequestId,
  createReviewId,
  createRunId,
  createWorkflowId,
  hashPlan,
  isRecord,
  type WorkflowId,
} from "../../src/core/index.ts";
import { registerSessionLifecycle } from "../../src/events/index.ts";
import {
  CODE_REVIEW_NAMESPACE,
  INTERCOM_EXTENSION_REGISTER_EVENT,
  CodeReviewChildBridge,
  type IntercomExtensionChannel,
  type IntercomExtensionRegistration,
} from "../../src/runtime/code-review-bridge.ts";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_RPC_READY_EVENT,
  SUBAGENT_RPC_REQUEST_EVENT,
  SubagentRpcAdapter,
  isValidSubagentRpcRequest,
  subagentRpcReplyEvent,
  type SubagentRpcEventBus,
} from "../../src/runtime/subagents-rpc.ts";
import { RootWorkflowRegistry } from "../../src/runtime/root-lifecycle.ts";

const UUID = "00000000-0000-4000-8000-000000000001";
const ROOT_SESSION_ID = "root-session";
const CHILD_SESSION_ID = "child-session";
const ROOT_OWNER = { sessionId: ROOT_SESSION_ID, epoch: "root-epoch" };

type Handler = (data: unknown) => void;

class FakeEventBus implements SubagentRpcEventBus {
  private readonly handlers = new Map<string, Set<Handler>>();

  public on(event: string, handler: Handler): () => void {
    const handlers = this.handlers.get(event) ?? new Set<Handler>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(event);
    };
  }

  public emit(event: string, data: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      handler(data);
    }
  }

  public listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

function isRegistration(
  value: unknown,
): value is IntercomExtensionRegistration {
  return (
    isRecord(value) &&
    typeof value.namespace === "string" &&
    typeof value.ownerEligible === "boolean" &&
    typeof value.onEvent === "function" &&
    typeof value.onReady === "function"
  );
}

function connectCodeReviewIntercom(
  rootEvents: FakeEventBus,
  childEvents: FakeEventBus,
): void {
  let rootRegistration: IntercomExtensionRegistration | undefined;
  let childRegistration: IntercomExtensionRegistration | undefined;
  const channel = (side: "root" | "child"): IntercomExtensionChannel => ({
    namespace: CODE_REVIEW_NAMESPACE,
    snapshot: () => ({
      connected: true,
      supported: true,
      owner: ROOT_OWNER,
    }),
    publish(payload, options = {}) {
      if (side === "root") {
        if (options.audience === "capable") {
          childRegistration?.onEvent({
            type: "message",
            fromSessionId: ROOT_SESSION_ID,
            owner: ROOT_OWNER,
            payload,
          });
        }
        return;
      }
      if (options.audience === "owner") {
        rootRegistration?.onEvent({
          type: "message",
          fromSessionId: CHILD_SESSION_ID,
          owner: ROOT_OWNER,
          payload,
        });
      }
    },
  });
  rootEvents.on(INTERCOM_EXTENSION_REGISTER_EVENT, (value) => {
    if (!isRegistration(value)) return;
    rootRegistration = value;
    rootRegistration.onReady(channel("root"));
  });
  childEvents.on(INTERCOM_EXTENSION_REGISTER_EVENT, (value) => {
    if (!isRegistration(value)) return;
    childRegistration = value;
    childRegistration.onReady(channel("child"));
  });
}

function prepareImplementationRegistry(
  registry: RootWorkflowRegistry,
  workflowId: WorkflowId,
): void {
  const plan = "approved plan";
  const handoff = createPlanningHandoff({
    workflowId,
    planContent: plan,
    tddMode: "not-applicable",
    testStrategy: { kind: "unit", required: true, summary: "Run tests." },
    testSeams: ["shutdown"],
    constraints: [],
    nonGoals: ["Do not merge."],
    planningRunId: createRunId("planning-run"),
  });
  if (!handoff.valid) throw new Error(handoff.errors.join("; "));
  if (!registry.start(workflowId, "feature").started) {
    throw new Error("Could not start test workflow");
  }
  if (
    !registry.bindWorkflowRequest({
      workflowId,
      workflowType: "feature",
      request: "review the implementation",
      cwd: "/repo",
      createdAt: "2026-01-01T00:00:00.000Z",
    }) ||
    !registry.setPlanningRunId("planning-run").transitioned
  ) {
    throw new Error("Could not bind test workflow");
  }
  if (
    !registry.completePlanning("planning-run", {
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
    }).transitioned
  ) {
    throw new Error("Could not complete test planning");
  }
  const reviewId = createReviewId("plan-review");
  if (
    !registry.setPlanReviewPending(
      createRequestId("00000000-0000-4000-8000-000000000094"),
      reviewId,
    ).transitioned ||
    !registry.recordPlanApproval(
      { approvedPlanHash: hashPlan(plan).value, reviewId, approval: true },
      hashPlan(plan).value,
      handoff.value,
    ).transitioned ||
    !registry.startImplementation("implementation-run").transitioned
  ) {
    throw new Error("Could not prepare implementation state");
  }
}

function sessionContext(sessionId: string) {
  return {
    sessionManager: {
      getBranch: () => [],
      getSessionFile: () => undefined,
      getSessionId: () => sessionId,
    },
  };
}

async function invoke(
  handlers: Map<string, unknown>,
  event: string,
  context: unknown,
): Promise<void> {
  const handler = handlers.get(event);
  if (typeof handler !== "function") {
    throw new Error(`Missing ${event} handler`);
  }
  const result = Reflect.apply(handler, undefined, [undefined, context]);
  if (result instanceof Promise) await result;
}

function registeredLifecycle(
  events: FakeEventBus,
  registry: RootWorkflowRegistry,
  cleanup: () => void,
  stop: (runId: string) => Promise<unknown>,
): Map<string, unknown> {
  const handlers = new Map<string, unknown>();
  const pi: Pick<ExtensionAPI, "on" | "events"> = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    events,
  };
  registerSessionLifecycle(pi, registry, cleanup, stop);
  return handlers;
}

it("stops the known planning run before persisting stale failure and cleaning up", async () => {
  const events = new FakeEventBus();
  const order: string[] = [];
  const registry = new RootWorkflowRegistry(() => order.push("persist"));
  const rpc = new SubagentRpcAdapter(events);
  events.emit(SUBAGENT_RPC_READY_EVENT, {
    version: 1,
    methods: ["ping", "status", "spawn", "stop"],
    capabilities: { asyncSpawn: true },
  });
  events.on(SUBAGENT_RPC_REQUEST_EVENT, (raw) => {
    if (!isValidSubagentRpcRequest(raw)) return;
    const request = raw;
    if (request.method !== "stop") return;
    order.push(`stop:${String(request.params?.id)}`);
    events.emit(subagentRpcReplyEvent(request.requestId), {
      version: 1,
      requestId: request.requestId,
      method: "stop",
      success: true,
      data: { stopped: true },
    });
  });
  const handlers = registeredLifecycle(
    events,
    registry,
    () => {
      order.push("cleanup");
      rpc.dispose();
    },
    (runId) => rpc.stop(runId),
  );
  let sessionFileReads = 0;
  let sessionIdReads = 0;
  const context = {
    sessionManager: {
      getBranch: () => [],
      getSessionFile: () => {
        sessionFileReads += 1;
        return "/sessions/current.jsonl";
      },
      getSessionId: () => {
        sessionIdReads += 1;
        return "logical-session-id";
      },
    },
  };
  const sessionStart = handlers.get("session_start");
  if (typeof sessionStart !== "function")
    throw new Error("Missing session_start handler");
  Reflect.apply(sessionStart, undefined, [undefined, context]);

  expect(registry.start(createWorkflowId(UUID), "feature").started).toBe(true);
  expect(
    registry.setPlanningRunId(createRunId("planning-run")).transitioned,
  ).toBe(true);
  events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    runId: "planning-run",
    sessionId: "/sessions/foreign.jsonl",
    state: "failed",
    success: false,
  });
  expect(registry.getState()).toMatchObject({
    phase: "PLANNING",
    finalStatus: "NONE",
  });
  order.length = 0;

  await invoke(handlers, "session_shutdown", context);

  expect(sessionFileReads).toBe(1);
  expect(sessionIdReads).toBe(0);
  expect(order).toEqual(["stop:planning-run", "persist", "cleanup"]);
  expect(registry.getState()).toBeUndefined();
  expect(events.listenerCount(SUBAGENT_ASYNC_COMPLETE_EVENT)).toBe(0);
  expect(events.listenerCount(SUBAGENT_RPC_READY_EVENT)).toBe(0);
});

it("persists failure and cleans up even when the public stop rejects, without retrying", async () => {
  const events = new FakeEventBus();
  const order: string[] = [];
  const registry = new RootWorkflowRegistry(() => order.push("persist"));
  let stopCalls = 0;
  const handlers = registeredLifecycle(
    events,
    registry,
    () => order.push("cleanup"),
    async () => {
      stopCalls += 1;
      throw new Error("stop timeout");
    },
  );
  const sessionStart = handlers.get("session_start");
  if (typeof sessionStart !== "function")
    throw new Error("Missing session_start handler");
  Reflect.apply(sessionStart, undefined, [
    undefined,
    sessionContext("session-current"),
  ]);
  expect(registry.start(createWorkflowId(UUID), "feature").started).toBe(true);
  expect(
    registry.setPlanningRunId(createRunId("planning-run")).transitioned,
  ).toBe(true);
  order.length = 0;

  await invoke(handlers, "session_shutdown", sessionContext("session-current"));

  expect(stopCalls).toBe(1);
  expect(order).toEqual(["persist", "cleanup"]);
  expect(registry.getState()).toBeUndefined();
});

it("does not stop a workflow with no live planning run or a terminal workflow", async () => {
  const cases = [
    (registry: RootWorkflowRegistry) => {
      void registry;
    },
    (registry: RootWorkflowRegistry) => {
      expect(registry.start(createWorkflowId(UUID), "feature").started).toBe(
        true,
      );
      expect(
        registry.setPlanningRunId(createRunId("terminal-run")).transitioned,
      ).toBe(true);
      expect(registry.transition("FAILED").transitioned).toBe(true);
    },
    (registry: RootWorkflowRegistry) => {
      expect(registry.start(createWorkflowId(UUID), "feature").started).toBe(
        true,
      );
    },
  ];

  for (const prepare of cases) {
    const registry = new RootWorkflowRegistry(() => undefined);
    const events = new FakeEventBus();
    let stopCalls = 0;
    const handlers = registeredLifecycle(
      events,
      registry,
      () => {},
      async () => {
        stopCalls += 1;
      },
    );
    const sessionStart = handlers.get("session_start");
    if (typeof sessionStart !== "function")
      throw new Error("Missing session_start handler");
    Reflect.apply(sessionStart, undefined, [
      undefined,
      sessionContext("session-current"),
    ]);
    prepare(registry);

    await invoke(
      handlers,
      "session_shutdown",
      sessionContext("session-current"),
    );
    expect(stopCalls).toBe(0);
  }
});

it("cleans a pending Code Review waiter before stopping and persisting stale failure", async () => {
  const rootEvents = new FakeEventBus();
  const childEvents = new FakeEventBus();
  connectCodeReviewIntercom(rootEvents, childEvents);
  const order: string[] = [];
  const registry = new RootWorkflowRegistry(() => order.push("persist"));
  const handlers = new Map<string, unknown>();
  let releaseStop: (() => void) | undefined;
  const stop = () => {
    order.push("stop");
    return new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
  };
  const pi: Pick<ExtensionAPI, "on" | "events"> = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    events: rootEvents,
  };
  registerSessionLifecycle(pi, registry, () => order.push("cleanup"), stop);

  const context = {
    mode: "tui",
    sessionManager: {
      getBranch: () => [],
      getSessionFile: () => "/sessions/current.jsonl",
      getSessionId: () => ROOT_SESSION_ID,
    },
  };
  const sessionStart = handlers.get("session_start");
  if (typeof sessionStart !== "function") {
    throw new Error("Missing session_start handler");
  }
  Reflect.apply(sessionStart, undefined, [undefined, context]);
  const workflowId = createWorkflowId("00000000-0000-4000-8000-000000000095");
  prepareImplementationRegistry(registry, workflowId);

  const child = new CodeReviewChildBridge(childEvents, CHILD_SESSION_ID);
  child.register();
  const pending = child.request({
    workflowId,
    cwd: "/repo",
    coordinatorRunId: "implementation-run",
  });
  await Promise.resolve();
  order.length = 0;
  const shutdown = handlers.get("session_shutdown");
  if (typeof shutdown !== "function") {
    throw new Error("Missing session_shutdown handler");
  }
  const first = Reflect.apply(shutdown, undefined, [undefined, context]);
  const second = Reflect.apply(shutdown, undefined, [undefined, context]);
  await expect(pending).resolves.toMatchObject({
    status: "failed",
    error: { code: "shutdown" },
  });
  await Promise.resolve();
  expect(order).toEqual(["stop"]);
  expect(registry.getState()).toMatchObject({ phase: "CODE_REVIEW" });

  releaseStop?.();
  await Promise.all([first, second]);
  expect(order).toEqual(["stop", "persist", "cleanup"]);
  expect(registry.getState()).toBeUndefined();
  child.dispose();
});
