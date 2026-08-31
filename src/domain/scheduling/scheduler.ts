import type { Step, StepType } from "../graph/step-graph.js";
import type { GateId, StepId } from "../primitives/ids.js";

export const SCHEDULER_PRIORITIES = ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"] as const;
export type SchedulerPriority = (typeof SCHEDULER_PRIORITIES)[number];

export type SchedulerGateType =
  | "evidence"
  | "uncertainty"
  | "decision"
  | "verification"
  | "approval"
  | "completion";

export type SchedulerGateStatus = "waiting" | "passed" | "failed" | "superseded";

export type SchedulerGate = Readonly<{
  id: GateId;
  type: SchedulerGateType;
  status: SchedulerGateStatus;
  stepIds?: readonly StepId[];
}>;

/** Scheduling metadata stays outside the persisted Step shape. */
export type SchedulerStep = Step &
  Readonly<{
    priority?: SchedulerPriority;
    controllingGateIds?: readonly GateId[];
  }>;

export type SchedulerState = Readonly<{
  steps: readonly SchedulerStep[];
  gates?: readonly SchedulerGate[];
  activeExecution?: boolean;
  runComplete?: boolean;
  runTerminal?: boolean;
  hasRecoverableBlocker?: boolean;
}>;

export type SchedulerPolicy = Readonly<{
  priorityByStep?: Readonly<Record<string, SchedulerPriority>>;
  controllingGateIdsByStep?: Readonly<Record<string, readonly GateId[]>>;
}>;

export const SCHEDULER_IDLE_REASONS = [
  "ACTIVE_EXECUTION",
  "RUN_COMPLETE",
  "RUN_TERMINAL",
  "RECOVERABLE_BLOCKER",
  "GRAPH_NO_PROGRESS",
] as const;
export type SchedulerIdleReason = (typeof SCHEDULER_IDLE_REASONS)[number];

export type SchedulerResult =
  | Readonly<{
      kind: "dispatch";
      step: SchedulerStep;
    }>
  | Readonly<{
      kind: "idle";
      reason: SchedulerIdleReason;
    }>;

const PRIORITY_RANK: Readonly<Record<SchedulerPriority, number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
  P5: 5,
  P6: 6,
  P7: 7,
  P8: 8,
};

const DEFAULT_STEP_PRIORITIES: Readonly<Record<StepType, SchedulerPriority>> = {
  analysis: "P7",
  research: "P7",
  decision: "P2",
  planning: "P4",
  implementation: "P4",
  verification: "P5",
  review: "P6",
};

function priorityFor(step: SchedulerStep, policy: SchedulerPolicy): SchedulerPriority {
  return policy.priorityByStep?.[step.id] ?? step.priority ?? DEFAULT_STEP_PRIORITIES[step.type];
}

function controllingGateIdsFor(
  step: SchedulerStep,
  policy: SchedulerPolicy,
  gates: readonly SchedulerGate[],
): readonly GateId[] {
  const ids = new Set<GateId>([
    ...(policy.controllingGateIdsByStep?.[step.id] ?? []),
    ...(step.controllingGateIds ?? []),
  ]);

  for (const gate of gates) {
    if (gate.stepIds?.includes(step.id)) {
      ids.add(gate.id);
    }
  }

  return [...ids];
}

function dependenciesSatisfied(
  step: SchedulerStep,
  stepsById: ReadonlyMap<StepId, SchedulerStep>,
): boolean {
  return step.dependsOn.every((dependencyId) => {
    const dependency = stepsById.get(dependencyId);
    return dependency?.status === "completed" || dependency?.status === "skipped";
  });
}

function gatesPassed(
  step: SchedulerStep,
  policy: SchedulerPolicy,
  gates: readonly SchedulerGate[],
  gatesById: ReadonlyMap<GateId, SchedulerGate>,
): boolean {
  return controllingGateIdsFor(step, policy, gates).every(
    (gateId) => gatesById.get(gateId)?.status === "passed",
  );
}

function isReady(
  step: SchedulerStep,
  stepsById: ReadonlyMap<StepId, SchedulerStep>,
  policy: SchedulerPolicy,
  gates: readonly SchedulerGate[],
  gatesById: ReadonlyMap<GateId, SchedulerGate>,
): boolean {
  return (
    step.status === "ready" &&
    step.blockedBy.length === 0 &&
    dependenciesSatisfied(step, stepsById) &&
    gatesPassed(step, policy, gates, gatesById)
  );
}

function compareStepIds(left: StepId, right: StepId): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function compareSteps(left: SchedulerStep, right: SchedulerStep, policy: SchedulerPolicy): number {
  const priorityDifference =
    PRIORITY_RANK[priorityFor(left, policy)] - PRIORITY_RANK[priorityFor(right, policy)];
  return priorityDifference === 0 ? compareStepIds(left.id, right.id) : priorityDifference;
}

export function selectNextStep(
  state: SchedulerState,
  policy: SchedulerPolicy = {},
): SchedulerResult {
  const gates = state.gates ?? [];

  if (state.activeExecution || state.steps.some((step) => step.status === "running")) {
    return { kind: "idle", reason: "ACTIVE_EXECUTION" };
  }
  if (state.runComplete) {
    return { kind: "idle", reason: "RUN_COMPLETE" };
  }
  if (state.runTerminal) {
    return { kind: "idle", reason: "RUN_TERMINAL" };
  }

  const stepsById = new Map<StepId, SchedulerStep>(state.steps.map((step) => [step.id, step]));
  const gatesById = new Map<GateId, SchedulerGate>(gates.map((gate) => [gate.id, gate]));
  const readySteps = state.steps.filter((step) =>
    isReady(step, stepsById, policy, gates, gatesById),
  );

  if (readySteps.length === 0) {
    return {
      kind: "idle",
      reason: state.hasRecoverableBlocker ? "RECOVERABLE_BLOCKER" : "GRAPH_NO_PROGRESS",
    };
  }

  let selected = readySteps[0]!;
  for (const candidate of readySteps) {
    if (compareSteps(candidate, selected, policy) < 0) {
      selected = candidate;
    }
  }

  return { kind: "dispatch", step: selected };
}

export function isGraphNoProgress(result: SchedulerResult): boolean {
  return result.kind === "idle" && result.reason === "GRAPH_NO_PROGRESS";
}
