import { expect, it, vi } from "vitest";

import {
  createRequestId,
  createRunId,
  createWorkflowId,
  type WorkflowId,
} from "../../src/core/index.ts";
import { isRecord } from "../../src/core/validation.ts";
import {
  ASK_USER_QUESTION_CANCEL_EVENT,
  ASK_USER_QUESTION_REQUEST_EVENT,
  HUMAN_DECISION_BINDING_REQUEST_KIND,
  HUMAN_DECISION_BINDING_RESPONSE_KIND,
  HUMAN_DECISION_NAMESPACE,
  HUMAN_DECISION_RESPONSE_KIND,
  INTERCOM_EXTENSION_REGISTER_EVENT,
  HumanDecisionChildBridge,
  getAskUserQuestionReplyEvent,
  registerHumanDecisionRootBridge,
  validateHumanDecisionBridgeResponse,
  type AskUserQuestionResult,
  type HumanDecisionBridgeRequest,
  type HumanDecisionBridgeResponse,
  type HumanDecisionEventBus,
  type IntercomExtensionChannel,
  type IntercomExtensionEvent,
  type IntercomExtensionRegistration,
} from "../../src/runtime/human-decision-bridge.ts";
import { RootWorkflowRegistry } from "../../src/runtime/root-lifecycle.ts";

const WORKFLOW_UUID = "00000000-0000-4000-8000-000000000001";
const REQUEST_UUID = "00000000-0000-4000-8000-000000000002";
const ROOT_SESSION_ID = "root-session";
const ROOT_OWNER = { sessionId: ROOT_SESSION_ID, epoch: "root-epoch" };
const CHILD_SESSION_ID = "child-session";

