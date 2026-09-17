import { expect, it, vi } from "vitest";

import { isRecord } from "../../src/core/validation.ts";
import { TIMEOUTS, createWorkflowId } from "../../src/core/index.ts";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_ASYNC_STARTED_EVENT,
  SUBAGENT_PROCESS_TERMINAL_EVENT,
  SUBAGENT_RPC_READY_EVENT,
  SUBAGENT_RPC_REPLY_EVENT_PREFIX,
  SUBAGENT_RPC_REQUEST_EVENT,
  SubagentRpcAdapter,
  isValidSubagentRpcRequest,
  registerSubagentLifecycleObservation,
  subagentRpcReplyEvent,
  type SubagentRpcEventBus,
  type SubagentRpcReplyEnvelope,
  type SubagentRpcRequestEnvelope,
} from "../../src/runtime/subagents-rpc.ts";

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

const ready = {
  version: 1 as const,
  methods: ["ping", "status", "spawn", "stop"],
  capabilities: { asyncSpawn: true as const },
};

function requestFrom(value: unknown): SubagentRpcRequestEnvelope {
  if (!isValidSubagentRpcRequest(value)) {
    throw new Error("Expected a valid RPC request");
  }
  return value;
}

function successReply(
  request: SubagentRpcRequestEnvelope,
  data: unknown,
): SubagentRpcReplyEnvelope {
  return {
    version: 1,
    requestId: request.requestId,
    method: request.method,
    success: true,
    data,
  };
}

it("waits for a validated ready event before sending public RPC", async () => {
  const events = new FakeEventBus();
  const adapter = new SubagentRpcAdapter(events);
  const requests: SubagentRpcRequestEnvelope[] = [];
  events.on(SUBAGENT_RPC_REQUEST_EVENT, (raw) => {
    const request = requestFrom(raw);
    requests.push(request);
    events.emit(
      subagentRpcReplyEvent(request.requestId),
      successReply(request, { pong: true }),
    );
  });

  const pending = adapter.request("ping");
  expect(requests).toHaveLength(0);
  events.emit(SUBAGENT_RPC_READY_EVENT, {
    version: 1,
    methods: ["ping", "status", "spawn", "stop"],
    capabilities: { asyncSpawn: false },
  });
  expect(requests).toHaveLength(0);
  events.emit(SUBAGENT_RPC_READY_EVENT, ready);

  const reply = await pending;
  expect(reply).toMatchObject({ success: true, data: { pong: true } });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    version: 1,
    method: "ping",
    requestId: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    ),
  });

  adapter.dispose();
});

