import type { JsonObject, StepResultV1 } from "../contracts/execution/agent-execution.js";
import type { DomainEventDraft, EventActorV1, EventType } from "../contracts/events/event.js";
import type { ResultNormalizationResult } from "./normalization/result-normalizer.js";
import type { SchedulerStep } from "../domain/scheduling/scheduler.js";
import type { WorkflowState } from "../ports/run-reader.js";
import type { CompletionEvaluation } from "../evaluation/completion-evaluator.js";
import { persistedRuntimeTelemetry } from "../telemetry/runtime-metrics.js";

export type WorkflowEventInput = Readonly<{
  before: WorkflowState;
  after: WorkflowState;
  completion: CompletionEvaluation;
  result: StepResultV1 | null;
  step: SchedulerStep | null;
  normalized?: ResultNormalizationResult | null;
  iteration: number;
}>;

export type WorkflowEventFactory = (
  input: WorkflowEventInput,
) => MaybePromise<readonly DomainEventDraft[]>;

type MaybePromise<T> = T | Promise<T>;

const EXECUTION_ID = /^exec-\d+$/;
const ENTITY_CORRELATION_ID = /^(?:U|D|G|F|P|CS|VR|RR)-\d+$/;

type EventNow = () => Date;
type StateEntity = Readonly<{ id: string; status: string }>;

type EventBuilder = (
  type: EventType,
  data: JsonObject,
  correlationId?: string,
  source?: string,
  actor?: EventActorV1,
) => void;

export type WorkflowEventFactoryOptions = Readonly<{
  now?: EventNow;
}>;

const UNCERTAINTY_EVENTS: Readonly<Record<string, EventType>> = {
  resolving: "uncertainty.resolving",
  resolved: "uncertainty.resolved",
  accepted: "uncertainty.accepted",
  escalated: "uncertainty.escalated",
};
const DECISION_EVENTS: Readonly<Record<string, EventType>> = {
  resolved: "decision.resolved",
  superseded: "decision.superseded",
};
const GATE_EVENTS: Readonly<Record<string, EventType>> = {
  passed: "gate.passed",
  failed: "gate.failed",
  superseded: "gate.superseded",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestamp(now: EventNow): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError("now must return a valid Date");
  }
  return value.toISOString();
}

function eventId(value: unknown): string | undefined {
  return typeof value === "string" && EXECUTION_ID.test(value) ? value : undefined;
}

function entityCorrelation(value: string | undefined, fallback: string): string {
  return value !== undefined && ENTITY_CORRELATION_ID.test(value) ? value : fallback;
}

function planStatus(state: WorkflowState): string | undefined {
  return text(record(state.run.current_plan?.applicability)?.status);
}

function playbookId(state: WorkflowState): string | undefined {
  return text(record(state.run.playbook.current)?.id);
}

function previousById<T extends StateEntity>(values: readonly T[]): Map<string, T> {
  return new Map(values.map((value) => [value.id, value]));
}

function transitionEvent(
  events: EventBuilder,
  current: StateEntity,
  previous: StateEntity | undefined,
  createdType: EventType,
  statusEvents: Readonly<Record<string, EventType>>,
  data: JsonObject,
  correlationId: string,
): void {
  if (previous === undefined) {
    events(createdType, data, correlationId);
    const createdStatusEvent = statusEvents[current.status];
    if (createdStatusEvent !== undefined) {
      events(createdStatusEvent, data, correlationId);
    }
    return;
  }
  if (previous.status === current.status) return;
  const changedStatusEvent = statusEvents[current.status];
  if (changedStatusEvent !== undefined) {
    events(changedStatusEvent, data, correlationId);
  }
}

function emitUncertainties(
  before: WorkflowState,
  after: WorkflowState,
  events: EventBuilder,
  fallbackCorrelation: string,
): void {
  const previous = previousById(before.snapshot.uncertainties.uncertainties);
  for (const current of after.snapshot.uncertainties.uncertainties) {
    const data = {
      uncertainty_id: current.id,
      status: current.status,
      category: current.category,
    } satisfies JsonObject;
    transitionEvent(
      events,
      current,
      previous.get(current.id),
      "uncertainty.created",
      UNCERTAINTY_EVENTS,
      data,
      entityCorrelation(current.id, fallbackCorrelation),
    );
  }
}

