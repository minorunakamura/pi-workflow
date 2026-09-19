import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";

import extension from "../../src/index.ts";
import {
  REQUIRED_PLAN_HEADINGS,
  createPlanningHandoff,
  createRunId,
  hashPlan,
  isRecord,
  isValidWorkflowId,
  type WorkflowId,
} from "../../src/core/index.ts";
import {
  PLANNOTATOR_REQUEST_EVENT,
  PLANNOTATOR_REVIEW_RESULT_EVENT,
  isPlanReviewRequest,
} from "../../src/runtime/plan-review.ts";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_RPC_READY_EVENT,
  SUBAGENT_RPC_REQUEST_EVENT,
  isValidSubagentRpcRequest,
  subagentRpcReplyEvent,
  type SubagentRpcEventBus,
  type SubagentRpcRequestEnvelope,
} from "../../src/runtime/subagents-rpc.ts";
import {
  SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
  SUBAGENT_RESULT_INTERCOM_EVENT,
} from "../../src/runtime/result-delivery.ts";

const ROOT_SESSION_ID = "root-session";
const PLAN_REVIEW_ID = "plan-review";
const PLAN = REQUIRED_PLAN_HEADINGS.map((heading) =>
  heading === "## Trusted Gate expectations"
    ? `${heading}\n<!-- pi-workflow-trusted-gates: [] -->`
    : heading,
).join("\n");

class FakeEventBus implements SubagentRpcEventBus {
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

type RegisteredCommand = {
  handler: (args: string, context: ExtensionCommandContext) => Promise<void>;
};

type RootPi = Pick<
  ExtensionAPI,
  "on" | "appendEntry" | "registerCommand" | "events"
>;

function createRootPi(): {
  pi: RootPi;
  events: FakeEventBus;
  commands: Map<string, RegisteredCommand>;
  handlers: Map<string, unknown>;
  entries: Array<{ customType: string; data: unknown }>;
} {
  const events = new FakeEventBus();
  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, unknown>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const pi: RootPi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
    registerCommand(name, options) {
      commands.set(name, { handler: options.handler });
    },
    events,
  };
  return { pi, events, commands, handlers, entries };
}

function sessionContext(sessionId: string) {
  return {
    mode: "tui",
    sessionManager: {
      getBranch: () => [],
      getSessionFile: () => undefined,
      getSessionId: () => sessionId,
    },
  };
}

