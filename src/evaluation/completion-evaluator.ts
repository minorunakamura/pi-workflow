import type { Decision } from "../domain/decisions/decision.js";
import type { Finding } from "../domain/findings/finding.js";
import type { StepStatus } from "../domain/graph/step-graph.js";
import type { Uncertainty } from "../domain/uncertainty/uncertainty.js";
import {
  isRepositoryDriftBlocking,
  type FreshnessStatus,
  type PlanApplicabilityStatus,
} from "../domain/freshness/freshness.js";

export const ACCEPTANCE_CRITERION_STATUSES = [
  "satisfied",
  "not-satisfied",
  "not-verifiable",
  "not-applicable",
] as const;
export type AcceptanceCriterionStatus = (typeof ACCEPTANCE_CRITERION_STATUSES)[number];

export const CONSTRAINT_STATUSES = ["respected", "violated", "not-evaluated"] as const;
export type ConstraintStatus = (typeof CONSTRAINT_STATUSES)[number];

export const REPOSITORY_DRIFT_CLASSIFICATIONS = [
  "clean",
  "unrelated",
  "relevant",
  "critical",
  "unknown",
] as const;
export type RepositoryDriftClassification = (typeof REPOSITORY_DRIFT_CLASSIFICATIONS)[number];

export const REPOSITORY_DRIFT_RESOLUTIONS = ["clear", "unresolved", "reconciled"] as const;
export type RepositoryDriftResolution = (typeof REPOSITORY_DRIFT_RESOLUTIONS)[number];

export const VERIFICATION_RESULTS = ["passed", "failed", "incomplete"] as const;
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

export const REVIEW_RESULTS = ["clean", "findings", "incomplete"] as const;
export type ReviewResult = (typeof REVIEW_RESULTS)[number];

export const COMPLETION_BLOCKER_CODES = [
  "STEP_INCOMPLETE",
  "AC_NOT_SATISFIED",
  "AC_NOT_VERIFIABLE",
  "CONSTRAINT_VIOLATED",
  "CONSTRAINT_NOT_EVALUATED",
  "PLAN_NOT_APPLICABLE",
  "IMPLEMENTATION_UNRECONCILED",
  "REPOSITORY_DRIFT_UNRESOLVED",
  "VERIFICATION_MISSING",
  "VERIFICATION_STALE",
  "VERIFICATION_FAILED",
  "VERIFICATION_LIMITATION_UNACCEPTED",
  "REVIEW_MISSING",
  "REVIEW_STALE",
  "REVIEW_INCOMPLETE",
  "FINDING_PENDING",
  "FINDING_FIX_REQUIRED",
  "UNCERTAINTY_UNRESOLVED",
  "DECISION_PENDING",
  "GATE_NOT_PASSED",
  "TERMINAL_ERROR_PRESENT",
  "VERIFICATION_UNKNOWN",
  "REVIEW_UNKNOWN",
] as const;
export type CompletionBlockerCode = (typeof COMPLETION_BLOCKER_CODES)[number];

type AcceptanceCriterion =
  | AcceptanceCriterionStatus
  | Readonly<{
      status: AcceptanceCriterionStatus;
      limitationAccepted?: boolean;
      [key: string]: unknown;
    }>;

type Constraint =
  | ConstraintStatus
  | Readonly<{
      status: ConstraintStatus;
      [key: string]: unknown;
    }>;

export type CompletionStep = Readonly<{
  status: StepStatus;
  required?: boolean;
  skipAuthorized?: boolean;
  obsolete?: boolean;
}>;

export type CompletionRequirement = Readonly<{
  acceptanceCriteria?: readonly AcceptanceCriterion[];
  constraints?: readonly Constraint[];
}>;

export type CompletionPlan = Readonly<{
  required?: boolean;
  applicability?: PlanApplicabilityStatus;
}>;

export type CompletionImplementation = Readonly<{
  reconciled?: boolean;
  currentChangesExplained?: boolean;
}>;

export type CompletionRepository = Readonly<{
  classification?: RepositoryDriftClassification;
  resolution?: RepositoryDriftResolution;
}>;

export type CompletionVerification = Readonly<{
  required?: boolean;
  present?: boolean;
  freshness?: FreshnessStatus;
  result?: VerificationResult;
  limitationAccepted?: boolean;
}>;

