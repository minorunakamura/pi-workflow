export const GATE_STATUSES = ["waiting", "passed", "failed", "superseded"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

/**
 * A gate evaluator consumes an already-derived condition. `undefined` keeps a
 * gate waiting instead of treating an unknown condition as a failure.
 */
export type GateEvaluationInput = Readonly<{
  satisfied: boolean | undefined;
  superseded?: boolean;
}>;

export type GateEvaluator = (input: GateEvaluationInput) => GateStatus;
export type CompletionEvaluator = GateEvaluator;

function evaluateCondition(input: GateEvaluationInput): GateStatus {
  if (input.superseded === true) {
    return "superseded";
  }
  if (input.satisfied === undefined) {
    return "waiting";
  }
  return input.satisfied ? "passed" : "failed";
}

export function evaluateEvidenceGate(input: GateEvaluationInput): GateStatus {
  return evaluateCondition(input);
}

export function evaluateUncertaintyGate(input: GateEvaluationInput): GateStatus {
  return evaluateCondition(input);
}

export function evaluateDecisionGate(input: GateEvaluationInput): GateStatus {
  return evaluateCondition(input);
}

export function evaluateVerificationGate(input: GateEvaluationInput): GateStatus {
  return evaluateCondition(input);
}

export function evaluateApprovalGate(input: GateEvaluationInput): GateStatus {
  return evaluateCondition(input);
}

export function evaluateCompletion(input: GateEvaluationInput): GateStatus {
  return evaluateCondition(input);
}

/** The Completion Gate is only a projection of CompletionEvaluator output. */
export function evaluateCompletionGate(
  input: GateEvaluationInput,
  completionEvaluator: CompletionEvaluator = evaluateCompletion,
): GateStatus {
  return completionEvaluator(input);
}
