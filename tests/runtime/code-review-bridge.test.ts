import { expect, it } from "vitest";

import {
  REQUIRED_PLAN_HEADINGS,
  createPlanningHandoff,
  createRunId,
  createWorkflowId,
  hashPlan,
  isRecord,
  type WorkflowId,
} from "../../src/core/index.ts";
import {
  CODE_REVIEW_NAMESPACE,
  INTERCOM_EXTENSION_REGISTER_EVENT,
  PLANNOTATOR_REQUEST_EVENT,
  CodeReviewChildBridge,
  CodeReviewRootBridge,
  type CodeReviewEventBus,
  type IntercomExtensionChannel,
  type IntercomExtensionRegistration,
} from "../../src/runtime/code-review-bridge.ts";
import { registerHumanDecisionRootBridge } from "../../src/runtime/human-decision-bridge.ts";
import { RootWorkflowRegistry } from "../../src/runtime/root-lifecycle.ts";

const WORKFLOW_UUID = "00000000-0000-4000-8000-000000000021";
const ROOT_SESSION_ID = "root-session";
const CHILD_SESSION_ID = "child-session";
const ROOT_OWNER = { sessionId: ROOT_SESSION_ID, epoch: "root-epoch" };
const PLAN = `${REQUIRED_PLAN_HEADINGS.join("\n")}\n\nBounded plan.\n`;
class FakeEventBus implements CodeReviewEventBus {
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

function connectIntercom(
  rootEvents: FakeEventBus,
  childEvents: FakeEventBus,
): {
  rootPublishes: unknown[];
  childPublishes: unknown[];
  getRootRegistration: () => IntercomExtensionRegistration;
} {
  let rootRegistration: IntercomExtensionRegistration | undefined;
  let childRegistration: IntercomExtensionRegistration | undefined;
  const rootPublishes: unknown[] = [];
  const childPublishes: unknown[] = [];

  const channel = (side: "root" | "child"): IntercomExtensionChannel => ({
    namespace: CODE_REVIEW_NAMESPACE,
    snapshot: () => ({
      connected: true,
      supported: true,
      owner: ROOT_OWNER,
    }),
    publish(payload, options = {}) {
      if (side === "root") {
        rootPublishes.push(payload);
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
      childPublishes.push(payload);
      if (options.audience === "owner") {
        rootRegistration?.onEvent({
          type: "message",
          fromSessionId: CHILD_SESSION_ID,
          payload,
        });
      }
    },
  });

  const rootOnRegister = (value: unknown) => {
    if (!isRegistration(value)) throw new Error("Invalid Root registration");
    rootRegistration = value;
    rootRegistration.onReady(channel("root"));
  };
  const childOnRegister = (value: unknown) => {
    if (!isRegistration(value)) throw new Error("Invalid child registration");
    childRegistration = value;
    childRegistration.onReady(channel("child"));
  };
  rootEvents.on(INTERCOM_EXTENSION_REGISTER_EVENT, rootOnRegister);
  childEvents.on(INTERCOM_EXTENSION_REGISTER_EVENT, childOnRegister);

  return {
    rootPublishes,
    childPublishes,
    getRootRegistration: () => {
      if (rootRegistration === undefined)
        throw new Error("Root not registered");
      return rootRegistration;
    },
  };
}

function planningResult(workflowId: WorkflowId) {
  const handoff = createPlanningHandoff({
    workflowId,
    planContent: PLAN,
    tddMode: "required",
    testStrategy: {
      kind: "unit",
      required: true,
      summary: "Run focused tests.",
    },
    testSeams: ["Code Review bridge"],
    constraints: ["Keep review Root-owned."],
    nonGoals: ["Do not merge."],
    planningRunId: createRunId("planning-run"),
  });
  if (!handoff.valid) throw new Error(handoff.errors.join("; "));
  return {
    result: {
      contractVersion: 1 as const,
      workflowId,
      status: "COMPLETED" as const,
      planArtifactRef: {
        kind: "managed" as const,
        path: "implementation-plan.md",
        mediaType: "text/markdown" as const,
      },
      planningHandoffRef: {
        kind: "managed" as const,
        path: "planning-handoff.json",
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
    },
    handoff: handoff.value,
  };
}

function implementationRegistry(): {
  registry: RootWorkflowRegistry;
  workflowId: WorkflowId;
} {
  const registry = new RootWorkflowRegistry(() => undefined);
  const workflowId = createWorkflowId(WORKFLOW_UUID);
  expect(registry.start(workflowId, "feature").started).toBe(true);
  expect(
    registry.bindWorkflowRequest({
      workflowId,
      workflowType: "feature",
      request: "review the implementation",
      cwd: "/repo",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  ).toBe(true);
  expect(registry.setPlanningRunId("planning-run").transitioned).toBe(true);
  const result = planningResult(workflowId);
  expect(
    registry.completePlanning("planning-run", result.result).transitioned,
  ).toBe(true);
  expect(
    registry.setPlanReviewPending(
      "00000000-0000-4000-8000-000000000022",
      "plan-review",
    ).transitioned,
  ).toBe(true);
  expect(
    registry.recordPlanApproval(
      {
        approvedPlanHash: hashPlan(PLAN).value,
        reviewId: "plan-review",
        approval: true,
      },
      hashPlan(PLAN).value,
      result.handoff,
    ).transitioned,
  ).toBe(true);
  expect(registry.startImplementation("implementation-run").transitioned).toBe(
    true,
  );
  return { registry, workflowId };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function runReviewResult(result: unknown) {
  const rootEvents = new FakeEventBus();
  const childEvents = new FakeEventBus();
  connectIntercom(rootEvents, childEvents);
  const { registry, workflowId } = implementationRegistry();
  rootEvents.on(PLANNOTATOR_REQUEST_EVENT, (value) => {
    if (!isRecord(value) || typeof value.respond !== "function") return;
    value.respond({ status: "handled", result });
  });
  const root = new CodeReviewRootBridge({
    events: rootEvents,
    registry,
    sessionId: ROOT_SESSION_ID,
    timeoutMs: 1_000,
  });
  const child = new CodeReviewChildBridge(childEvents, CHILD_SESSION_ID);
  child.register();
  const response = await child.request({ workflowId, cwd: "/repo" });
  const state = registry.getState();
  child.dispose();
  root.dispose();
  return { response, state };
}

it("uses direct code-review, correlates the response, and keeps plan mode out", async () => {
  const rootEvents = new FakeEventBus();
  const childEvents = new FakeEventBus();
  const intercom = connectIntercom(rootEvents, childEvents);
  const { registry, workflowId } = implementationRegistry();
  const human = registerHumanDecisionRootBridge({
    events: rootEvents,
    registry,
    sessionId: ROOT_SESSION_ID,
    mode: "tui",
  });
  const actions: string[] = [];
  rootEvents.on(PLANNOTATOR_REQUEST_EVENT, (value) => {
    if (!isRecord(value)) return;
    actions.push(typeof value.action === "string" ? value.action : "invalid");
    if (typeof value.respond === "function") {
      value.respond({
        status: "handled",
        result: { approved: true, feedback: "", annotations: [] },
      });
    }
  });

  const root = new CodeReviewRootBridge({
    events: rootEvents,
    registry,
    sessionId: ROOT_SESSION_ID,
    intercom: human,
    timeoutMs: 1_000,
  });
  const child = new CodeReviewChildBridge(childEvents, CHILD_SESSION_ID);
  child.register();

  const response = await child.request({ workflowId, cwd: "/repo" });
  await settle();

  expect(response).toMatchObject({ status: "approved", approved: true });
  expect(actions).toEqual(["code-review"]);
  expect(intercom.childPublishes[0]).toMatchObject({
    kind: "code-review-binding-request",
  });
  expect(intercom.childPublishes.at(-1)).toMatchObject({
    kind: "code-review-request",
    cwd: "/repo",
  });
  expect(registry.getState()).toMatchObject({
    phase: "CODE_REVIEW",
    implementationStatus: "COMPLETED",
    codeReviewResult: { status: "approved", approved: true },
  });
  expect(JSON.stringify(registry.getState())).not.toContain("plan-mode");

  child.dispose();
  root.dispose();
  human.dispose();
});

it("returns transient review evidence without requiring managed refs", async () => {
  const rootEvents = new FakeEventBus();
  const childEvents = new FakeEventBus();
  connectIntercom(rootEvents, childEvents);
  const { registry, workflowId } = implementationRegistry();
  rootEvents.on(PLANNOTATOR_REQUEST_EVENT, (value) => {
    if (!isRecord(value) || typeof value.respond !== "function") return;
    value.respond({
      status: "handled",
      result: {
        approved: false,
        feedback: "Please fix the bounded issue.",
        annotations: [{ path: "src/example.ts", line: 4 }],
      },
    });
  });
  const root = new CodeReviewRootBridge({
    events: rootEvents,
    registry,
    sessionId: ROOT_SESSION_ID,
    timeoutMs: 1_000,
  });
  const child = new CodeReviewChildBridge(childEvents, CHILD_SESSION_ID);
  child.register();

  const response = await child.request({ workflowId, cwd: "/repo" });
  expect(response).toMatchObject({
    status: "rejected",
    approved: false,
    feedback: "Please fix the bounded issue.",
    annotations: [{ path: "src/example.ts", line: 4 }],
  });
  expect(response.feedbackRef).toBeUndefined();
  expect(response.annotationsRef).toBeUndefined();
  expect(registry.getState()?.phase).toBe("IMPLEMENTING");
  expect(JSON.stringify(registry.getState())).not.toContain(
    "Please fix the bounded issue.",
  );

  child.dispose();
  root.dispose();
});

it("fails closed when the response envelope exceeds 16 KiB", async () => {
  const oversizedFeedback = "x".repeat(16 * 1024 - 32);
  const { response, state } = await runReviewResult({
    approved: false,
    feedback: oversizedFeedback,
    annotations: [],
  });

  expect(response.status).toBe("failed");
  expect(response.error?.code).toBe("response-too-large");
  expect(JSON.stringify(response).length).toBeLessThanOrEqual(16 * 1024);
  expect(state?.phase).toBe("FAILED");
});

it("fails closed when individually valid feedback and annotations overflow together", async () => {
  const { response, state } = await runReviewResult({
    approved: false,
    feedback: "f".repeat(9_000),
    annotations: ["a".repeat(8_000)],
  });

  expect(response.status).toBe("failed");
  expect(response.error?.code).toBe("response-too-large");
  expect(JSON.stringify(response).length).toBeLessThanOrEqual(16 * 1024);
  expect(state?.phase).toBe("FAILED");
});

it("delivers a near-boundary rejection without changing its content", async () => {
  const feedback = "f".repeat(14_000);
  const annotations = [{ path: "src/example.ts", line: 4 }];
  const { response, state } = await runReviewResult({
    approved: false,
    feedback,
    annotations,
  });

  expect(response.status).toBe("rejected");
  expect(response.feedback).toBe(feedback);
  expect(response.annotations).toEqual(annotations);
  expect(state?.phase).toBe("IMPLEMENTING");
});

it("fails closed on malformed or unbounded review evidence", async () => {
  const cases: unknown[] = [
    { approved: false, feedback: 42, annotations: [] },
    { approved: false, feedback: "", annotations: "invalid" },
    { approved: false, feedback: "x".repeat(16 * 1024 + 1), annotations: [] },
    {
      approved: false,
      feedback: "",
      annotations: Array.from({ length: 129 }, () => ({})),
    },
  ];
  for (const result of cases) {
    const rootEvents = new FakeEventBus();
    const childEvents = new FakeEventBus();
    connectIntercom(rootEvents, childEvents);
    const { registry, workflowId } = implementationRegistry();
    rootEvents.on(PLANNOTATOR_REQUEST_EVENT, (value) => {
      if (!isRecord(value) || typeof value.respond !== "function") return;
      value.respond({ status: "handled", result });
    });
    const root = new CodeReviewRootBridge({
      events: rootEvents,
      registry,
      sessionId: ROOT_SESSION_ID,
      timeoutMs: 1_000,
    });
    const child = new CodeReviewChildBridge(childEvents, CHILD_SESSION_ID);
    child.register();

    const response = await child.request({ workflowId, cwd: "/repo" });
    expect(response.status).toBe("failed");
    expect(registry.getState()?.phase).toBe("FAILED");

    child.dispose();
    root.dispose();
  }
});

it("resolves the same Coordinator waiter on a conflicting request and ignores late Plannotator output", async () => {
  const rootEvents = new FakeEventBus();
  const childEvents = new FakeEventBus();
  const intercom = connectIntercom(rootEvents, childEvents);
  const { registry, workflowId } = implementationRegistry();
  let respondToPlannotator: ((value: unknown) => void) | undefined;
  rootEvents.on(PLANNOTATOR_REQUEST_EVENT, (value) => {
    if (isRecord(value) && typeof value.respond === "function") {
      const respond = value.respond;
      respondToPlannotator = (response) => {
        Reflect.apply(respond, undefined, [response]);
      };
    }
  });
  const root = new CodeReviewRootBridge({
    events: rootEvents,
    registry,
    sessionId: ROOT_SESSION_ID,
    timeoutMs: 1_000,
  });
  const child = new CodeReviewChildBridge(childEvents, CHILD_SESSION_ID);
  child.register();

  const pending = child.request({
    workflowId,
    cwd: "/repo",
    coordinatorRunId: "implementation-run",
  });
  await settle();
  const original = intercom.childPublishes[0];
  if (!isRecord(original)) throw new Error("Missing Code Review request");
  intercom.getRootRegistration().onEvent({
    type: "message",
    fromSessionId: CHILD_SESSION_ID,
    owner: ROOT_OWNER,
    payload: { ...original, cwd: "/different-repository" },
  });

  await expect(pending).resolves.toMatchObject({
    status: "failed",
    approved: false,
    error: { code: "response-conflict" },
  });
  expect(registry.getState()).toMatchObject({
    phase: "FAILED",
    finalStatus: "FAILED",
    diagnostics: [
      expect.objectContaining({
        kind: "conflict",
        code: "CODE_REVIEW_REQUEST_CONFLICT",
      }),
    ],
  });
  respondToPlannotator?.({
    status: "handled",
    result: { approved: true, feedback: "LATE", annotations: [] },
  });
  await settle();
  expect(registry.getState()).toMatchObject({
    phase: "FAILED",
    finalStatus: "FAILED",
  });

  child.dispose();
  root.dispose();
});

it("disposes a pending review without persisting Root failure during shutdown cleanup", async () => {
  const rootEvents = new FakeEventBus();
  const childEvents = new FakeEventBus();
  connectIntercom(rootEvents, childEvents);
  const { registry, workflowId } = implementationRegistry();
  rootEvents.on(PLANNOTATOR_REQUEST_EVENT, () => {});
  const root = new CodeReviewRootBridge({
    events: rootEvents,
    registry,
    sessionId: ROOT_SESSION_ID,
    timeoutMs: 1_000,
  });
  const child = new CodeReviewChildBridge(childEvents, CHILD_SESSION_ID);
  child.register();

  const pending = child.request({
    workflowId,
    cwd: "/repo",
    coordinatorRunId: "implementation-run",
  });
  await settle();
  root.dispose({ preserveRootState: true });

  await expect(pending).resolves.toMatchObject({
    status: "failed",
    approved: false,
    error: { code: "shutdown" },
  });
  expect(registry.getState()).toMatchObject({
    phase: "CODE_REVIEW",
    finalStatus: "NONE",
  });
  expect(registry.transition("FAILED").transitioned).toBe(true);

  child.dispose();
});

it("allows one same-Coordinator rejection cycle and fails the second rejection", async () => {
  const rootEvents = new FakeEventBus();
  const childEvents = new FakeEventBus();
  connectIntercom(rootEvents, childEvents);
  const { registry, workflowId } = implementationRegistry();
  let reviewCount = 0;
  rootEvents.on(PLANNOTATOR_REQUEST_EVENT, (value) => {
    if (!isRecord(value) || typeof value.respond !== "function") return;
    reviewCount += 1;
    value.respond({
      status: "handled",
      result: {
        approved: false,
        feedback: `bounded rejection ${reviewCount}`,
        annotations: [],
      },
    });
  });
  const root = new CodeReviewRootBridge({
    events: rootEvents,
    registry,
    sessionId: ROOT_SESSION_ID,
    timeoutMs: 1_000,
  });
  const child = new CodeReviewChildBridge(childEvents, CHILD_SESSION_ID);
  child.register();

  const first = await child.request({ workflowId, cwd: "/repo" });
  await settle();
  expect(first).toMatchObject({ status: "rejected", approved: false });
  expect(registry.getState()).toMatchObject({
    phase: "IMPLEMENTING",
    implementationStatus: "RUNNING",
    codeReviewChangeCycleCount: 1,
  });

  const second = await child.request({ workflowId, cwd: "/repo" });
  await settle();
  expect(second).toMatchObject({ status: "rejected", approved: false });
  expect(registry.getState()).toMatchObject({
    phase: "FAILED",
    finalStatus: "FAILED",
    codeReviewChangeCycleCount: 1,
  });
  expect(reviewCount).toBe(2);

  const third = await child.request({
    workflowId,
    cwd: "/repo",
    coordinatorRunId: "implementation-run",
  });
  expect(third.status).toBe("failed");

  child.dispose();
  root.dispose();
});