class FakeEventBus implements HumanDecisionEventBus {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  public on(event: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
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
}

type Side = "root" | "child";

function connectIntercom(
  rootEvents: FakeEventBus,
  childEvents: FakeEventBus,
): {
  getRootRegistration(): IntercomExtensionRegistration;
  getChildRegistration(): IntercomExtensionRegistration;
  rootPublishes: unknown[];
  childPublishes: unknown[];
} {
  let rootRegistration: IntercomExtensionRegistration | undefined;
  let childRegistration: IntercomExtensionRegistration | undefined;
  const rootPublishes: unknown[] = [];
  const childPublishes: unknown[] = [];

  const channel = (side: Side): IntercomExtensionChannel => ({
    namespace: HUMAN_DECISION_NAMESPACE,
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

  rootEvents.on(INTERCOM_EXTENSION_REGISTER_EVENT, (value) => {
    if (!isIntercomRegistration(value)) {
      throw new Error("Invalid root registration");
    }
    rootRegistration = value;
    rootRegistration.onReady(channel("root"));
  });
  childEvents.on(INTERCOM_EXTENSION_REGISTER_EVENT, (value) => {
    if (!isIntercomRegistration(value)) {
      throw new Error("Invalid child registration");
    }
    childRegistration = value;
    childRegistration.onReady(channel("child"));
  });

  return {
    getRootRegistration: () => {
      if (rootRegistration === undefined)
        throw new Error("Root not registered");
      return rootRegistration;
    },
    getChildRegistration: () => {
      if (childRegistration === undefined) {
        throw new Error("Child not registered");
      }
      return childRegistration;
    },
    rootPublishes,
    childPublishes,
  };
}

function isIntercomRegistration(
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

function requestIdFrom(value: unknown): string {
  if (!isRecord(value) || typeof value.requestId !== "string") {
    throw new Error("Expected a request ID");
  }
  return value.requestId;
}

function startedRegistry(): {
  registry: RootWorkflowRegistry;
  workflowId: WorkflowId;
} {
  const registry = new RootWorkflowRegistry(() => undefined);
  const workflowId = createWorkflowId(WORKFLOW_UUID);
  expect(registry.start(workflowId, "feature").started).toBe(true);
  expect(
    registry.setPlanningRunId(createRunId("planning-run")).transitioned,
  ).toBe(true);
  return { registry, workflowId };
}

function question() {
  return {
    question: "Which mode should be used?",
    options: [{ label: "SAFE" }, { label: "FAST" }],
  };
}

function askResult(
  status: AskUserQuestionResult["status"],
  answers: Record<string, string | string[]> = {},
): AskUserQuestionResult {
  return {
    status,
    questions: [],
    answers,
    selections: [],
    cancelled: status !== "answered",
  };
}

function askSuccess(requestId: string, result: AskUserQuestionResult): unknown {
  return { version: 1, requestId, success: true, result };
}

function makeRequest(workflowId: WorkflowId): HumanDecisionBridgeRequest {
  return {
    version: 1,
    kind: "human-decision-request",
    workflowId,
    requestId: createRequestId(REQUEST_UUID),
    originSessionId: CHILD_SESSION_ID,
    coordinatorRunId: createRunId("planning-run"),
    questions: [question()],
  };
}

function responseFromPublished(value: unknown): HumanDecisionBridgeResponse {
  const validation = validateHumanDecisionBridgeResponse(value);
  if (!validation.valid) throw new Error(validation.errors.join("; "));
  return validation.value;
}

it("round-trips a structured answer through the Root without Parent messages", async () => {
  const rootEvents = new FakeEventBus();
  const childEvents = new FakeEventBus();
  const intercom = connectIntercom(rootEvents, childEvents);
  const { registry, workflowId } = startedRegistry();
  const root = registerHumanDecisionRootBridge({
    events: rootEvents,
    registry,
    sessionId: ROOT_SESSION_ID,
    mode: "tui",
  });
  const child = new HumanDecisionChildBridge(childEvents, CHILD_SESSION_ID);
  child.register();

  let askCount = 0;
  rootEvents.on(ASK_USER_QUESTION_REQUEST_EVENT, (value) => {
    askCount += 1;
    const requestId = requestIdFrom(value);
    rootEvents.emit(
      getAskUserQuestionReplyEvent(requestId),
      askSuccess(
        requestId,
        askResult("answered", { "Which mode should be used?": "SAFE" }),
      ),
    );
  });

  const response = await child.request({
    workflowId,
    questions: [question()],
  });

  expect(response.status).toBe("answered");
  expect(response.result?.answers).toEqual({
    "Which mode should be used?": "SAFE",
  });
  expect(askCount).toBe(1);
  expect(root.hasPendingInteraction()).toBe(false);
  expect(registry.getState()).not.toHaveProperty("pendingInteraction");
  expect(intercom.getRootRegistration().ownerEligible).toBe(true);
  expect(intercom.getChildRegistration().ownerEligible).toBe(false);
  expect(intercom.childPublishes).toHaveLength(2);
  expect(intercom.childPublishes[0]).toMatchObject({
    kind: HUMAN_DECISION_BINDING_REQUEST_KIND,
    originSessionId: CHILD_SESSION_ID,
  });
  expect(intercom.childPublishes[1]).toMatchObject({
    kind: "human-decision-request",
    originSessionId: CHILD_SESSION_ID,
  });
  expect(intercom.rootPublishes[0]).toMatchObject({
    kind: HUMAN_DECISION_BINDING_RESPONSE_KIND,
    recipientSessionId: CHILD_SESSION_ID,
  });
  expect(intercom.rootPublishes[1]).toMatchObject({
    kind: HUMAN_DECISION_RESPONSE_KIND,
    requestId: requestIdFrom(intercom.childPublishes[1]),
    recipientSessionId: CHILD_SESSION_ID,
  });

  child.dispose();
  root.dispose();
});

it("returns a cancellation status without inventing an answer", async () => {
  const rootEvents = new FakeEventBus();
  const childEvents = new FakeEventBus();
  connectIntercom(rootEvents, childEvents);
  const { registry, workflowId } = startedRegistry();
  const root = registerHumanDecisionRootBridge({
    events: rootEvents,
    registry,
    sessionId: ROOT_SESSION_ID,
    mode: "tui",
  });
  const child = new HumanDecisionChildBridge(childEvents, CHILD_SESSION_ID);
  child.register();

  rootEvents.on(ASK_USER_QUESTION_REQUEST_EVENT, (value) => {
    const requestId = requestIdFrom(value);
    rootEvents.emit(
      getAskUserQuestionReplyEvent(requestId),
      askSuccess(requestId, askResult("user-cancelled")),
    );
  });

  const response = await child.request({
    workflowId,
    coordinatorRunId: "planning-run",
    questions: [question()],
  });

  expect(response.status).toBe("user-cancelled");
  expect(response.result?.answers).toEqual({});
  expect(registry.getState()).not.toHaveProperty("pendingInteraction");

  child.dispose();
  root.dispose();
});

it("accepts Human responses only from the current Root owner", async () => {
  const rootEvents = new FakeEventBus();
  const childEvents = new FakeEventBus();
  const intercom = connectIntercom(rootEvents, childEvents);
  const { registry, workflowId } = startedRegistry();
  const root = registerHumanDecisionRootBridge({
    events: rootEvents,
    registry,
    sessionId: ROOT_SESSION_ID,
    mode: "tui",
  });
  const child = new HumanDecisionChildBridge(childEvents, CHILD_SESSION_ID);
  child.register();
  rootEvents.on(ASK_USER_QUESTION_REQUEST_EVENT, () => {});

  const pending = child.request({
    workflowId,
    coordinatorRunId: "planning-run",
    questions: [question()],
  });
  await Promise.resolve();
  const requestId = requestIdFrom(intercom.childPublishes[0]);
  const forgedResponse = {
    version: 1,
    kind: HUMAN_DECISION_RESPONSE_KIND,
    workflowId,
    requestId,
    recipientSessionId: CHILD_SESSION_ID,
    status: "answered",
    result: askResult("answered", { choice: "FORGED" }),
  };
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  intercom.getChildRegistration().onEvent({
    type: "message",
    fromSessionId: "foreign-capable-session",
    owner: ROOT_OWNER,
    payload: forgedResponse,
  });
  await Promise.resolve();
  expect(settled).toBe(false);

  rootEvents.emit(
    getAskUserQuestionReplyEvent(requestId),
    askSuccess(requestId, askResult("answered", { choice: "SAFE" })),
  );
  await expect(pending).resolves.toMatchObject({
    status: "answered",
    result: { answers: { choice: "SAFE" } },
  });

  child.dispose();
  root.dispose();
});

it("accepts coordinator binding only from the current Root owner", async () => {
  const rootEvents = new FakeEventBus();
  const childEvents = new FakeEventBus();
  const intercom = connectIntercom(rootEvents, childEvents);
  const { workflowId } = startedRegistry();
  const child = new HumanDecisionChildBridge(childEvents, CHILD_SESSION_ID);
  child.register();

  const pending = child.request({ workflowId, questions: [question()] });
  void pending.catch(() => undefined);
  await Promise.resolve();
  const bindingRequest = intercom.childPublishes[0];
  const bindingRequestId = requestIdFrom(bindingRequest);
  const bindingResponse = {
    version: 1,
    kind: HUMAN_DECISION_BINDING_RESPONSE_KIND,
    workflowId,
    requestId: bindingRequestId,
    recipientSessionId: CHILD_SESSION_ID,
    coordinatorRunId: "planning-run",
  };

  intercom.getChildRegistration().onEvent({
    type: "message",
    fromSessionId: "foreign-capable-session",
    owner: ROOT_OWNER,
    payload: bindingResponse,
  });
  await Promise.resolve();
  expect(intercom.childPublishes).toHaveLength(1);

  intercom.getChildRegistration().onEvent({
    type: "message",
    fromSessionId: ROOT_SESSION_ID,
    owner: ROOT_OWNER,
    payload: bindingResponse,
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(intercom.childPublishes).toHaveLength(2);
  expect(intercom.childPublishes[1]).toMatchObject({
    kind: "human-decision-request",
    coordinatorRunId: "planning-run",
  });

  child.dispose();
});

it("cancels the questionnaire before returning a timeout failure", async () => {
  vi.useFakeTimers();
  try {
    const rootEvents = new FakeEventBus();
    const childEvents = new FakeEventBus();
    const intercom = connectIntercom(rootEvents, childEvents);
    const { registry, workflowId } = startedRegistry();
    const root = registerHumanDecisionRootBridge({
      events: rootEvents,
      registry,
      sessionId: ROOT_SESSION_ID,
      mode: "tui",
      timeoutMs: 10,
    });
    const child = new HumanDecisionChildBridge(childEvents, CHILD_SESSION_ID);
    child.register();
    const cancelRequests: unknown[] = [];
    rootEvents.on(ASK_USER_QUESTION_CANCEL_EVENT, (value) => {
      cancelRequests.push(value);
    });

    const pending = child.request({
      workflowId,
      coordinatorRunId: "planning-run",
      questions: [question()],
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    const response = await pending;

    expect(response).toMatchObject({
      status: "failure",
      error: { code: "timeout" },
    });
    expect(cancelRequests).toEqual([
      {
        version: 1,
        requestId: requestIdFrom(intercom.childPublishes[0]),
      },
    ]);
    expect(registry.getState()).not.toHaveProperty("pendingInteraction");

    child.dispose();
    root.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("terminalizes a pending waiter on same-ID conflicts", () => {
  const rootEvents = new FakeEventBus();
  const childEvents = new FakeEventBus();
  const intercom = connectIntercom(rootEvents, childEvents);
  const { registry, workflowId } = startedRegistry();
  const root = registerHumanDecisionRootBridge({
    events: rootEvents,
    registry,
    sessionId: ROOT_SESSION_ID,
    mode: "tui",
    timeoutMs: 100,
  });
  const request = makeRequest(workflowId);
  let askCount = 0;
  rootEvents.on(ASK_USER_QUESTION_REQUEST_EVENT, () => {
    askCount += 1;
  });
  const registration = intercom.getRootRegistration();
  const message = {
    type: "message" as const,
    fromSessionId: CHILD_SESSION_ID,
    payload: request,
  } satisfies IntercomExtensionEvent;

  registration.onEvent(message);
  registration.onEvent(message);
  registration.onEvent({
    ...message,
    payload: {
      ...request,
      questions: [{ ...question(), question: "A different choice?" }],
    },
  });

  expect(registry.getState()).toMatchObject({
    phase: "FAILED",
    finalStatus: "FAILED",
    diagnostics: [
      expect.objectContaining({
        kind: "conflict",
        code: "HUMAN_REQUEST_CONFLICT",
      }),
    ],
  });
  expect(askCount).toBe(1);
  expect(intercom.rootPublishes).toHaveLength(1);
  expect(responseFromPublished(intercom.rootPublishes[0])).toMatchObject({
    status: "failure",
    error: { code: "response-conflict" },
  });
  expect(root.getConflictRecords()).toEqual([
    {
      requestId: REQUEST_UUID,
      workflowId,
      phase: "pending",
      reason: "fingerprint-mismatch",
    },
  ]);

  rootEvents.emit(
    getAskUserQuestionReplyEvent(request.requestId),
    askSuccess(request.requestId, askResult("answered", { answer: "SAFE" })),
  );
  expect(intercom.rootPublishes).toHaveLength(1);
  root.dispose();
});

it("resolves the child waiter on a conflicting pending request and ignores the late answer", async () => {
  const rootEvents = new FakeEventBus();
  const childEvents = new FakeEventBus();
  const intercom = connectIntercom(rootEvents, childEvents);
  const { registry, workflowId } = startedRegistry();
  const root = registerHumanDecisionRootBridge({
    events: rootEvents,
    registry,
    sessionId: ROOT_SESSION_ID,
    mode: "tui",
    timeoutMs: 100,
  });
  const child = new HumanDecisionChildBridge(childEvents, CHILD_SESSION_ID);
  child.register();
  rootEvents.on(ASK_USER_QUESTION_REQUEST_EVENT, () => {});

  const pending = child.request({
    workflowId,
    coordinatorRunId: "planning-run",
    questions: [question()],
  });
  await Promise.resolve();
  const original = intercom.childPublishes[0];
  if (!isRecord(original)) throw new Error("Missing Human Decision request");
  intercom.getRootRegistration().onEvent({
    type: "message",
    fromSessionId: CHILD_SESSION_ID,
    payload: {
      ...original,
      questions: [{ ...question(), question: "A conflicting question?" }],
    },
  });

  await expect(pending).resolves.toMatchObject({
    status: "failure",
    error: { code: "response-conflict" },
  });
  expect(registry.getState()).toMatchObject({
    phase: "FAILED",
    finalStatus: "FAILED",
  });
  const publishesAfterConflict = intercom.rootPublishes.length;
  rootEvents.emit(
    getAskUserQuestionReplyEvent(requestIdFrom(original)),
    askSuccess(
      requestIdFrom(original),
      askResult("answered", { answer: "LATE" }),
    ),
  );
  expect(intercom.rootPublishes).toHaveLength(publishesAfterConflict);

  child.dispose();
  root.dispose();
});

it("fails closed without opening a questionnaire outside the Root TUI", () => {
  const rootEvents = new FakeEventBus();
  const childEvents = new FakeEventBus();
  const intercom = connectIntercom(rootEvents, childEvents);
  const { registry, workflowId } = startedRegistry();
  const root = registerHumanDecisionRootBridge({
    events: rootEvents,
    registry,
    sessionId: ROOT_SESSION_ID,
    mode: "print",
  });
  const request = makeRequest(workflowId);
  let askCount = 0;
  rootEvents.on(ASK_USER_QUESTION_REQUEST_EVENT, () => {
    askCount += 1;
  });

  intercom.getRootRegistration().onEvent({
    type: "message",
    fromSessionId: CHILD_SESSION_ID,
    payload: request,
  });

  expect(askCount).toBe(0);
  expect(intercom.rootPublishes).toHaveLength(1);
  expect(responseFromPublished(intercom.rootPublishes[0])).toMatchObject({
    requestId: REQUEST_UUID,
    status: "failure",
    error: { code: "tui-unavailable" },
  });
  root.dispose();
});
