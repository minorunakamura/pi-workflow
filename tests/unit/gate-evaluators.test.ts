import { describe, expect, it } from "vitest";
import {
  evaluateApprovalGate,
  evaluateCompletion,
  evaluateCompletionGate,
  evaluateDecisionGate,
  evaluateEvidenceGate,
  evaluateUncertaintyGate,
  evaluateVerificationGate,
  type GateEvaluationInput,
} from "../../src/evaluation/gate-evaluators.js";

const evaluators = [
  evaluateEvidenceGate,
  evaluateUncertaintyGate,
  evaluateDecisionGate,
  evaluateVerificationGate,
  evaluateApprovalGate,
  evaluateCompletion,
];

describe("Gate evaluators", () => {
  it("provides all six evaluators with deterministic Gate statuses", () => {
    for (const evaluate of evaluators) {
      expect(evaluate({ satisfied: undefined })).toBe("waiting");
      expect(evaluate({ satisfied: true })).toBe("passed");
      expect(evaluate({ satisfied: false })).toBe("failed");
      expect(evaluate({ satisfied: false, superseded: true })).toBe("superseded");
    }
  });

  it("does not mutate its input", () => {
    const input: GateEvaluationInput = Object.freeze({ satisfied: true });
    const before = { ...input };

    expect(evaluateEvidenceGate(input)).toBe("passed");
    expect(input).toEqual(before);
  });

  it("projects the CompletionEvaluator result without recursive evaluation", () => {
    const input: GateEvaluationInput = { satisfied: true };
    let calls = 0;
    const completionEvaluator = (received: GateEvaluationInput) => {
      calls += 1;
      expect(received).toBe(input);
      return "failed" as const;
    };

    expect(evaluateCompletionGate(input, completionEvaluator)).toBe("failed");
    expect(calls).toBe(1);
  });
});