export type CompletionReview = Readonly<{
  required?: boolean;
  present?: boolean;
  freshness?: FreshnessStatus;
  result?: ReviewResult;
  complete?: boolean;
  findings?: readonly Pick<Finding, "state" | "disposition">[];
}>;

export type CompletionGate = Readonly<{
  status: "waiting" | "passed" | "failed" | "superseded";
  controlling?: boolean;
}>;

export type CompletionControlState = Readonly<{
  uncertainties?: readonly Pick<Uncertainty, "status">[];
  decisions?: readonly Pick<Decision, "status">[];
  gates?: readonly CompletionGate[];
  terminalError?: boolean;
}>;

export type CompletionEvaluationInput = Readonly<{
  steps?: readonly CompletionStep[];
  requirement?: CompletionRequirement;
  plan?: CompletionPlan;
  implementation?: CompletionImplementation;
  repository?: CompletionRepository;
  verification?: CompletionVerification;
  review?: CompletionReview;
  controlState?: CompletionControlState;
}>;

export type CompletionEvaluation = Readonly<{
  eligible: boolean;
  blockers: readonly CompletionBlockerCode[];
}>;

export type CompletionEvaluator = (input: CompletionEvaluationInput) => CompletionEvaluation;

function evaluateSteps(
  steps: readonly CompletionStep[] | undefined,
  addBlocker: (code: CompletionBlockerCode) => void,
): void {
  if (steps === undefined) {
    addBlocker("STEP_INCOMPLETE");
    return;
  }

  for (const step of steps) {
    if (step.required === false || step.status === "completed") {
      continue;
    }
    if (step.status === "skipped" && (step.skipAuthorized === true || step.obsolete === true)) {
      continue;
    }
    addBlocker("STEP_INCOMPLETE");
  }
}

function evaluateRequirement(
  requirement: CompletionRequirement | undefined,
  addBlocker: (code: CompletionBlockerCode) => void,
): void {
  if (requirement?.acceptanceCriteria === undefined) {
    addBlocker("AC_NOT_VERIFIABLE");
  } else {
    for (const criterion of requirement.acceptanceCriteria) {
      const status = typeof criterion === "string" ? criterion : criterion.status;
      if (status === "not-satisfied") {
        addBlocker("AC_NOT_SATISFIED");
      } else if (
        status === "not-verifiable" &&
        (typeof criterion === "string" || criterion.limitationAccepted !== true)
      ) {
        addBlocker("AC_NOT_VERIFIABLE");
      } else if (
        status !== "satisfied" &&
        status !== "not-applicable" &&
        status !== "not-verifiable"
      ) {
        addBlocker("AC_NOT_VERIFIABLE");
      }
    }
  }

  if (requirement?.constraints === undefined) {
    addBlocker("CONSTRAINT_NOT_EVALUATED");
    return;
  }

  for (const constraint of requirement.constraints) {
    const status = typeof constraint === "string" ? constraint : constraint.status;
    if (status === "violated") {
      addBlocker("CONSTRAINT_VIOLATED");
    } else if (status !== "respected" && status !== "not-evaluated") {
      addBlocker("CONSTRAINT_NOT_EVALUATED");
    } else if (status === "not-evaluated") {
      addBlocker("CONSTRAINT_NOT_EVALUATED");
    }
  }
}

function evaluatePlan(
  plan: CompletionPlan | undefined,
  addBlocker: (code: CompletionBlockerCode) => void,
): void {
  if (plan?.required === false) {
    return;
  }
  if (plan?.applicability !== "current" && plan?.applicability !== "compatible") {
    addBlocker("PLAN_NOT_APPLICABLE");
  }
}

function evaluateImplementation(
  implementation: CompletionImplementation | undefined,
  addBlocker: (code: CompletionBlockerCode) => void,
): void {
  const facts = [implementation?.reconciled, implementation?.currentChangesExplained].filter(
    (value): value is boolean => value !== undefined,
  );
  if (facts.length === 0 || facts.some((value) => value === false)) {
    addBlocker("IMPLEMENTATION_UNRECONCILED");
  }
}

