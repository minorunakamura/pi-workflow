import { expect, it, vi } from "vitest";

import {
  createInitialWorkflowState,
  createRunId,
  createWorkflowId,
  type ImplementationCoordinatorResult,
  type RootWorkflowState,
} from "../../src/core/index.ts";
import { registerImplementationCompletionObservation } from "../../src/runtime/implementation-completion.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/runtime/subagents-rpc.ts";

type Handler = (value: unknown) => void;

class FakeEventBus {
  private readonly handlers = new Map<string, Set<Handler>>();

  public on(event: string, handler: Handler): () => void {
    const handlers = this.handlers.get(event) ?? new Set<Handler>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  public emit(event: string, value: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(value);
  }
}

const workflowId = createWorkflowId("00000000-0000-4000-8000-000000000041");
const state: RootWorkflowState = {
  ...createInitialWorkflowState(workflowId, "feature"),
  phase: "CODE_REVIEW",
  planningRunId: createRunId("planning-run"),
  planningStatus: "COMPLETED",
  implementationStatus: "COMPLETED",
  implementationRunId: createRunId("implementation-run"),
};

function result(): ImplementationCoordinatorResult {
  return {
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
        { id: "approved-plan-identity", status: "PASS", reason: "passed" },
        { id: "implementation-complete", status: "PASS", reason: "passed" },
        { id: "required-gates", status: "PASS", reason: "passed" },
        { id: "accepted-findings", status: "PASS", reason: "passed" },
        { id: "focused-re-review", status: "PASS", reason: "passed" },
        { id: "final-diff-inspection", status: "PASS", reason: "passed" },
        { id: "code-review", status: "PASS", reason: "passed" },
      ],
      blockers: [],
    },
    remainingBlockers: [],
  };
}

function registry() {
  return {
    getState: vi.fn(() => state),
    completeImplementation: vi.fn(() => ({ transitioned: true })),
    transition: vi.fn(() => ({ transitioned: true })),
  };
}

it("hands a trusted completed result to the Root final path", () => {
  const events = new FakeEventBus();
  const root = registry();
  const observation = registerImplementationCompletionObservation(
    events,
    root,
    "session-41",
    { isCompletionTrusted: () => true },
  );

  events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    sessionId: "session-41",
    runId: "implementation-run",
    state: "complete",
    success: true,
    results: [{ structuredOutput: result() }],
  });

  expect(root.completeImplementation).toHaveBeenCalledWith(
    "implementation-run",
    expect.objectContaining({ status: "COMPLETED" }),
  );
  expect(root.transition).not.toHaveBeenCalled();
  observation.dispose();
});

it("fails closed when the coordinator reports blocked readiness", () => {
  const events = new FakeEventBus();
  const root = registry();
  const observation = registerImplementationCompletionObservation(
    events,
    root,
    "session-41",
    { isCompletionTrusted: () => true },
  );

  events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    sessionId: "session-41",
    runId: "implementation-run",
    state: "complete",
    success: true,
    results: [{ structuredOutput: { ...result(), readyForMerge: undefined } }],
  });

  expect(root.completeImplementation).not.toHaveBeenCalled();
  expect(root.transition).toHaveBeenCalledWith("FAILED");
  observation.dispose();
});

it("does not accept an untrusted completion", () => {
  const events = new FakeEventBus();
  const root = registry();
  const observation = registerImplementationCompletionObservation(
    events,
    root,
    "session-41",
    { isCompletionTrusted: () => false },
  );

  events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    sessionId: "session-41",
    runId: "implementation-run",
    state: "complete",
    success: true,
    results: [{ structuredOutput: result() }],
  });

  expect(root.completeImplementation).not.toHaveBeenCalled();
  expect(root.transition).toHaveBeenCalledWith("FAILED");
  observation.dispose();
});
