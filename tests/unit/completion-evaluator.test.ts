import { describe, expect, it } from "vitest";
import {
  evaluateCompletion,
  type CompletionEvaluationInput,
} from "../../src/evaluation/completion-evaluator.js";

function readyState(): CompletionEvaluationInput {
  return {
    steps: [{ status: "completed" }],
    requirement: {
      acceptanceCriteria: [{ status: "satisfied" }],
      constraints: [{ status: "respected" }],
    },
    plan: { required: true, applicability: "current" },
    implementation: { reconciled: true },
    repository: { classification: "clean", resolution: "clear" },
    verification: {
      required: true,
      present: true,
      freshness: "fresh",
      result: "passed",
    },
    review: {
      required: true,
      present: true,
      freshness: "fresh",
      result: "clean",
      findings: [],
    },
    controlState: {
      uncertainties: [],
      decisions: [],
      gates: [],
      terminalError: false,
    },
  };
}

describe("Completion evaluator", () => {
  it("evaluates all eight domains when no blocker exists", () => {
    expect(evaluateCompletion(readyState())).toEqual({ eligible: true, blockers: [] });
  });

  it("reports blockers from Steps, Requirement, Plan, Implementation, and Repository", () => {
    const state = readyState();
    const result = evaluateCompletion({
      ...state,
      steps: [{ status: "running" }],
      requirement: {
        acceptanceCriteria: [{ status: "not-satisfied" }],
        constraints: [{ status: "violated" }],
      },
      plan: { required: true, applicability: "replan-required" },
      implementation: { reconciled: false },
      repository: { classification: "relevant", resolution: "unresolved" },
    });

    expect(result.eligible).toBe(false);
    expect(result.blockers).toEqual([
      "STEP_INCOMPLETE",
      "AC_NOT_SATISFIED",
      "CONSTRAINT_VIOLATED",
      "PLAN_NOT_APPLICABLE",
      "IMPLEMENTATION_UNRECONCILED",
      "REPOSITORY_DRIFT_UNRESOLVED",
    ]);
  });

  it("does not accept away AC or Constraint violations", () => {
    const state = readyState();
    const result = evaluateCompletion({
      ...state,
      requirement: {
        acceptanceCriteria: [{ status: "not-satisfied", accepted: true }],
        constraints: [{ status: "violated", accepted: true }],
      },
    });

    expect(result.blockers).toEqual(["AC_NOT_SATISFIED", "CONSTRAINT_VIOLATED"]);
  });

  it("blocks stale or failed Verification and Review plus blocking Findings", () => {
    const state = readyState();
    const verification = evaluateCompletion({
      ...state,
      verification: { present: true, freshness: "stale", result: "passed" },
    });
    const review = evaluateCompletion({
      ...state,
      review: {
        present: true,
        freshness: "stale",
        result: "incomplete",
        findings: [
          { state: "open", disposition: "pending" },
          { state: "open", disposition: "fix-required" },
        ],
      },
    });

    expect(verification).toMatchObject({
      eligible: false,
      blockers: ["VERIFICATION_STALE"],
    });
    expect(review).toMatchObject({
      eligible: false,
      blockers: ["REVIEW_STALE", "REVIEW_INCOMPLETE", "FINDING_PENDING", "FINDING_FIX_REQUIRED"],
    });
  });

  it("allows explicitly accepted residual Uncertainty but not an open one", () => {
    expect(
      evaluateCompletion({
        ...readyState(),
        controlState: { uncertainties: [{ status: "accepted" }], decisions: [], gates: [] },
      }),
    ).toEqual({ eligible: true, blockers: [] });
    expect(
      evaluateCompletion({
        ...readyState(),
        controlState: { uncertainties: [{ status: "resolved" }], decisions: [], gates: [] },
      }),
    ).toEqual({ eligible: true, blockers: [] });
  });

  it("reports control blockers and treats absent facts as blocking", () => {
    const state = readyState();
    const blocked = evaluateCompletion({
      ...state,
      controlState: {
        uncertainties: [{ status: "open" }],
        decisions: [{ status: "pending" }],
        gates: [{ status: "waiting", controlling: true }],
        terminalError: true,
      },
    });
    const unknown = evaluateCompletion({});

    expect(blocked.blockers).toEqual([
      "UNCERTAINTY_UNRESOLVED",
      "DECISION_PENDING",
      "GATE_NOT_PASSED",
      "TERMINAL_ERROR_PRESENT",
    ]);
    expect(unknown.eligible).toBe(false);
    expect(unknown.blockers).toContain("VERIFICATION_MISSING");
    expect(unknown.blockers).toContain("REVIEW_MISSING");
  });

  it("does not mutate authoritative input and allows explicitly optional domains", () => {
    const state = readyState();
    const before = JSON.stringify(state);
    const result = evaluateCompletion({
      ...state,
      plan: { required: false },
      verification: { required: false },
      review: { required: false, findings: [] },
    });

    expect(result.eligible).toBe(true);
    expect(JSON.stringify(state)).toBe(before);
  });
});