it("cleans up the ready waiter when the fixed ready timeout expires", async () => {
  vi.useFakeTimers();
  try {
    const events = new FakeEventBus();
    const adapter = new SubagentRpcAdapter(events);
    const pending = adapter.request("status");
    const assertion = expect(pending).rejects.toMatchObject({
      code: "RPC_READY_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(TIMEOUTS.rpcReadyTimeoutMs);
    await assertion;
    expect(events.listenerCount(SUBAGENT_RPC_REQUEST_EVENT)).toBe(0);

    adapter.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("sends the bounded fresh planning Coordinator payload and captures the structured run ID", async () => {
  const events = new FakeEventBus();
  const adapter = new SubagentRpcAdapter(events);
  events.emit(SUBAGENT_RPC_READY_EVENT, ready);
  let request: SubagentRpcRequestEnvelope | undefined;
  events.on(SUBAGENT_RPC_REQUEST_EVENT, (raw) => {
    request = requestFrom(raw);
    events.emit(
      subagentRpcReplyEvent(request.requestId),
      successReply(request, {
        details: { results: [{ runId: "result-run" }], runId: "details-run" },
        runId: "top-level-run",
      }),
    );
  });

  const result = await adapter.spawnPlanningCoordinator({
    workflowId: createWorkflowId(UUID),
    workflowType: "bug",
    request: "  reproduce the regression  ",
    cwd: "/repo",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  expect(result.runId).toBe("result-run");
  expect(request).toMatchObject({
    version: 1,
    method: "spawn",
    source: { extension: "pi-workflow" },
  });
  if (request === undefined) return;
  expect(request.params).toMatchObject({
    agent: "pi-workflow.planning-coordinator",
    context: "fresh",
    cwd: "/repo",
    async: true,
    output: "coordinator-summary.md",
    outputMode: "file-only",
    artifacts: true,
    timeoutMs: TIMEOUTS.coordinatorTimeoutMs,
  });
  const taskValue: unknown = JSON.parse(String(request.params?.task));
  if (!isRecord(taskValue))
    throw new Error("Expected a serialized task object");
  const task = taskValue;
  expect(task).toMatchObject({
    version: 1,
    workflowId: `wf-${UUID}`,
    workflowType: "bug",
    request: "  reproduce the regression  ",
    cwd: "/repo",
    policy: {
      source: "package-built-in",
      commonPlanning: { scout: "required" },
    },
  });
  expect(task).not.toHaveProperty("transcript");
  expect(task).not.toHaveProperty("systemPrompt");

  adapter.dispose();
});

it("ignores a reply for another request ID and consumes the matching reply", async () => {
  const events = new FakeEventBus();
  const adapter = new SubagentRpcAdapter(events);
  events.emit(SUBAGENT_RPC_READY_EVENT, ready);
  events.on(SUBAGENT_RPC_REQUEST_EVENT, (raw) => {
    const request = requestFrom(raw);
    events.emit(subagentRpcReplyEvent("foreign-request"), {
      version: 1,
      requestId: "foreign-request",
      method: request.method,
      success: true,
      data: { foreign: true },
    });
    events.emit(
      subagentRpcReplyEvent(request.requestId),
      successReply(request, { matching: true }),
    );
  });

  await expect(adapter.request("ping")).resolves.toMatchObject({
    success: true,
    data: { matching: true },
  });
  adapter.dispose();
});

it("does not parse human-readable spawn text as a run ID", async () => {
  const events = new FakeEventBus();
  const adapter = new SubagentRpcAdapter(events);
  events.emit(SUBAGENT_RPC_READY_EVENT, ready);
  events.on(SUBAGENT_RPC_REQUEST_EVENT, (raw) => {
    const request = requestFrom(raw);
    events.emit(
      subagentRpcReplyEvent(request.requestId),
      successReply(request, { text: "Async run started: human-only-id" }),
    );
  });

  await expect(
    adapter.spawnPlanningCoordinator({
      workflowId: createWorkflowId(UUID),
      workflowType: "feature",
      request: "add the feature",
      cwd: "/repo",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  ).rejects.toMatchObject({ code: "RPC_MISSING_RUN_ID" });
  adapter.dispose();
});

it("uses only public status and stop methods with the opaque run ID target", async () => {
  const events = new FakeEventBus();
  const adapter = new SubagentRpcAdapter(events);
  events.emit(SUBAGENT_RPC_READY_EVENT, ready);
  const calls: Array<{ method: string; params: unknown }> = [];
  events.on(SUBAGENT_RPC_REQUEST_EVENT, (raw) => {
    const request = requestFrom(raw);
    calls.push({ method: request.method, params: request.params });
    events.emit(
      subagentRpcReplyEvent(request.requestId),
      successReply(request, { ok: true }),
    );
  });

  await adapter.status("opaque-run");
  await adapter.stop("opaque-run");

  expect(calls).toEqual([
    { method: "status", params: { id: "opaque-run" } },
    { method: "stop", params: { id: "opaque-run" } },
  ]);
  adapter.dispose();
});

it("times out a reply and disposes its per-request listener", async () => {
  vi.useFakeTimers();
  try {
    const events = new FakeEventBus();
    const adapter = new SubagentRpcAdapter(events);
    events.emit(SUBAGENT_RPC_READY_EVENT, ready);
    let requestId = "";
    events.on(SUBAGENT_RPC_REQUEST_EVENT, (raw) => {
      requestId = requestFrom(raw).requestId;
    });

    const pending = adapter.request("status", { id: "opaque-run" });
    const assertion = expect(pending).rejects.toMatchObject({
      code: "RPC_REPLY_TIMEOUT",
    });
    await Promise.resolve();
    expect(requestId).not.toBe("");
    expect(
      events.listenerCount(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`),
    ).toBe(1);

    await vi.advanceTimersByTimeAsync(TIMEOUTS.rpcReplyTimeoutMs);
    await assertion;
    expect(
      events.listenerCount(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`),
    ).toBe(0);

    events.emit(
      `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`,
      successReply(
        {
          version: 1,
          requestId,
          method: "status",
          params: { id: "opaque-run" },
        },
        { late: true },
      ),
    );
    adapter.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("rejects conflicting synchronous replies while ignoring a duplicate after settlement", async () => {
  const events = new FakeEventBus();
  const adapter = new SubagentRpcAdapter(events);
  events.emit(SUBAGENT_RPC_READY_EVENT, ready);
  events.on(SUBAGENT_RPC_REQUEST_EVENT, (raw) => {
    const request = requestFrom(raw);
    events.emit(
      subagentRpcReplyEvent(request.requestId),
      successReply(request, { first: true }),
    );
    events.emit(subagentRpcReplyEvent(request.requestId), {
      version: 1,
      requestId: request.requestId,
      method: request.method,
      success: false,
      error: { code: "late", message: "conflict" },
    });
  });

  await expect(adapter.request("ping")).rejects.toMatchObject({
    code: "RPC_CONFLICTING_REPLY",
  });
  adapter.dispose();
});

it("observes compact lifecycle identities and ignores duplicate or foreign completion events", () => {
  const events = new FakeEventBus();
  const started: unknown[] = [];
  const completed: unknown[] = [];
  const conflicts: unknown[] = [];
  const terminal: unknown[] = [];
  const dispose = registerSubagentLifecycleObservation(events, {
    sessionId: "session-1",
    onStarted: (record) => started.push(record),
    onComplete: (record) => completed.push(record),
    onConflict: (runId) => conflicts.push(runId),
    onProcessTerminal: (record) => terminal.push(record),
  });

  events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
    id: "planning-run",
    sessionId: "session-1",
    task: "raw task must not cross the boundary",
  });
  events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    runId: "planning-run",
    sessionId: "other-session",
    state: "complete",
    success: true,
  });
  events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    runId: "planning-run",
    sessionId: "session-1",
    state: "bogus",
    success: true,
  });
  events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    runId: "planning-run",
    sessionId: "session-1",
    state: "complete",
    success: true,
    results: [{ summary: "raw report", artifactPath: "outputs/plan.md" }],
  });
  events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    runId: "planning-run",
    sessionId: "session-1",
    state: "complete",
    success: true,
    results: [
      { summary: "duplicate raw report", artifactPath: "outputs/plan.md" },
    ],
  });
  events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    runId: "planning-run",
    sessionId: "session-1",
    state: "failed",
    success: false,
  });
  events.emit(SUBAGENT_PROCESS_TERMINAL_EVENT, {
    runId: "planning-run",
    processTerminal: { state: "observed" },
  });

  expect(started).toEqual([
    { kind: "started", runId: "planning-run", artifactRefs: [] },
  ]);
  expect(completed).toEqual([
    {
      kind: "complete",
      runId: "planning-run",
      state: "complete",
      success: true,
      artifactRefs: ["outputs/plan.md"],
    },
  ]);
  expect(conflicts).toEqual(["planning-run"]);
  expect(terminal).toEqual([
    {
      kind: "process-terminal",
      runId: "planning-run",
      state: "observed",
      artifactRefs: [],
    },
  ]);

  dispose();
  events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "after-dispose" });
  expect(started).toHaveLength(1);
});
