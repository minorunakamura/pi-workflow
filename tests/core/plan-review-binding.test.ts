import { describe, expect, it } from "vitest";
import {
  MAX_PLAN_REVIEW_BINDING_BYTES,
  validateMissionState,
  validatePlanReviewBinding,
  type PlanReviewBindingV1,
} from "../../src/core/state/contracts";
import { jsonByteLength } from "../../src/core/validation";
import { MAX_REFERENCE_BYTES } from "../../src/core/state/references";

const binding: PlanReviewBindingV1 = {
  version: 1,
  status: "pending",
  round: 1,
  planRef: "plan-artifact-ref",
  reviewId: "review-1",
};

describe("PlanReviewBindingV1", () => {
  it("accepts the compact pending/terminal binding shape", () => {
    expect(validatePlanReviewBinding(binding)).toEqual({
      ok: true,
      value: binding,
      errors: [],
    });
    expect(
      validatePlanReviewBinding({ ...binding, status: "approved", round: 3 }),
    ).toMatchObject({ ok: true });
    expect(
      validatePlanReviewBinding({
        ...binding,
        status: "rejected",
        feedbackRef: "feedback-artifact-ref",
      }),
    ).toMatchObject({ ok: true });
  });

  it("is accepted as a Mission state field but not as code-review state", () => {
    expect(
      validateMissionState({ version: 1, planReview: binding }),
    ).toMatchObject({
      ok: true,
    });
    expect(
      validatePlanReviewBinding({ ...binding, planningDecision: {} }),
    ).toMatchObject({ ok: false });
    expect(
      validatePlanReviewBinding({ ...binding, feedback: "full feedback" }),
    ).toMatchObject({ ok: false });
    expect(
      validatePlanReviewBinding({ ...binding, status: "rejected" }),
    ).toMatchObject({ ok: false });
  });

  it("bounds references and aggregate state", () => {
    expect(
      validatePlanReviewBinding({
        ...binding,
        planRef: "r".repeat(MAX_REFERENCE_BYTES),
      }),
    ).toMatchObject({ ok: false });

    const oversized = {
      ...binding,
      feedbackRef: "x".repeat(MAX_PLAN_REVIEW_BINDING_BYTES),
    };
    expect(jsonByteLength(oversized)).toBeGreaterThan(
      MAX_PLAN_REVIEW_BINDING_BYTES,
    );
    expect(validatePlanReviewBinding(oversized)).toMatchObject({ ok: false });
  });
});
