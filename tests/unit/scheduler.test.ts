import { describe, expect, it } from "vitest";
import { createStep } from "../../src/domain/graph/step-graph.js";
import {
  isGraphNoProgress,
  selectNextStep,
  type SchedulerGate,
  type SchedulerPriority,
  type SchedulerState,
  type SchedulerStep,
} from "../../src/domain/scheduling/scheduler.js";
import type { GateId, StepId } from "../../src/domain/primitives/ids.js";

const stepId = (value: string): StepId => value as StepId;
const gateId = (value: string): GateId => value as GateId;

function step(
  id: string,
  options: {
    priority?: SchedulerPriority;
    status?: "pending" | "ready" | "running" | "blocked" | "completed" | "failed" | "skipped";
    dependsOn?: string[];
    blockedBy?: string[];
    controllingGateIds?: string[];
  } = {},
): SchedulerStep {
  return {
    ...createStep({
      id: stepId(id),
      type: "implementation",
      objective: id,
      agent: "worker",
      status: options.status ?? "ready",
      ...(options.dependsOn === undefined ? {} : { dependsOn: options.dependsOn.map(stepId) }),
      ...(options.blockedBy === undefined ? {} : { blockedBy: options.blockedBy }),
    }),
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(options.controllingGateIds === undefined
      ? {}
      : { controllingGateIds: options.controllingGateIds.map(gateId) }),
  };
}

function gate(id: string, status: SchedulerGate["status"], stepIds: string[] = []): SchedulerGate {
  return {
    id: gateId(id),
    type: "verification",
    status,
    stepIds: stepIds.map(stepId),
  };
}

describe("Sequential Scheduler", () => {
  it("selects at most one ready Step by priority, then Step ID", () => {
    const state: SchedulerState = {
      steps: [
        step("z", { priority: "P4" }),
        step("b", { priority: "P2" }),
        step("a", { priority: "P2" }),
      ],
    };

    const result = selectNextStep(state);

    expect(result).toMatchObject({ kind: "dispatch", step: { id: "a" } });
    expect(state.steps.map(({ id }) => id)).toEqual(["z", "b", "a"]);
  });

  it("requires completed dependencies, passed controlling Gates, and no blockers", () => {
    const state: SchedulerState = {
      steps: [
        step("dependency", { dependsOn: ["source"] }),
        step("source", { status: "pending" }),
        step("gated", { controllingGateIds: ["G-001"] }),
        step("blocked", { blockedBy: ["finding"] }),
        step("available"),
      ],
      gates: [gate("G-001", "waiting", ["gated"])],
    };

    expect(selectNextStep(state)).toMatchObject({ kind: "dispatch", step: { id: "available" } });

    const unblocked: SchedulerState = {
      ...state,
      steps: [
        step("dependency", { dependsOn: ["source"] }),
        step("source", { status: "completed" }),
        step("gated", { controllingGateIds: ["G-001"] }),
      ],
      gates: [gate("G-001", "passed", ["gated"])],
    };

    expect(selectNextStep(unblocked)).toMatchObject({
      kind: "dispatch",
      step: { id: "dependency" },
    });
    expect(selectNextStep({ ...unblocked, steps: unblocked.steps.slice(2) })).toMatchObject({
      kind: "dispatch",
      step: { id: "gated" },
    });
  });

  it("reports no progress without mutating state", () => {
    const state: SchedulerState = {
      steps: [step("waiting", { status: "pending" })],
    };
    const before = JSON.stringify(state);

    const result = selectNextStep(state);

    expect(isGraphNoProgress(result)).toBe(true);
    expect(result).toEqual({ kind: "idle", reason: "GRAPH_NO_PROGRESS" });
    expect(JSON.stringify(state)).toBe(before);
  });

  it("does not report graph no-progress for active or recoverable work", () => {
    const ready = step("ready");

    expect(selectNextStep({ steps: [ready], activeExecution: true })).toEqual({
      kind: "idle",
      reason: "ACTIVE_EXECUTION",
    });
    expect(selectNextStep({ steps: [], hasRecoverableBlocker: true })).toEqual({
      kind: "idle",
      reason: "RECOVERABLE_BLOCKER",
    });
    expect(selectNextStep({ steps: [ready], runComplete: true })).toEqual({
      kind: "idle",
      reason: "RUN_COMPLETE",
    });
    expect(selectNextStep({ steps: [ready], runTerminal: true })).toEqual({
      kind: "idle",
      reason: "RUN_TERMINAL",
    });
  });
});
