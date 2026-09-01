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

export const REPOSITORY_DRIFT_CLASSIFICATIONS = [
  "clean",
  "unrelated",
  "relevant",
  "critical",
  "unknown",
] as const;
export type RepositoryDriftClassification = (typeof REPOSITORY_DRIFT_CLASSIFICATIONS)[number];
export type RepositoryDriftPathClassification = Exclude<RepositoryDriftClassification, "clean">;

export const REPOSITORY_DRIFT_RESOLUTIONS = ["clear", "unresolved", "reconciled"] as const;
export type RepositoryDriftResolution = (typeof REPOSITORY_DRIFT_RESOLUTIONS)[number];

export type RepositoryDriftPath = Readonly<{
  path: string;
  classification: RepositoryDriftPathClassification;
}>;

export type RepositoryDriftEvaluationInput = Readonly<{
  paths: readonly RepositoryDriftPath[];
  controlPlaneChanged?: boolean;
  unknownChange?: boolean;
  resolution?: RepositoryDriftResolution;
}>;

export type RepositoryDriftEvaluation = Readonly<{
  classification: RepositoryDriftClassification;
  resolution: RepositoryDriftResolution;
  blocking: boolean;
}>;

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

function highestDriftClassification(
  paths: readonly RepositoryDriftPath[],
): RepositoryDriftClassification {
  for (const classification of ["critical", "unknown", "relevant", "unrelated"] as const) {
    if (paths.some((path) => path.classification === classification)) {
      return classification;
    }
  }
  return "clean";
}

export function isRepositoryDriftBlocking(
  classification: RepositoryDriftClassification,
  resolution: RepositoryDriftResolution,
): boolean {
  const clear =
    (classification === "clean" || classification === "unrelated") && resolution === "clear";
  const reconciled =
    (classification === "relevant" ||
      classification === "critical" ||
      classification === "unknown") &&
    resolution === "reconciled";
  return !clear && !reconciled;
}

export function evaluateRepositoryDrift(
  input: RepositoryDriftEvaluationInput,
): RepositoryDriftEvaluation {
  const classification =
    input.controlPlaneChanged === true
      ? "critical"
      : input.unknownChange === true && input.paths.length === 0
        ? "unknown"
        : highestDriftClassification(input.paths);
  const resolution =
    input.resolution ??
    (classification === "clean" || classification === "unrelated" ? "clear" : "unresolved");
  return {
    classification,
    resolution,
    blocking: isRepositoryDriftBlocking(classification, resolution),
  };
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
