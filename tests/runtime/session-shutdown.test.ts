import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

import { createRunId, createWorkflowId } from "../../src/core/index.ts";
import { registerSessionLifecycle } from "../../src/events/index.ts";
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

function sessionContext(sessionId: string) {
  return {
    sessionManager: {
      getBranch: () => [],
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
  let sessionIdReads = 0;
  const context = {
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => {
        sessionIdReads += 1;
        return "session-current";
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
    sessionId: "foreign-session",
    state: "failed",
    success: false,
  });
  expect(registry.getState()).toMatchObject({
    phase: "PLANNING",
    finalStatus: "NONE",
  });
  order.length = 0;

  await invoke(handlers, "session_shutdown", context);

  expect(sessionIdReads).toBe(1);
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
