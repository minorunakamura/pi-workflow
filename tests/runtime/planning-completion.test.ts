import { expect, it } from "vitest";

import {
  PLANNING_COORDINATOR_CONTRACT_VERSION,
  createRunId,
  createWorkflowId,
} from "../../src/core/index.ts";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  type SubagentRpcEventBus,
} from "../../src/runtime/subagents-rpc.ts";
import { registerPlanningCompletionObservation } from "../../src/runtime/planning-completion.ts";
import { RootWorkflowRegistry } from "../../src/runtime/root-lifecycle.ts";

const UUID = "00000000-0000-4000-8000-000000000001";

class FakeEventBus implements SubagentRpcEventBus {
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
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
  }
}

function planningResult() {
  return {
    contractVersion: PLANNING_COORDINATOR_CONTRACT_VERSION,
    workflowId: createWorkflowId(UUID),
    status: "COMPLETED" as const,
    planArtifactRef: {
      kind: "managed" as const,
      path: "outputs/implementation-plan.md",
      mediaType: "text/markdown" as const,
    },
    planningHandoffRef: {
      kind: "managed" as const,
      path: "outputs/planning-handoff.json",
      mediaType: "application/json" as const,
    },
    selectedCapabilities: [
      { capability: "scout" as const, reason: "Repository evidence." },
      { capability: "plan-composition" as const, reason: "Plan is required." },
    ],
    skippedCapabilities: [],
    remainingBlockers: [],
  };
}

function startedRegistry(): RootWorkflowRegistry {
  const registry = new RootWorkflowRegistry(() => undefined);
  expect(registry.start(createWorkflowId(UUID), "feature").started).toBe(true);
  expect(
    registry.setPlanningRunId(createRunId("planning-run")).transitioned,
  ).toBe(true);
  return registry;
}

it("advances only from a trusted compact planning result and stores the Handoff ref", () => {
  const events = new FakeEventBus();
  const registry = startedRegistry();
  const observation = registerPlanningCompletionObservation(
    events,
    registry,
    "session-1",
    { isCompletionTrusted: () => true },
  );

  events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    runId: "planning-run",
    sessionId: "session-1",
    state: "complete",
    success: true,
    results: [{ structuredOutput: planningResult() }],
  });

  expect(registry.getState()).toMatchObject({
    phase: "PLAN_REVIEW",
    planningStatus: "COMPLETED",
    planningHandoffRef: {
      path: "outputs/planning-handoff.json",
      mediaType: "application/json",
    },
  });
  expect(registry.getState()).not.toHaveProperty("planArtifactRef");
  observation.dispose();
});

it("fails closed when canonical structured output is missing", () => {
  const events = new FakeEventBus();
  const registry = startedRegistry();
  const observation = registerPlanningCompletionObservation(
    events,
    registry,
    "session-1",
    { isCompletionTrusted: () => true },
  );

  events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    runId: "planning-run",
    sessionId: "session-1",
    state: "complete",
    success: true,
    results: [{}],
  });

  expect(registry.getState()).toMatchObject({
    phase: "FAILED",
    finalStatus: "FAILED",
  });
  observation.dispose();
});

it("does not accept a top-level structured result without canonical results", () => {
  const events = new FakeEventBus();
  const registry = startedRegistry();
  const observation = registerPlanningCompletionObservation(
    events,
    registry,
    "session-1",
    { isCompletionTrusted: () => true },
  );

  events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    runId: "planning-run",
    sessionId: "session-1",
    state: "complete",
    success: true,
    structuredOutput: planningResult(),
  });

  expect(registry.getState()).toMatchObject({
    phase: "FAILED",
    finalStatus: "FAILED",
  });
  observation.dispose();
});

it("does not fall back to a non-canonical valid result", () => {
  const events = new FakeEventBus();
  const registry = startedRegistry();
  const observation = registerPlanningCompletionObservation(
    events,
    registry,
    "session-1",
    { isCompletionTrusted: () => true },
  );
  const invalidCanonicalResult = {
    ...planningResult(),
    remainingBlockers: [{ code: "BLOCKED", reason: "Evidence is missing." }],
  };

  events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    runId: "planning-run",
    sessionId: "session-1",
    state: "complete",
    success: true,
    structuredOutput: planningResult(),
    results: [{ structuredOutput: invalidCanonicalResult }],
  });

  expect(registry.getState()).toMatchObject({
    phase: "FAILED",
    finalStatus: "FAILED",
  });
  observation.dispose();
});

it("requires one canonical result and a trusted matching run", () => {
  const multipleResults = new FakeEventBus();
  const multipleRegistry = startedRegistry();
  const multipleObservation = registerPlanningCompletionObservation(
    multipleResults,
    multipleRegistry,
    "session-1",
    { isCompletionTrusted: () => true },
  );
  multipleResults.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    runId: "planning-run",
    sessionId: "session-1",
    state: "complete",
    success: true,
    results: [
      { structuredOutput: planningResult() },
      { structuredOutput: planningResult() },
    ],
  });
  expect(multipleRegistry.getState()).toMatchObject({ phase: "FAILED" });
  multipleObservation.dispose();

  const untrustedEvents = new FakeEventBus();
  const untrustedRegistry = startedRegistry();
  const untrustedObservation = registerPlanningCompletionObservation(
    untrustedEvents,
    untrustedRegistry,
    "session-1",
    { isCompletionTrusted: () => false },
  );
  untrustedEvents.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    runId: "planning-run",
    sessionId: "session-1",
    state: "complete",
    success: true,
    results: [{ structuredOutput: planningResult() }],
  });
  expect(untrustedRegistry.getState()).toMatchObject({ phase: "FAILED" });
  untrustedObservation.dispose();

  const foreignEvents = new FakeEventBus();
  const foreignRegistry = startedRegistry();
  const foreignObservation = registerPlanningCompletionObservation(
    foreignEvents,
    foreignRegistry,
    "session-1",
    { isCompletionTrusted: () => true },
  );
  foreignEvents.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    runId: "planning-run",
    sessionId: "foreign-session",
    state: "complete",
    success: true,
    results: [{ structuredOutput: planningResult() }],
  });
  expect(foreignRegistry.getState()).toMatchObject({ phase: "PLANNING" });
  foreignObservation.dispose();
});

it("fails closed when a completed planning result is missing an artifact ref", () => {
  const events = new FakeEventBus();
  const registry = startedRegistry();
  const observation = registerPlanningCompletionObservation(
    events,
    registry,
    "session-1",
    { isCompletionTrusted: () => true },
  );
  const result = planningResult();
  Reflect.deleteProperty(result, "planningHandoffRef");

  events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
    runId: "planning-run",
    sessionId: "session-1",
    state: "complete",
    success: true,
    structuredOutput: result,
  });

  expect(registry.getState()).toMatchObject({
    phase: "FAILED",
    finalStatus: "FAILED",
  });
  observation.dispose();
});