function emitDecisions(
  before: WorkflowState,
  after: WorkflowState,
  events: EventBuilder,
  fallbackCorrelation: string,
): void {
  const previous = previousById(before.snapshot.decisions.decisions);
  for (const current of after.snapshot.decisions.decisions) {
    const data = {
      decision_id: current.id,
      status: current.status,
      class: current.class,
    } satisfies JsonObject;
    transitionEvent(
      events,
      current,
      previous.get(current.id),
      "decision.created",
      DECISION_EVENTS,
      data,
      entityCorrelation(current.id, fallbackCorrelation),
    );
  }
}

function emitGates(
  before: WorkflowState,
  after: WorkflowState,
  events: EventBuilder,
  fallbackCorrelation: string,
): void {
  const previous = previousById(before.snapshot.gates.gates);
  for (const current of after.snapshot.gates.gates) {
    const data = {
      gate_id: current.id,
      status: current.status,
      type: current.type,
    } satisfies JsonObject;
    transitionEvent(
      events,
      current,
      previous.get(current.id),
      "gate.created",
      GATE_EVENTS,
      data,
      entityCorrelation(current.id, fallbackCorrelation),
    );
  }
}

function emitFindings(
  before: WorkflowState,
  after: WorkflowState,
  events: EventBuilder,
  fallbackCorrelation: string,
): void {
  const previous = new Map(
    before.snapshot.findings.findings.map((finding) => [finding.id, finding]),
  );
  for (const current of after.snapshot.findings.findings) {
    const correlationId = entityCorrelation(current.id, fallbackCorrelation);
    const data = {
      finding_id: current.id,
      state: current.state,
      disposition: current.disposition,
      severity: current.severity,
    } satisfies JsonObject;
    const prior = previous.get(current.id);
    if (prior === undefined) {
      events("finding.created", data, correlationId);
      continue;
    }
    if (prior.state !== "open" && current.state === "open") {
      events("finding.reopened", data, correlationId);
    }
    if (prior.disposition !== current.disposition) {
      events("finding.disposition-changed", data, correlationId);
    }
    if (prior.severity !== current.severity) {
      events("finding.severity-changed", data, correlationId);
    }
  }
}

function emitPlanEvents(
  before: WorkflowState,
  after: WorkflowState,
  events: EventBuilder,
  correlationId: string,
): void {
  const previousPlan = before.run.current_plan;
  const currentPlan = after.run.current_plan;
  if (previousPlan === null && currentPlan !== null) {
    events("plan.created", { version: currentPlan.version ?? null }, correlationId);
  } else if (previousPlan !== null && currentPlan !== null) {
    const previousVersion = previousPlan.version;
    const currentVersion = currentPlan.version;
    if (previousVersion !== currentVersion && currentVersion !== undefined) {
      events(
        "plan.created",
        {
          version: currentVersion,
          ...(previousVersion === undefined ? {} : { previous_version: previousVersion }),
        },
        correlationId,
      );
    }
  }

  const previousStatus = planStatus(before);
  const currentStatus = planStatus(after);
  if (previousPlan !== null && currentPlan !== null && previousStatus !== currentStatus) {
    events(
      "plan.applicability-changed",
      { from: previousStatus ?? "unknown", to: currentStatus ?? "unknown" },
      correlationId,
    );
  }
}

function emitStepGraphEvents(
  before: WorkflowState,
  after: WorkflowState,
  events: EventBuilder,
  correlationId: string,
): void {
  const previous = new Map(before.snapshot.steps.steps.map((step) => [step.id, step]));
  for (const current of after.snapshot.steps.steps) {
    const prior = previous.get(current.id);
    if (prior === undefined) {
      if (current.origin === "dynamic") {
        events("graph.step-added", { step_id: current.id, origin: current.origin }, correlationId);
      }
      continue;
    }
    if (prior.status !== "skipped" && current.status === "skipped") {
      events(
        "step.skipped",
        {
          step_id: current.id,
          ...(current.skip_reason === undefined ? {} : { reason: current.skip_reason }),
        },
        correlationId,
      );
    }
  }
}

function persistedArtifactRefs(
  state: WorkflowState,
  stepId: string,
): readonly Readonly<{ path: string; status: string }>[] {
  const step = state.snapshot.steps.steps.find(({ id }) => id === stepId);
  const values = step?.result?.artifacts;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const artifact = record(value);
    return artifact !== undefined &&
      typeof artifact.path === "string" &&
      typeof artifact.status === "string"
      ? [{ path: artifact.path, status: artifact.status }]
      : [];
  });
}

function persistedFinalization(
  state: WorkflowState,
  stepId: string,
): Record<string, unknown> | undefined {
  const step = state.snapshot.steps.steps.find(({ id }) => id === stepId);
  return record(step?.result?.finalization);
}

