import { describe, expect, it } from "vitest";
import {
  validateReviewDecision,
  type ReviewDecisionV1,
} from "../../src/core/review/review-decision-schema";

const validDecision: ReviewDecisionV1 = {
  version: 1,
  blockers: [
    {
      id: "correctness-1",
      source: "correctness",
      location: "src/api/search.ts:12",
      summary: "The empty query is accepted unexpectedly.",
    },
  ],
  fixNow: [
    {
      id: "ponytail-1",
      source: "ponytail",
      summary: "The wrapper duplicates a standard helper.",
    },
  ],
  deferred: [],
  rejected: [
    {
      id: "correctness-2",
      source: "correctness",
      summary: "This is already covered by the acceptance test.",
      reason: "No current defect is demonstrated.",
    },
  ],
  decisionRequired: [
    {
      id: "decision-1",
      question: "Should the endpoint be public?",
      context: "The existing API has both public and internal routes.",
    },
  ],
};

describe("validateReviewDecision", () => {
  it("accepts the structured review contract", () => {
    expect(validateReviewDecision(validDecision)).toEqual({
      ok: true,
      value: validDecision,
      errors: [],
    });
  });

  it("rejects duplicate finding ids across categories", () => {
    const invalid = structuredClone(validDecision);
    invalid.deferred.push({
      id: "correctness-1",
      source: "correctness",
      summary: "Duplicate finding.",
    });

    const result = validateReviewDecision(invalid);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        path: "/deferred/0/id",
        message: "review ids must be unique",
      });
    }
  });

  it("rejects unknown sources and missing rejection reasons", () => {
    const invalid = structuredClone(validDecision);
    Reflect.set(invalid.fixNow[0], "source", "security");
    invalid.rejected[0].reason = "";

    const result = validateReviewDecision(invalid);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          {
            path: "/fixNow/0/source",
            message: "must match a schema in anyOf",
          },
          {
            path: "/rejected/0/reason",
            message: "must not have fewer than 1 characters",
          },
        ]),
      );
    }
  });
});
