import { expect, it } from "vitest";

import {
  createInitialWorkflowState,
  createWorkflowId,
  transitionRootWorkflowState,
  type RootWorkflowState,
} from "../../src/core/index.ts";
import {
  ROOT_LIFECYCLE_ENTRY_TYPE,
  RootWorkflowRegistry,
  persistRootWorkflowState,
  restoreRootWorkflowState,
} from "../../src/runtime/root-lifecycle.ts";

const UUID = "00000000-0000-4000-8000-000000000001";

function activeState(): RootWorkflowState {
  const initial = createInitialWorkflowState(createWorkflowId(UUID), "feature");
  const result = transitionRootWorkflowState(initial, "PLANNING");
  if (!result.valid) {
    throw new Error(result.reason);
  }
  return result.state;
}

it("persists only the compact Root state and restores the latest valid branch snapshot", () => {
  const entries: Array<{ type: string; customType: string; data: unknown }> =
    [];
  const registry = new RootWorkflowRegistry((customType, data) => {
    entries.push({ type: "custom", customType, data });
  });

  const started = registry.start(createWorkflowId(UUID), "feature");
  expect(started.started).toBe(true);
  if (!started.started) {
    return;
  }
  expect(entries).toHaveLength(1);
  expect(entries[0]).toEqual({
    type: "custom",
    customType: ROOT_LIFECYCLE_ENTRY_TYPE,
    data: started.state,
  });
  expect(Object.hasOwn(started.state, "request")).toBe(false);
  expect(Object.hasOwn(started.state, "cwd")).toBe(false);

  const restored = restoreRootWorkflowState([
    entries[0],
    {
      type: "custom",
      customType: ROOT_LIFECYCLE_ENTRY_TYPE,
      data: { ...started.state, request: "raw request" },
    },
    { type: "custom", customType: "other-extension", data: "ignored" },
  ]);
  expect(restored).toEqual(started.state);
});

it("advances the Root lifecycle and blocks transitions after a terminal state", () => {
  const registry = new RootWorkflowRegistry(() => undefined);
  const started = registry.start(createWorkflowId(UUID), "bug");
  expect(started.started).toBe(true);

  expect(registry.transition("PLAN_REVIEW")).toMatchObject({
    transitioned: true,
    state: { phase: "PLAN_REVIEW", planningStatus: "COMPLETED" },
  });
  expect(registry.transition("IMPLEMENTING")).toMatchObject({
    transitioned: true,
    state: { phase: "IMPLEMENTING", implementationStatus: "RUNNING" },
  });
  expect(registry.transition("CODE_REVIEW")).toMatchObject({
    transitioned: true,
    state: { phase: "CODE_REVIEW", implementationStatus: "COMPLETED" },
  });
  expect(registry.transition("READY_FOR_MERGE")).toMatchObject({
    transitioned: true,
    state: { phase: "READY_FOR_MERGE", finalStatus: "READY_FOR_MERGE" },
  });
  expect(registry.transition("FAILED")).toEqual({
    transitioned: false,
    reason: "Invalid transition: READY_FOR_MERGE -> FAILED",
  });
});

it("allows one active workflow per registry but does not create a cross-session lock", () => {
  const first = new RootWorkflowRegistry(() => undefined);
  const second = new RootWorkflowRegistry(() => undefined);

  expect(first.start(createWorkflowId(UUID), "feature").started).toBe(true);
  expect(
    first.start(
      createWorkflowId("00000000-0000-4000-8000-000000000002"),
      "bug",
    ),
  ).toEqual({
    started: false,
    reason: "ACTIVE_WORKFLOW_EXISTS",
  });
  expect(
    second.start(
      createWorkflowId("00000000-0000-4000-8000-000000000002"),
      "bug",
    ).started,
  ).toBe(true);
});

it("refuses invalid snapshots and invalid persistence input", () => {
  const state = activeState();
  expect(
    restoreRootWorkflowState([
      {
        type: "custom",
        customType: ROOT_LIFECYCLE_ENTRY_TYPE,
        data: { ...state, approval: "yes" },
      },
    ]),
  ).toBeUndefined();
  expect(() =>
    persistRootWorkflowState(
      () => undefined,
      Object.assign({}, state, { request: "raw request" }),
    ),
  ).toThrow("invalid Root workflow state");
});