function evaluateRepository(
  repository: CompletionRepository | undefined,
  addBlocker: (code: CompletionBlockerCode) => void,
): void {
  if (repository?.classification === undefined || repository.resolution === undefined) {
    addBlocker("REPOSITORY_DRIFT_UNRESOLVED");
    return;
  }

  if (isRepositoryDriftBlocking(repository.classification, repository.resolution)) {
    addBlocker("REPOSITORY_DRIFT_UNRESOLVED");
  }
}

function evaluateVerification(
  verification: CompletionVerification | undefined,
  addBlocker: (code: CompletionBlockerCode) => void,
): void {
  if (verification?.required === false) {
    return;
  }
  if (verification?.present !== true) {
    addBlocker("VERIFICATION_MISSING");
    return;
  }

  if (verification.freshness === "stale") {
    addBlocker("VERIFICATION_STALE");
  } else if (verification.freshness !== "fresh") {
    addBlocker("VERIFICATION_UNKNOWN");
  }

  if (verification.result === "failed") {
    addBlocker("VERIFICATION_FAILED");
  } else if (verification.result !== "passed") {
    if (verification.limitationAccepted !== true) {
      addBlocker("VERIFICATION_LIMITATION_UNACCEPTED");
    }
  }
}

function evaluateReview(
  review: CompletionReview | undefined,
  addBlocker: (code: CompletionBlockerCode) => void,
): void {
  const required = review?.required !== false;
  if (required && review?.present !== true) {
    addBlocker("REVIEW_MISSING");
  } else if (required) {
    if (review.freshness === "stale") {
      addBlocker("REVIEW_STALE");
    } else if (review.freshness !== "fresh") {
      addBlocker("REVIEW_UNKNOWN");
    }

    const complete = review.complete ?? (review.result === "clean" || review.result === "findings");
    if (!complete || review.result === "incomplete") {
      addBlocker("REVIEW_INCOMPLETE");
    }
  }

  for (const finding of review?.findings ?? []) {
    if (finding.state === "open" && finding.disposition === "pending") {
      addBlocker("FINDING_PENDING");
    } else if (finding.state === "open" && finding.disposition === "fix-required") {
      addBlocker("FINDING_FIX_REQUIRED");
    }
  }
}

function evaluateControlState(
  controlState: CompletionControlState | undefined,
  addBlocker: (code: CompletionBlockerCode) => void,
): void {
  if (controlState?.uncertainties === undefined) {
    addBlocker("UNCERTAINTY_UNRESOLVED");
  } else {
    for (const uncertainty of controlState.uncertainties) {
      if (uncertainty.status !== "resolved" && uncertainty.status !== "accepted") {
        addBlocker("UNCERTAINTY_UNRESOLVED");
      }
    }
  }

  if (controlState?.decisions === undefined) {
    addBlocker("DECISION_PENDING");
  } else {
    for (const decision of controlState.decisions) {
      if (decision.status !== "resolved" && decision.status !== "superseded") {
        addBlocker("DECISION_PENDING");
      }
    }
  }

  if (controlState?.gates === undefined) {
    addBlocker("GATE_NOT_PASSED");
  } else {
    for (const gate of controlState.gates) {
      if (gate.controlling !== false && gate.status !== "passed" && gate.status !== "superseded") {
        addBlocker("GATE_NOT_PASSED");
      }
    }
  }

  if (controlState?.terminalError === true) {
    addBlocker("TERMINAL_ERROR_PRESENT");
  }
}

export function evaluateCompletion(input: CompletionEvaluationInput): CompletionEvaluation {
  const blockers = new Set<CompletionBlockerCode>();
  const addBlocker = (code: CompletionBlockerCode): void => {
    blockers.add(code);
  };

  evaluateSteps(input.steps, addBlocker);
  evaluateRequirement(input.requirement, addBlocker);
  evaluatePlan(input.plan, addBlocker);
  evaluateImplementation(input.implementation, addBlocker);
  evaluateRepository(input.repository, addBlocker);
  evaluateVerification(input.verification, addBlocker);
  evaluateReview(input.review, addBlocker);
  evaluateControlState(input.controlState, addBlocker);

  return { eligible: blockers.size === 0, blockers: [...blockers] };
}
