import { describe, expect, it } from "vitest";
import {
  addStep,
  createDynamicStep,
  createStep,
  createStepGraph,
  obsoleteStep,
  skipStep,
  transitionStep,
  transitionStepInGraph,
  validateStepGraph,
} from "../../src/domain/graph/step-graph.js";
import type { StepId } from "../../src/domain/primitives/ids.js";

const stepId = (value: string): StepId => value as StepId;

function step(id: string, dependsOn: string[] = []) {
  return createStep({
    id: stepId(id),
    type: "implementation",
    objective: id,
    agent: "worker",
    dependsOn: dependsOn.map(stepId),
  });
}

describe("Step graph", () => {
  it("rejects missing references, duplicate dependencies, and cycles", () => {
    expect(() => validateStepGraph([step("a", ["missing"])])).toThrow(/invalid dependency/);
    expect(() => validateStepGraph([step("a", ["a"])])).toThrow(/cycle/);
    expect(() => validateStepGraph([step("a"), step("a")])).toThrow(/duplicate Step id/);
    expect(() => validateStepGraph([step("a"), step("b", ["a", "a"])])).toThrow(
      /duplicate dependency/,
    );
    expect(() => validateStepGraph([step("a", ["b"]), step("b", ["a"])])).toThrow(/cycle/);
  });

  it("accepts a valid DAG and increments the graph revision for additions", () => {
    const graph = createStepGraph([step("a"), step("b", ["a"])]);
    const next = addStep(graph, step("c", ["b"]));

    expect(graph.graphRevision).toBe(1);
    expect(next.graphRevision).toBe(2);
    expect(next.steps.map(({ id }) => id)).toEqual(["a", "b", "c"]);
  });

  it("enforces lifecycle transitions and keeps terminal Steps terminal", () => {
    const ready = transitionStep(step("a"), "ready");
    const running = transitionStep(ready, "running");
    const failed = transitionStep(running, "failed");
    const retry = transitionStep(failed, "ready");
    const completed = transitionStep(transitionStep(retry, "running"), "completed");

    expect(ready.status).toBe("ready");
    expect(completed.status).toBe("completed");
    expect(() => transitionStep(step("a"), "running")).toThrow(/Invalid Step transition/);
    expect(() => transitionStep(completed, "ready")).toThrow(/Invalid Step transition/);
  });

  it("represents dynamic origin and authorized obsolete skipping", () => {
    const dynamic = createDynamicStep({
      ...step("research"),
      trigger: "uncertainty",
      type: "research",
      agent: "researcher",
    });
    const skipped = skipStep(dynamic, "not needed after clarification");
    const obsolete = obsoleteStep(step("old"), "superseded by a re-plan");

    expect(dynamic).toMatchObject({ origin: "dynamic", trigger: "uncertainty" });
    expect(skipped).toMatchObject({
      status: "skipped",
      skipReason: "not needed after clarification",
    });
    expect(obsolete).toMatchObject({
      status: "skipped",
      obsolete: true,
      skipReason: "superseded by a re-plan",
    });
    expect(() => obsoleteStep(transitionStep(step("done"), "ready"), "too late")).toThrow();
    expect(() => createDynamicStep({ ...step("invalid"), trigger: "" })).toThrow(/trigger/);
  });

  it("updates lifecycle state without changing graph topology", () => {
    const graph = createStepGraph([step("a")]);
    const next = transitionStepInGraph(graph, stepId("a"), "ready");

    expect(next.graphRevision).toBe(graph.graphRevision);
    expect(next.steps[0]?.status).toBe("ready");
    expect(graph.steps[0]?.status).toBe("pending");
  });
});