function emitExecutionEvents(
  input: WorkflowEventInput,
  events: EventBuilder,
  fallbackCorrelation: string,
): void {
  const { result, step } = input;
  if (result === null || step === null) return;

  const correlationId = eventId(result.identity.executionId) ?? fallbackCorrelation;
  const previousStep = input.before.snapshot.steps.steps.find(({ id }) => id === step.id);
  const executionChanged =
    record(input.before.run.current_step)?.execution_id !== result.identity.executionId;
  if (previousStep?.status !== "running" || executionChanged) {
    events(
      "step.started",
      { step_id: step.id, execution_id: result.identity.executionId },
      correlationId,
    );
    events(
      "execution.started",
      { step_id: step.id, execution_id: result.identity.executionId },
      correlationId,
      "execution",
      { type: "agent", id: step.agent },
    );
  }

  const terminal =
    result.outcome === "completed"
      ? "completed"
      : result.outcome === "blocked"
        ? "blocked"
        : "failed";
  const telemetry = persistedRuntimeTelemetry(result.runtime);
  events(
    `execution.${terminal}`,
    {
      step_id: step.id,
      execution_id: result.identity.executionId,
      outcome: result.outcome,
      ...(telemetry === undefined ? {} : { telemetry }),
    },
    correlationId,
    "execution",
    { type: "agent", id: step.agent },
  );
  events(
    `step.${terminal}`,
    { step_id: step.id, execution_id: result.identity.executionId, outcome: result.outcome },
    correlationId,
  );

  const finalization = persistedFinalization(input.after, step.id);
  const changeSet = record(finalization?.change_set);
  const verificationRun = record(finalization?.verification_run);
  const reviewRun = record(finalization?.review_run);
  if (changeSet !== undefined) {
    events(
      "change-set.created",
      {
        change_set_id: typeof changeSet.id === "string" ? changeSet.id : null,
        status: typeof changeSet.status === "string" ? changeSet.status : null,
        accepted: typeof changeSet.accepted === "boolean" ? changeSet.accepted : null,
      },
      correlationId,
    );
  }
  if (terminal === "completed" && step.type === "verification") {
    events(
      "verification.completed",
      {
        step_id: step.id,
        execution_id: result.identity.executionId,
        ...(typeof verificationRun?.id === "string"
          ? { verification_run_id: verificationRun.id }
          : {}),
        ...(typeof verificationRun?.result === "string" ? { result: verificationRun.result } : {}),
      },
      correlationId,
    );
  } else if (terminal === "completed" && step.type === "review") {
    events(
      "review.completed",
      {
        step_id: step.id,
        execution_id: result.identity.executionId,
        ...(typeof reviewRun?.id === "string" ? { review_run_id: reviewRun.id } : {}),
        ...(typeof reviewRun?.result === "string" ? { result: reviewRun.result } : {}),
      },
      correlationId,
    );
  }

  const artifacts = new Map<string, string>();
  for (const artifact of input.normalized?.artifacts.refs ?? []) {
    artifacts.set(artifact.path, artifact.status);
  }
  for (const artifact of persistedArtifactRefs(input.after, step.id)) {
    artifacts.set(artifact.path, artifact.status);
  }
  for (const [path, status] of artifacts) {
    events(
      "artifact.finalized",
      {
        step_id: step.id,
        execution_id: result.identity.executionId,
        path,
        status,
      },
      correlationId,
      "artifact-store",
      { type: "system" },
    );
  }
}

function emitRunEvents(
  input: WorkflowEventInput,
  events: EventBuilder,
  correlationId: string,
): void {
  const { before, after } = input;
  if (before.run.status === after.run.status) return;

  if (after.run.status === "blocked") {
    events("run.blocked", { status: after.run.status }, correlationId);
    return;
  }
  if (after.run.status === "completed") {
    events("run.completed", { status: after.run.status }, correlationId);
    return;
  }
  if (after.run.status === "failed") {
    events("run.failed", { status: after.run.status }, correlationId);
    return;
  }
  if (after.run.status === "cancelled") {
    events("run.cancelled", { status: after.run.status }, correlationId);
    return;
  }
  if (before.run.status === "created" && after.run.status === "running") {
    events("run.started", { status: after.run.status }, correlationId);
    return;
  }
  if (before.run.status === "failed" || before.run.status === "blocked") {
    const hasResolvedDecision = after.snapshot.decisions.decisions.some(
      (decision) =>
        before.snapshot.decisions.decisions.find(({ id }) => id === decision.id)?.status ===
          "pending" && decision.status === "resolved",
    );
    events(
      hasResolvedDecision ? "run.resumed" : "run.unblocked",
      { from: before.run.status, to: after.run.status },
      correlationId,
    );
  }
}

