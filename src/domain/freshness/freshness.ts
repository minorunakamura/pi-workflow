export const PLAN_APPLICABILITY_STATUSES = [
  "current",
  "compatible",
  "replan-required",
  "unknown",
] as const;
export type PlanApplicabilityStatus = (typeof PLAN_APPLICABILITY_STATUSES)[number];

export const CHANGE_SET_RELEVANCE_STATUSES = [
  "relevant",
  "partially-superseded",
  "superseded",
  "unknown",
] as const;
export type ChangeSetRelevanceStatus = (typeof CHANGE_SET_RELEVANCE_STATUSES)[number];

export const FRESHNESS_STATUSES = ["fresh", "stale", "unknown"] as const;
export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number];

/** An absent rule result is ambiguous and must not be treated as false. */
export type RuleResult = boolean | undefined;

export type PlanApplicabilityRules = Readonly<{
  current?: RuleResult;
  compatible?: RuleResult;
  replanRequired?: RuleResult;
}>;

export type ChangeSetRelevanceRules = Readonly<{
  relevant?: RuleResult;
  partiallySuperseded?: RuleResult;
  superseded?: RuleResult;
}>;

export type FreshnessRules = Readonly<{
  fresh?: RuleResult;
  stale?: RuleResult;
}>;

function resolveRules<T extends string>(
  rules: readonly (readonly [T, RuleResult])[],
): T | "unknown" {
  if (rules.some(([, result]) => result === undefined)) {
    return "unknown";
  }

  const matches = rules.filter(([, result]) => result === true).map(([status]) => status);
  return matches.length === 1 ? matches[0]! : "unknown";
}

export function evaluatePlanApplicability(rules: PlanApplicabilityRules): PlanApplicabilityStatus {
  return resolveRules([
    ["current", rules.current],
    ["compatible", rules.compatible],
    ["replan-required", rules.replanRequired],
  ]);
}

export function evaluateChangeSetRelevance(
  rules: ChangeSetRelevanceRules,
): ChangeSetRelevanceStatus {
  return resolveRules([
    ["relevant", rules.relevant],
    ["partially-superseded", rules.partiallySuperseded],
    ["superseded", rules.superseded],
  ]);
}

export function evaluateFreshness(rules: FreshnessRules): FreshnessStatus {
  return resolveRules([
    ["fresh", rules.fresh],
    ["stale", rules.stale],
  ]);
}

export function evaluateVerificationFreshness(rules: FreshnessRules): FreshnessStatus {
  return evaluateFreshness(rules);
}

export function evaluateReviewFreshness(rules: FreshnessRules): FreshnessStatus {
  return evaluateFreshness(rules);
}

export function isFreshForCompletion(status: FreshnessStatus): boolean {
  return status === "fresh";
}
