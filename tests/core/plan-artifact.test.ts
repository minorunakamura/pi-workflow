import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import {
  REQUIRED_PLAN_HEADINGS,
  createInitialWorkflowState,
  createPlanningHandoff,
  createWorkflowId,
  hashPlan,
  validatePlanArtifactReference,
  validatePlanArtifactTemplate,
  validatePlanningArtifactReferences,
  validatePlanningHandoffAgainstPlan,
  validatePlanningHandoffReference,
  validateRootWorkflowState,
} from "../../src/core/index.ts";

const WORKFLOW_ID = createWorkflowId("00000000-0000-4000-8000-000000000001");
const PLAN = `${REQUIRED_PLAN_HEADINGS.join("\n")}\n\nBounded plan.\n`;

function handoff() {
  const result = createPlanningHandoff({
    workflowId: WORKFLOW_ID,
    planContent: PLAN,
    tddMode: "required",
    testStrategy: {
      kind: "unit",
      required: true,
      summary: "Run focused tests.",
    },
    testSeams: ["core validator"],
    constraints: ["No Pi imports in core."],
    nonGoals: ["No runtime implementation."],
  });
  if (!result.valid) throw new Error(result.errors.join("; "));
  return result.value;
}

it("keeps the canonical template headings complete", () => {
  const template = readFileSync(
    new URL("../../docs/implementation-plan-template.md", import.meta.url),
    "utf8",
  );
  expect(validatePlanArtifactTemplate(template).valid).toBe(true);
  expect(
    validatePlanArtifactTemplate("# Implementation Plan\n## Goal\n").valid,
  ).toBe(false);
});

it("validates co-located managed Plan and Handoff references", () => {
  const planRef = {
    kind: "managed" as const,
    path: "run-1/implementation-plan.md",
    mediaType: "text/markdown" as const,
  };
  const handoffRef = {
    kind: "managed" as const,
    path: "run-1/planning-handoff.json",
    mediaType: "application/json" as const,
  };

  expect(validatePlanArtifactReference(planRef).valid).toBe(true);
  expect(validatePlanningHandoffReference(handoffRef).valid).toBe(true);
  expect(validatePlanningArtifactReferences(planRef, handoffRef).valid).toBe(
    true,
  );
  const actualPlanRef = {
    ...planRef,
    path: "/managed/run-1/implementation-plan.md",
  };
  const actualHandoffRef = {
    ...handoffRef,
    path: "/managed/run-1/planning-handoff.json",
  };
  expect(
    validatePlanningArtifactReferences(actualPlanRef, actualHandoffRef).valid,
  ).toBe(true);
  const state = createInitialWorkflowState(WORKFLOW_ID, "feature");
  state.planningHandoffRef = actualHandoffRef;
  expect(validateRootWorkflowState(state).valid).toBe(true);
  expect(
    validatePlanningArtifactReferences(planRef, {
      ...handoffRef,
      path: "other-run/planning-handoff.json",
    }).valid,
  ).toBe(false);
  expect(
    validatePlanArtifactReference({
      ...planRef,
      path: "../implementation-plan.md",
    }).valid,
  ).toBe(false);
  expect(
    validatePlanningHandoffReference({
      ...handoffRef,
      approval: true,
    }).valid,
  ).toBe(false);
});

it("self-validates the Handoff against the canonical Plan hash", () => {
  const value = handoff();
  expect(
    validatePlanningHandoffAgainstPlan(value, PLAN, WORKFLOW_ID).valid,
  ).toBe(true);
  expect(
    validatePlanningHandoffAgainstPlan(value, `${PLAN}changed`, WORKFLOW_ID)
      .valid,
  ).toBe(false);
  expect(value.planHash).toEqual(hashPlan(PLAN));
});