function emitOutcomeArtifactEvent(
  before: WorkflowState,
  after: WorkflowState,
  events: EventBuilder,
  correlationId: string,
): void {
  const previous = text(record(before.run.outcome)?.artifact_path);
  const current = text(record(after.run.outcome)?.artifact_path);
  if (current === undefined || current === previous) return;
  events(
    "artifact.finalized",
    { path: current, status: "complete" },
    correlationId,
    "artifact-store",
    { type: "system" },
  );
}

function emitRepositoryEvents(
  before: WorkflowState,
  after: WorkflowState,
  events: EventBuilder,
  correlationId: string,
): void {
  const previous = record(before.run.repository);
  const current = record(after.run.repository);
  if (previous === undefined || current === undefined) return;

  const previousResolution = text(previous.resolution);
  const currentResolution = text(current.resolution);
  if (currentResolution === "reconciled" && previousResolution !== currentResolution) {
    events("repository.drift.reconciled", { resolution: currentResolution }, correlationId);
    return;
  }

  const previousClassification = text(previous.classification);
  const currentClassification = text(current.classification);
  if (
    currentClassification !== undefined &&
    currentClassification !== previousClassification &&
    currentClassification !== "clean"
  ) {
    events("repository.drift.detected", { classification: currentClassification }, correlationId);
  }
}

function emitStateEvents(input: WorkflowEventInput, events: EventBuilder): void {
  const { before, after } = input;
  const fallbackCorrelation = after.run.run_id;
  if (before.run.state_revision === 0 && after.run.state_revision === 1) {
    events("run.created", { status: after.run.status }, fallbackCorrelation);
    events(
      "request.received",
      { request_id: after.run.request.id, type: after.run.request.type },
      fallbackCorrelation,
    );
    events(
      "requirement.created",
      { revision: after.snapshot.requirement.revision },
      fallbackCorrelation,
    );
  }
  const beforePlaybook = playbookId(before);
  const afterPlaybook = playbookId(after);

  emitStepGraphEvents(before, after, events, fallbackCorrelation);
  if (beforePlaybook !== afterPlaybook && afterPlaybook !== undefined) {
    events(
      beforePlaybook === undefined ? "playbook.selected" : "playbook.switched",
      {
        ...(beforePlaybook === undefined ? {} : { from: beforePlaybook }),
        to: afterPlaybook,
      },
      fallbackCorrelation,
    );
  }

  if (before.snapshot.requirement.revision !== after.snapshot.requirement.revision) {
    events(
      "request.amended",
      { revision: after.snapshot.requirement.revision },
      fallbackCorrelation,
    );
    events(
      "requirement.revised",
      { revision: after.snapshot.requirement.revision },
      fallbackCorrelation,
    );
  }

  emitPlanEvents(before, after, events, fallbackCorrelation);
  emitUncertainties(before, after, events, fallbackCorrelation);
  emitDecisions(before, after, events, fallbackCorrelation);
  emitGates(before, after, events, fallbackCorrelation);
  emitFindings(before, after, events, fallbackCorrelation);
  emitExecutionEvents(input, events, fallbackCorrelation);
  emitOutcomeArtifactEvent(before, after, events, fallbackCorrelation);
  emitRunEvents(input, events, fallbackCorrelation);
  emitRepositoryEvents(before, after, events, fallbackCorrelation);
}

export function createWorkflowEventFactory(
  options: WorkflowEventFactoryOptions = {},
): WorkflowEventFactory {
  const now = options.now ?? (() => new Date());

  return (input): readonly DomainEventDraft[] => {
    const result: DomainEventDraft[] = [];
    let timestampValue: string | undefined;
    const event: EventBuilder = (
      type,
      data,
      correlationId = input.after.run.run_id,
      source = "orchestrator",
      actor = { type: "system" },
    ) => {
      timestampValue ??= timestamp(now);
      result.push({
        schema_version: 1,
        type,
        timestamp: timestampValue,
        run_id: input.after.run.run_id,
        source: { component: source },
        actor,
        state_revision: input.after.run.state_revision,
        correlation_id: correlationId,
        data,
      });
    };

    emitStateEvents(input, event);
    return result;
  };
}
