import type { DecisionId } from "../primitives/ids.js";

export const DECISION_CLASSES = ["D1", "D2", "D3"] as const;
export type DecisionClass = (typeof DECISION_CLASSES)[number];

export const DECISION_STATUSES = ["pending", "resolved", "superseded"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export type Decision = Readonly<{
  id: DecisionId;
  class: DecisionClass;
  status: DecisionStatus;
}>;

export type DecisionInput = Readonly<{
  id: DecisionId;
  class: DecisionClass;
  status?: DecisionStatus;
}>;

export class DecisionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionValidationError";
  }
}

function isCanonical<T extends readonly string[]>(value: string, values: T): value is T[number] {
  return (values as readonly string[]).includes(value);
}

function canonical<T extends readonly string[]>(value: string, values: T, name: string): T[number] {
  if (!isCanonical(value, values)) {
    throw new DecisionValidationError(`Invalid ${name}: ${value}`);
  }
  return value;
}

export function createDecision(input: DecisionInput): Decision {
  return {
    id: input.id,
    class: canonical(input.class, DECISION_CLASSES, "Decision class"),
    status: canonical(input.status ?? "pending", DECISION_STATUSES, "Decision status"),
  };
}

export function canTransitionDecision(from: string, to: string): to is DecisionStatus {
  return isCanonical(from, DECISION_STATUSES) && isCanonical(to, DECISION_STATUSES);
}

export function transitionDecision(decision: Decision, to: DecisionStatus): Decision {
  canonical(decision.status, DECISION_STATUSES, "Decision status");
  const status = canonical(to, DECISION_STATUSES, "Decision status");
  return status === decision.status ? decision : { ...decision, status };
}
