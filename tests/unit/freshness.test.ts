import { describe, expect, it } from "vitest";
import {
  evaluateChangeSetRelevance,
  evaluatePlanApplicability,
  evaluateReviewFreshness,
  evaluateVerificationFreshness,
  isFreshForCompletion,
  type ChangeSetRelevanceRules,
  type FreshnessRules,
  type PlanApplicabilityRules,
} from "../../src/domain/freshness/freshness.js";

const planRules = (overrides: Partial<PlanApplicabilityRules>): PlanApplicabilityRules => ({
  current: false,
  compatible: false,
  replanRequired: false,
  ...overrides,
});

const changeSetRules = (overrides: Partial<ChangeSetRelevanceRules>): ChangeSetRelevanceRules => ({
  relevant: false,
  partiallySuperseded: false,
  superseded: false,
  ...overrides,
});

const freshnessRules = (overrides: Partial<FreshnessRules>): FreshnessRules => ({
  fresh: false,
  stale: false,
  ...overrides,
});

describe("Applicability and freshness evaluators", () => {
  it("resolves each Plan and Change Set rule deterministically", () => {
    expect(evaluatePlanApplicability(planRules({ current: true }))).toBe("current");
    expect(evaluatePlanApplicability(planRules({ compatible: true }))).toBe("compatible");
    expect(evaluatePlanApplicability(planRules({ replanRequired: true }))).toBe("replan-required");

    expect(evaluateChangeSetRelevance(changeSetRules({ relevant: true }))).toBe("relevant");
    expect(evaluateChangeSetRelevance(changeSetRules({ partiallySuperseded: true }))).toBe(
      "partially-superseded",
    );
    expect(evaluateChangeSetRelevance(changeSetRules({ superseded: true }))).toBe("superseded");
  });

  it("returns unknown for missing, absent, or contradictory semantic rules", () => {
    expect(evaluatePlanApplicability(planRules({}))).toBe("unknown");
    expect(
      evaluatePlanApplicability({ current: undefined, compatible: false, replanRequired: false }),
    ).toBe("unknown");
    expect(evaluateChangeSetRelevance(changeSetRules({}))).toBe("unknown");
    expect(evaluateChangeSetRelevance(changeSetRules({ relevant: true, superseded: true }))).toBe(
      "unknown",
    );
    expect(evaluateVerificationFreshness(freshnessRules({}))).toBe("unknown");
    expect(evaluateVerificationFreshness({ fresh: undefined, stale: false })).toBe("unknown");
  });

  it("uses the same fail-closed freshness rules for VR and RR", () => {
    const fresh = freshnessRules({ fresh: true });
    const stale = freshnessRules({ stale: true });

    expect(evaluateVerificationFreshness(fresh)).toBe("fresh");
    expect(evaluateReviewFreshness(fresh)).toBe("fresh");
    expect(evaluateVerificationFreshness(stale)).toBe("stale");
    expect(evaluateReviewFreshness(stale)).toBe("stale");
    expect(isFreshForCompletion("fresh")).toBe(true);
    expect(isFreshForCompletion("stale")).toBe(false);
    expect(isFreshForCompletion("unknown")).toBe(false);
  });
});