function commandContext(
  cwd: string,
  notifications: Array<{ message: string; type: string }>,
): ExtensionCommandContext {
  return Object.assign(Object.create(null), {
    cwd,
    ui: {
      notify(message: string, type: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
    },
  });
}

async function invoke(
  handlers: Map<string, unknown>,
  event: string,
  eventValue: unknown,
  context: unknown,
): Promise<void> {
  const handler = handlers.get(event);
  if (typeof handler !== "function") {
    throw new Error(`Missing ${event} handler`);
  }
  const result = Reflect.apply(handler, undefined, [eventValue, context]);
  if (result instanceof Promise) await result;
}

async function waitFor(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function latestData(
  entries: readonly { data: unknown }[],
): Record<string, unknown> | undefined {
  const data = entries.at(-1)?.data;
  return isRecord(data) ? data : undefined;
}

function latestPhase(entries: readonly { data: unknown }[]): unknown {
  return latestData(entries)?.phase;
}

function parseRecord(value: unknown): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error("Coordinator task is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("Coordinator task is not an object");
  return parsed;
}

function planningCompletion(
  workflowId: WorkflowId,
  planPath: string,
  handoffPath: string,
) {
  return {
    contractVersion: 1 as const,
    workflowId,
    status: "COMPLETED" as const,
    planArtifactRef: {
      kind: "managed" as const,
      path: planPath,
      mediaType: "text/markdown" as const,
    },
    planningHandoffRef: {
      kind: "managed" as const,
      path: handoffPath,
      mediaType: "application/json" as const,
    },
    selectedCapabilities: [
      { capability: "scout" as const, reason: "Repository evidence." },
      {
        capability: "plan-composition" as const,
        reason: "A Plan Artifact is required.",
      },
    ],
    skippedCapabilities: [
      { capability: "researcher" as const, reason: "No external fact." },
      { capability: "grilling" as const, reason: "No ambiguity remains." },
      {
        capability: "human-decision" as const,
        reason: "No product choice remains.",
      },
      {
        capability: "targeted-rescout" as const,
        reason: "Scout assumptions remain current.",
      },
      { capability: "oracle" as const, reason: "No strategy challenge." },
    ],
    remainingBlockers: [],
  };
}

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it("connects the Root command, public RPC, Plan Review, and fresh Implementation seams", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-integration-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const configPath = join(agentDir, "extensions", "subagent", "config.json");
  const workspace = join(root, "workspace");
  const artifacts = join(root, "artifacts");
  mkdirSync(join(agentDir, "extensions", "subagent"), { recursive: true });
  mkdirSync(workspace);
  mkdirSync(artifacts);
  writeFileSync(
    configPath,
    JSON.stringify({
      intercomBridge: { mode: "always", resultDelivery: true },
    }),
  );
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

  const { pi, events, commands, handlers, entries } = createRootPi();
  const spawnRequests: SubagentRpcRequestEnvelope[] = [];
  const stopRequests: SubagentRpcRequestEnvelope[] = [];
  events.on(SUBAGENT_RPC_REQUEST_EVENT, (value) => {
    if (!isValidSubagentRpcRequest(value)) return;
    if (value.method === "spawn") {
      spawnRequests.push(value);
      const runId =
        spawnRequests.length === 1 ? "planning-run" : "implementation-run";
      events.emit(subagentRpcReplyEvent(value.requestId), {
        version: 1,
        requestId: value.requestId,
        method: value.method,
        success: true,
        data: { runId },
      });
      return;
    }
    if (value.method === "stop") {
      stopRequests.push(value);
      events.emit(subagentRpcReplyEvent(value.requestId), {
        version: 1,
        requestId: value.requestId,
        method: value.method,
        success: true,
        data: { stopped: true },
      });
    }
  });
  events.on(PLANNOTATOR_REQUEST_EVENT, (value) => {
    if (!isPlanReviewRequest(value) || value.action !== "plan-review") {
      return;
    }
    value.respond({
      status: "handled",
      result: { status: "pending", reviewId: PLAN_REVIEW_ID },
    });
  });

  extension(pi);
  events.emit(SUBAGENT_RPC_READY_EVENT, {
    version: 1,
    methods: ["ping", "status", "spawn", "stop"],
    capabilities: { asyncSpawn: true },
  });
  const context = sessionContext(ROOT_SESSION_ID);
  await invoke(handlers, "session_start", undefined, context);

  const notifications: Array<{ message: string; type: string }> = [];
  const command = commands.get("wf-feature");
  expect(command).toBeDefined();
  await command?.handler(
    "  integrate the public seams  ",
    commandContext(workspace, notifications),
  );

  const planningState = entries.at(-1)?.data;
  expect(planningState).toMatchObject({
    phase: "PLANNING",
    planningStatus: "RUNNING",
    planningRunId: "planning-run",
  });
  expect(notifications).toEqual([
    { message: "Started /wf-feature workflow.", type: "info" },
  ]);
  expect(spawnRequests[0]?.params).toMatchObject({
    agent: "pi-workflow.planning-coordinator",
    context: "fresh",
    cwd: workspace,
    async: true,
    outputMode: "file-only",
  });

  if (
    !isRecord(planningState) ||
    !isValidWorkflowId(planningState.workflowId)
  ) {
    throw new Error("The Root workflow identity was not persisted");
  }
  const workflowId: WorkflowId = planningState.workflowId;
  const planPath = join(artifacts, "implementation-plan.md");
  const handoffPath = join(artifacts, "planning-handoff.json");
  const handoff = createPlanningHandoff({
    workflowId,
    planContent: PLAN,
    tddMode: "not-applicable",
    testStrategy: {
      kind: "integration",
      required: true,
      summary: "Run this test.",
    },
    testSeams: ["public Pi event contracts"],
    constraints: ["Keep Root Parent LLM out of the workflow transport."],
    nonGoals: ["Do not merge, push, or deploy."],
    planningRunId: createRunId("planning-run"),
  });
  if (!handoff.valid) throw new Error(handoff.errors.join("; "));
  writeFileSync(planPath, PLAN);
  writeFileSync(handoffPath, `${JSON.stringify(handoff.value)}\n`);
  const handoffBeforeApproval = readFileSync(handoffPath, "utf8");

  events.emit(SUBAGENT_RESULT_INTERCOM_EVENT, {
    requestId: "planning-delivery",
    runId: "planning-run",
    to: ROOT_SESSION_ID,
    message: "compact coordinator result",
  });
  events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
    requestId: "planning-delivery",
    delivered: true,
  });
  events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    runId: "planning-run",
    sessionId: ROOT_SESSION_ID,
    state: "complete",
    success: true,
    results: [
      {
        structuredOutput: planningCompletion(workflowId, planPath, handoffPath),
      },
    ],
  });

  await waitFor(() => {
    const data = latestData(entries);
    return (
      data?.phase === "PLAN_REVIEW" && data.pendingInteraction !== undefined
    );
  }, "the pending Plan Review");
  expect(entries.at(-1)?.data).toMatchObject({
    phase: "PLAN_REVIEW",
    planningStatus: "COMPLETED",
    planningHandoffRef: { path: handoffPath },
    pendingInteraction: { kind: "plan-review", reviewId: PLAN_REVIEW_ID },
  });

  events.emit(PLANNOTATOR_REVIEW_RESULT_EVENT, {
    reviewId: PLAN_REVIEW_ID,
    approved: true,
    feedback: "Approved for the fresh implementation phase.",
  });

  await waitFor(
    () => latestPhase(entries) === "IMPLEMENTING",
    "the fresh Implementation Coordinator",
  );
  expect(spawnRequests).toHaveLength(2);
  expect(spawnRequests[1]?.params).toMatchObject({
    agent: "pi-workflow.implementation-coordinator",
    context: "fresh",
    cwd: workspace,
    async: true,
    outputMode: "file-only",
  });
  const implementationTask = parseRecord(spawnRequests[1]?.params?.task);
  expect(implementationTask).toMatchObject({
    workflow: { workflowId, workflowType: "feature", cwd: workspace },
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
    approval: {
      approvedPlanHash: hashPlan(PLAN).value,
      reviewId: PLAN_REVIEW_ID,
      approval: true,
    },
  });
  expect(implementationTask).not.toHaveProperty("planningTranscript");
  expect(implementationTask).not.toHaveProperty("workflow.request");
  expect(readFileSync(handoffPath, "utf8")).toBe(handoffBeforeApproval);

  await invoke(handlers, "session_shutdown", { reason: "quit" }, context);
  expect(stopRequests).toHaveLength(1);
  expect(stopRequests[0]?.params).toEqual({ id: "implementation-run" });
  expect(entries.at(-1)?.data).toMatchObject({
    phase: "CANCELLED",
    finalStatus: "CANCELLED",
    cancellationOutcome: {
      coordinatorRunId: "implementation-run",
      stop: "requested",
    },
  });
});
