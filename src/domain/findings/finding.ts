import type { FindingId } from "../primitives/ids.js";

export const FINDING_STATES = ["open", "resolved"] as const;
export type FindingState = (typeof FINDING_STATES)[number];

export const FINDING_DISPOSITIONS = [
  "pending",
  "fix-required",
  "accepted",
  "fixed",
  "dismissed",
] as const;
export type FindingDisposition = (typeof FINDING_DISPOSITIONS)[number];

export const FINDING_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_CONFIDENCES = ["high", "medium", "low"] as const;
export type FindingConfidence = (typeof FINDING_CONFIDENCES)[number];

export type Finding = Readonly<{
  id: FindingId;
  state: FindingState;
  disposition: FindingDisposition;
  severity: FindingSeverity;
  confidence: FindingConfidence;
}>;

export type FindingInput = Readonly<{
  id: FindingId;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  state?: FindingState;
  disposition?: FindingDisposition;
}>;

export const FINDING_DISPOSITIONS_BY_STATE: Readonly<
  Record<FindingState, readonly FindingDisposition[]>
> = {
  open: ["pending", "fix-required", "accepted"],
  resolved: ["fixed", "dismissed"],
};

export class FindingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingValidationError";
  }
}

export class InvalidFindingDispositionError extends FindingValidationError {
  constructor(
    readonly state: FindingState,
    readonly disposition: FindingDisposition,
  ) {
    super(`Invalid Finding state/disposition pair: ${state}/${disposition}`);
    this.name = "InvalidFindingDispositionError";
  }
}

function isCanonical<T extends readonly string[]>(value: string, values: T): value is T[number] {
  return (values as readonly string[]).includes(value);
}

function canonical<T extends readonly string[]>(value: string, values: T, name: string): T[number] {
  if (!isCanonical(value, values)) {
    throw new FindingValidationError(`Invalid ${name}: ${value}`);
  }
  return value;
}

function assertFindingPair(state: FindingState, disposition: FindingDisposition): void {
  if (!FINDING_DISPOSITIONS_BY_STATE[state].includes(disposition)) {
    throw new InvalidFindingDispositionError(state, disposition);
  }
}

export function isValidFindingPair(state: string, disposition: string): state is FindingState {
  return (
    isCanonical(state, FINDING_STATES) &&
    isCanonical(disposition, FINDING_DISPOSITIONS) &&
    FINDING_DISPOSITIONS_BY_STATE[state].includes(disposition)
  );
}

export function createFinding(input: FindingInput): Finding {
  const state = canonical(input.state ?? "open", FINDING_STATES, "Finding state");
  const disposition = canonical(
    input.disposition ?? "pending",
    FINDING_DISPOSITIONS,
    "Finding disposition",
  );
  assertFindingPair(state, disposition);
  return {
    id: input.id,
    state,
    disposition,
    severity: canonical(input.severity, FINDING_SEVERITIES, "Finding severity"),
    confidence: canonical(input.confidence, FINDING_CONFIDENCES, "Finding confidence"),
  };
}

export function transitionFinding(
  finding: Finding,
  to: FindingState | FindingDisposition,
  disposition?: FindingDisposition,
): Finding {
  const currentState = canonical(finding.state, FINDING_STATES, "Finding state");
  const currentDisposition = canonical(
    finding.disposition,
    FINDING_DISPOSITIONS,
    "Finding disposition",
  );
  assertFindingPair(currentState, currentDisposition);

  const isState = isCanonical(to, FINDING_STATES);
  const state = isState ? to : to === "fixed" || to === "dismissed" ? "resolved" : "open";
  const nextDisposition = isState ? (disposition ?? (to === "open" ? "pending" : "fixed")) : to;

  if (!isState && disposition !== undefined) {
    throw new FindingValidationError(
      "A Finding disposition transition must not include a second disposition",
    );
  }

  const nextState = canonical(state, FINDING_STATES, "Finding state");
  const validDisposition = canonical(nextDisposition, FINDING_DISPOSITIONS, "Finding disposition");
  assertFindingPair(nextState, validDisposition);

  if (nextState === finding.state && validDisposition === finding.disposition) {
    return finding;
  }
  return { ...finding, state: nextState, disposition: validDisposition };
}

export function changeFindingDisposition(
  finding: Finding,
  disposition: FindingDisposition,
): Finding {
  return transitionFinding(finding, finding.state, disposition);
}

export function reopenFinding(
  finding: Finding,
  disposition: Extract<FindingDisposition, "pending" | "fix-required" | "accepted"> = "pending",
): Finding {
  return transitionFinding(finding, "open", disposition);
}
