import { describe, expect, it } from "vitest";
import {
  addDynamicStep,
  addStep,
  createDynamicStep,
  DYNAMIC_STEP_TRIGGERS,
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

  it("creates dynamic Steps for every supported trigger", () => {
    for (const [index, trigger] of DYNAMIC_STEP_TRIGGERS.entries()) {
      const graph = createStepGraph();
      const next = addDynamicStep(
        graph,
        { ...step(`dynamic-${index}`), trigger },
        DYNAMIC_STEP_TRIGGERS.length,
      );

      expect(next.steps[0]).toMatchObject({
        id: `dynamic-${index}`,
        origin: "dynamic",
        trigger,
      });
    }
  });

  it("deduplicates active equivalent purposes without consuming a dynamic budget", () => {
    const existing = createDynamicStep({
      ...step("existing"),
      objective: "investigate the failure",
      trigger: "uncertainty",
      status: "running",
    });
    const graph = createStepGraph([existing]);

    const next = addDynamicStep(
      graph,
      { ...step("duplicate"), objective: "investigate the failure", trigger: "decision" },
      1,
    );

    expect(next).toBe(graph);
    expect(next.graphRevision).toBe(graph.graphRevision);
    expect(next.steps).toHaveLength(1);
  });

  it("enforces supported triggers, max_dynamic_steps, and graph invariants", () => {
    const graph = createStepGraph([
      createDynamicStep({ ...step("existing"), trigger: "uncertainty" }),
    ]);

    expect(() => addDynamicStep(graph, { ...step("over-limit"), trigger: "decision" }, 1)).toThrow(
      /max_dynamic_steps/,
    );
    expect(() =>
      addDynamicStep(
        createStepGraph(),
        { ...step("missing-reference", ["missing"]), trigger: "decision" },
        1,
      ),
    ).toThrow(/invalid dependency/);
    expect(() =>
      addDynamicStep(createStepGraph(), { ...step("cycle", ["cycle"]), trigger: "decision" }, 1),
    ).toThrow(/cycle/);
    expect(() =>
      addDynamicStep(
        createStepGraph(),
        { ...step("unsupported"), trigger: "unsupported trigger" },
        1,
      ),
    ).toThrow(/unsupported dynamic Step trigger/);
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

  it("does not reopen completed equivalent Steps", () => {
    const completed = createDynamicStep({
      ...step("completed"),
      objective: "investigate the failure",
      status: "completed",
      trigger: "uncertainty",
    });
    const graph = createStepGraph([completed]);

    const next = addDynamicStep(
      graph,
      { ...step("follow-up"), objective: "investigate the failure", trigger: "recovery" },
      2,
    );

    expect(next.steps).toHaveLength(2);
    expect(next.steps[0]).toMatchObject({ id: "completed", status: "completed" });
    expect(next.steps[1]).toMatchObject({
      id: "follow-up",
      origin: "dynamic",
      status: "pending",
    });
  });

  it("updates lifecycle state without changing graph topology", () => {
    const graph = createStepGraph([step("a")]);
    const next = transitionStepInGraph(graph, stepId("a"), "ready");

    expect(next.graphRevision).toBe(graph.graphRevision);
    expect(next.steps[0]?.status).toBe("ready");
    expect(graph.steps[0]?.status).toBe("pending");
  });
});
