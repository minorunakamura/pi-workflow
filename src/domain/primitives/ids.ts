declare const domainIdBrand: unique symbol;

type BrandedId<Kind extends string> = string & {
  readonly [domainIdBrand]: Kind;
};

export type RunId = BrandedId<"RunId">;
export type StepId = BrandedId<"StepId">;
export type ExecutionId = BrandedId<"ExecutionId">;
export type UncertaintyId = BrandedId<"UncertaintyId">;
export type DecisionId = BrandedId<"DecisionId">;
export type GateId = BrandedId<"GateId">;
export type FindingId = BrandedId<"FindingId">;
export type AcceptanceCriterionId = BrandedId<"AcceptanceCriterionId">;
export type ConstraintId = BrandedId<"ConstraintId">;
export type PlanUnitId = BrandedId<"PlanUnitId">;
export type VerificationCheckId = BrandedId<"VerificationCheckId">;
export type PlanDeviationId = BrandedId<"PlanDeviationId">;
export type ChangeSetId = BrandedId<"ChangeSetId">;
export type VerificationRunId = BrandedId<"VerificationRunId">;
export type ReviewRunId = BrandedId<"ReviewRunId">;

export type RequirementElementId = AcceptanceCriterionId | ConstraintId;
export type PlanScopedId = PlanUnitId | VerificationCheckId;

export type PlanScopedReference<Id extends PlanScopedId> = Readonly<{
  id: Id;
  planVersion: number;
}>;

export type PlanUnitReference = PlanScopedReference<PlanUnitId>;
export type VerificationCheckReference = PlanScopedReference<VerificationCheckId>;

export interface IdAllocator {
  issueRunId(): RunId;
  issueStepId(): StepId;
  issueExecutionId(): ExecutionId;
  issueUncertaintyId(): UncertaintyId;
  issueDecisionId(): DecisionId;
  issueGateId(): GateId;
  issueFindingId(): FindingId;
  issueAcceptanceCriterionId(): AcceptanceCriterionId;
  issueConstraintId(): ConstraintId;
  issuePlanUnitId(planVersion: number): PlanUnitId;
  issueVerificationCheckId(planVersion: number): VerificationCheckId;
  issuePlanDeviationId(): PlanDeviationId;
  issueChangeSetId(): ChangeSetId;
  issueVerificationRunId(): VerificationRunId;
  issueReviewRunId(): ReviewRunId;
  issuePlanUnitReference(planVersion: number): PlanUnitReference;
  issueVerificationCheckReference(planVersion: number): VerificationCheckReference;
}

const PLAN_VERSION_ERROR = "planVersion must be a positive safe integer";

function assertPlanVersion(planVersion: number): void {
  if (!Number.isSafeInteger(planVersion) || planVersion < 1) {
    throw new RangeError(PLAN_VERSION_ERROR);
  }
}

function nextId<T extends string>(
  counters: Map<string, number>,
  counterKey: string,
  prefix: string = counterKey,
): T {
  const next = counters.get(counterKey) ?? 1;
  if (next > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("ID sequence exhausted");
  }

  counters.set(counterKey, next + 1);
  return `${prefix}-${String(next).padStart(3, "0")}` as T;
}

function nextPlanScopedId<T extends string>(
  counters: Map<string, number>,
  prefix: string,
  planVersion: number,
): T {
  assertPlanVersion(planVersion);
  return nextId(counters, `${prefix}:${planVersion}`, prefix);
}

export function createPlanUnitReference(id: PlanUnitId, planVersion: number): PlanUnitReference {
  assertPlanVersion(planVersion);
  return { id, planVersion };
}

export function createVerificationCheckReference(
  id: VerificationCheckId,
  planVersion: number,
): VerificationCheckReference {
  assertPlanVersion(planVersion);
  return { id, planVersion };
}

export function createIdAllocator(): IdAllocator {
  const counters = new Map<string, number>();

  return {
    issueRunId: () => nextId<RunId>(counters, "run"),
    issueStepId: () => nextId<StepId>(counters, "step"),
    issueExecutionId: () => nextId<ExecutionId>(counters, "exec"),
    issueUncertaintyId: () => nextId<UncertaintyId>(counters, "U"),
    issueDecisionId: () => nextId<DecisionId>(counters, "D"),
    issueGateId: () => nextId<GateId>(counters, "G"),
    issueFindingId: () => nextId<FindingId>(counters, "F"),
    issueAcceptanceCriterionId: () => nextId<AcceptanceCriterionId>(counters, "AC"),
    issueConstraintId: () => nextId<ConstraintId>(counters, "C"),
    issuePlanUnitId: (planVersion) => nextPlanScopedId<PlanUnitId>(counters, "P", planVersion),
    issueVerificationCheckId: (planVersion) =>
      nextPlanScopedId<VerificationCheckId>(counters, "V", planVersion),
    issuePlanDeviationId: () => nextId<PlanDeviationId>(counters, "PD"),
    issueChangeSetId: () => nextId<ChangeSetId>(counters, "CS"),
    issueVerificationRunId: () => nextId<VerificationRunId>(counters, "VR"),
    issueReviewRunId: () => nextId<ReviewRunId>(counters, "RR"),
    issuePlanUnitReference: (planVersion) => {
      const id = nextPlanScopedId<PlanUnitId>(counters, "P", planVersion);
      return createPlanUnitReference(id, planVersion);
    },
    issueVerificationCheckReference: (planVersion) => {
      const id = nextPlanScopedId<VerificationCheckId>(counters, "V", planVersion);
      return createVerificationCheckReference(id, planVersion);
    },
  };
}
