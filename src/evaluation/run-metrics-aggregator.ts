import type { ArtifactContent } from "../ports/artifact-store.js";
import type { DomainEvent } from "../contracts/events/event.js";
import type { WorkflowState } from "../ports/run-reader.js";

export type RunMetricsArtifact = ArtifactContent | Readonly<Record<string, unknown>>;

export type RunMetricsAggregationInput = Readonly<{
  state: WorkflowState;
  events: readonly DomainEvent[];
  artifacts?: readonly RunMetricsArtifact[];
}>;

type NullableNumber = number | null;
type RecordValue = Record<string, unknown>;

type TelemetryMetrics = Readonly<{
  wall_clock_ms: NullableNumber;
  active_wall_ms: NullableNumber;
  blocked_ms: NullableNumber;
  execution_sum_ms: NullableNumber;
  tool_sum_ms: NullableNumber;
  input_tokens: NullableNumber;
  output_tokens: NullableNumber;
  tokens: NullableNumber;
  cached_input_tokens: NullableNumber;
  reasoning_tokens: NullableNumber;
  cost: NullableNumber;
  tool_calls: NullableNumber;
  pack_tokens_estimated_total: NullableNumber;
  pack_tokens_estimated_peak: NullableNumber;
  trim_count: NullableNumber;
  budget_exceeded_count: NullableNumber;
  required_context_missing_count: NullableNumber;
}>;

type OrchestrationMetrics = Readonly<{
  base_steps_count: number;
  dynamic_steps_count: number;
  skipped_steps_count: number;
  executions_count: number;
  retry_executions_count: number;
  replans_count: number;
  playbook_switches_count: number;
  fix_cycles_count: number;
  reverification_count: number;
  rereview_count: number;
  blocked_count: number;
}>;

type VerificationMetrics = Readonly<{
  runs_count: number;
  invalidations_count: number;
  reverifications_count: number;
  checks: Readonly<{
    passed_count: NullableNumber;
    failed_count: NullableNumber;
    skipped_count: NullableNumber;
    unavailable_count: NullableNumber;
  }>;
  accepted_limitations_count: NullableNumber;
  final: Readonly<{
    result: string | null;
    freshness: string | null;
    strength: string | null;
  }>;
}>;

type ReviewMetrics = Readonly<{
  runs_count: number;
  invalidations_count: number;
  rereviews_count: number;
  findings_created_count: number;
  findings_reopened_count: number;
  findings_by_severity: Readonly<Record<"critical" | "high" | "medium" | "low", number>>;
  final_disposition_counts: Readonly<
    Record<"pending" | "fix-required" | "accepted" | "fixed" | "dismissed", number>
  >;
}>;

export type RunMetrics = Readonly<{
  telemetry: TelemetryMetrics;
  orchestration: OrchestrationMetrics;
  verification: VerificationMetrics;
  review: ReviewMetrics;
}>;

type ExecutionRecord = {
  key: string;
  stepId?: string;
  telemetry?: RecordValue;
};

type ArtifactRecord = {
  type: string;
  status?: string;
  executionId?: string;
  stepId?: string;
  path?: string;
  createdAt?: string;
  stateRevision?: number;
  payload?: RecordValue;
  order: number;
};

const EXECUTION_EVENT_TYPES = new Set([
  "execution.started",
  "execution.completed",
  "execution.blocked",
  "execution.failed",
  "execution.interrupted",
]);
const TELEMETRY_FIELDS = [
  "wall_clock_ms",
  "active_wall_ms",
  "blocked_ms",
  "execution_sum_ms",
  "tool_sum_ms",
  "input_tokens",
  "output_tokens",
  "tokens",
  "cached_input_tokens",
  "reasoning_tokens",
  "cost",
  "tool_calls",
  "pack_tokens_estimated_total",
  "pack_tokens_estimated_peak",
  "trim_count",
  "budget_exceeded_count",
  "required_context_missing_count",
] as const;
const VERIFICATION_CHECK_STATUSES = ["passed", "failed", "skipped", "unavailable"] as const;
const FINDING_SEVERITIES = ["critical", "high", "medium", "low"] as const;
const FINDING_DISPOSITIONS = ["pending", "fix-required", "accepted", "fixed", "dismissed"] as const;
const VERIFICATION_RESULTS = new Set(["passed", "failed", "incomplete"]);
const VERIFICATION_STRENGTHS = new Set(["strong", "partial", "weak", "none"]);
const FRESHNESS_STATUSES = new Set(["fresh", "stale", "unknown"]);
const RECOVERY_OBJECTIVES = new Set(["fix verification failure", "fix blocking finding"]);

function record(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
  const number = nonNegativeNumber(value);
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}

function sortedEvents(events: readonly DomainEvent[]): readonly DomainEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const sequence = left.event.sequence - right.event.sequence;
      if (sequence !== 0) return sequence;
      const eventId = left.event.event_id.localeCompare(right.event.event_id);
      return eventId !== 0 ? eventId : left.index - right.index;
    })
    .map(({ event }) => event);
}

function eventData(event: DomainEvent): RecordValue {
  return record(event.data) ?? {};
}

function eventKey(event: DomainEvent): string {
  return `${event.event_id}:${event.sequence}`;
}

function countEvents(events: readonly DomainEvent[], type: DomainEvent["type"]): number {
  return new Set(events.filter((event) => event.type === type).map(eventKey)).size;
}

function eventExecutionId(event: DomainEvent): string | undefined {
  return text(eventData(event).execution_id);
}

function eventStepId(event: DomainEvent): string | undefined {
  return text(eventData(event).step_id);
}

function executionRecords(
  state: WorkflowState,
  events: readonly DomainEvent[],
): readonly ExecutionRecord[] {
  const records = new Map<string, ExecutionRecord>();
  let anonymous = 0;

  for (const event of events) {
    if (!EXECUTION_EVENT_TYPES.has(event.type)) continue;
    const key = eventExecutionId(event) ?? `event:${eventKey(event)}:${anonymous++}`;
    const current = records.get(key) ?? { key };
    const stepId = current.stepId ?? eventStepId(event);
    const telemetry = record(eventData(event).telemetry);
    records.set(key, {
      ...current,
      ...(stepId === undefined ? {} : { stepId }),
      ...(telemetry === undefined ? {} : { telemetry: { ...current.telemetry, ...telemetry } }),
    });
  }

  for (const step of state.snapshot.steps.steps) {
    const result = record(step.result);
    if (result === undefined) continue;
    const identity = record(result.identity);
    const key = text(identity?.executionId) ?? text(result.execution_id) ?? `step:${step.id}`;
    const telemetry = record(record(result.runtime)?.telemetry) ?? record(result.telemetry);
    const current = records.get(key) ?? { key };
    records.set(key, {
      ...current,
      stepId: current.stepId ?? step.id,
      ...(telemetry === undefined ? {} : { telemetry: { ...current.telemetry, ...telemetry } }),
    });
  }

  return [...records.values()];
}

function metricSum(
  records: readonly ExecutionRecord[],
  field: (typeof TELEMETRY_FIELDS)[number],
): NullableNumber {
  if (records.length === 0) return null;
  let total = 0;
  for (const execution of records) {
    const value = nonNegativeNumber(execution.telemetry?.[field]);
    if (value === undefined) return null;
    total += value;
  }
  return total;
}

function metricMax(
  records: readonly ExecutionRecord[],
  field: (typeof TELEMETRY_FIELDS)[number],
): NullableNumber {
  if (records.length === 0) return null;
  let maximum = 0;
  for (const execution of records) {
    const value = nonNegativeNumber(execution.telemetry?.[field]);
    if (value === undefined) return null;
    maximum = Math.max(maximum, value);
  }
  return maximum;
}

function runWallClock(state: WorkflowState): NullableNumber {
  const timestamps = record(state.run.timestamps);
  if (timestamps === undefined) return null;
  const started = timestamps.started_at ?? timestamps.startedAt ?? timestamps.created_at;
  const ended =
    timestamps.completed_at ??
    timestamps.completedAt ??
    timestamps.finished_at ??
    timestamps.ended_at;
  if (typeof started !== "string" || typeof ended !== "string") return null;
  const elapsed = Date.parse(ended) - Date.parse(started);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function telemetryMetrics(
  state: WorkflowState,
  executions: readonly ExecutionRecord[],
): TelemetryMetrics {
  const wallClock = runWallClock(state);
  return {
    wall_clock_ms: wallClock ?? metricMax(executions, "wall_clock_ms"),
    active_wall_ms: metricSum(executions, "active_wall_ms"),
    blocked_ms: metricSum(executions, "blocked_ms"),
    execution_sum_ms: metricSum(executions, "execution_sum_ms"),
    tool_sum_ms: metricSum(executions, "tool_sum_ms"),
    input_tokens: metricSum(executions, "input_tokens"),
    output_tokens: metricSum(executions, "output_tokens"),
    tokens: metricSum(executions, "tokens"),
    cached_input_tokens: metricSum(executions, "cached_input_tokens"),
    reasoning_tokens: metricSum(executions, "reasoning_tokens"),
    cost: metricSum(executions, "cost"),
    tool_calls: metricSum(executions, "tool_calls"),
    pack_tokens_estimated_total: metricSum(executions, "pack_tokens_estimated_total"),
    pack_tokens_estimated_peak: metricMax(executions, "pack_tokens_estimated_peak"),
    trim_count: metricSum(executions, "trim_count"),
    budget_exceeded_count: metricSum(executions, "budget_exceeded_count"),
    required_context_missing_count: metricSum(executions, "required_context_missing_count"),
  };
}

function counter(state: WorkflowState, ...keys: readonly string[]): number | undefined {
  const counters = record(state.run.counters);
  if (counters === undefined) return undefined;
  for (const key of keys) {
    const value = integer(counters[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function planRevisions(state: WorkflowState, events: readonly DomainEvent[]): number {
  const planEvents = events.filter((event) => event.type === "plan.created");
  const explicit = planEvents.filter(
    (event) => eventData(event).previous_version !== undefined,
  ).length;
  if (explicit > 0) return explicit;
  if (planEvents.length > 1) return planEvents.length - 1;
  const version = integer(record(state.run.current_plan)?.version);
  return version !== undefined && version > 1 ? version - 1 : 0;
}

function fixCycles(state: WorkflowState): number {
  return new Set(
    state.snapshot.steps.steps
      .filter(
        (step) =>
          step.origin === "dynamic" &&
          step.type === "implementation" &&
          (RECOVERY_OBJECTIVES.has(step.objective) ||
            step.trigger === "verification failure" ||
            step.trigger === "review finding"),
      )
      .map((step) => step.id),
  ).size;
}

function countExecutionsByStep(executions: readonly ExecutionRecord[]): number {
  const byStep = new Map<string, number>();
  for (const execution of executions) {
    if (execution.stepId === undefined) continue;
    byStep.set(execution.stepId, (byStep.get(execution.stepId) ?? 0) + 1);
  }
  let retries = 0;
  for (const count of byStep.values()) retries += Math.max(0, count - 1);
  return retries;
}

function artifactFrontMatter(artifact: RunMetricsArtifact): RecordValue {
  const root = record(artifact) ?? {};
  return record(root.frontMatter) ?? root;
}

function parsePayload(value: unknown): RecordValue | undefined {
  const root = record(value);
  if (root !== undefined) {
    const nested = [root.payload, root.data, root.verification_run, root.review_run];
    for (const candidate of nested) {
      const parsed = parsePayload(candidate);
      if (parsed !== undefined) return parsed;
    }
    return root;
  }
  return undefined;
}

function jsonFence(contents: string): readonly RecordValue[] {
  const payloads: RecordValue[] = [];
  const pattern = /```json\s*([\s\S]*?)\s*```/gi;
  for (const match of contents.matchAll(pattern)) {
    if (match[1] === undefined) continue;
    try {
      const payload = parsePayload(JSON.parse(match[1]) as unknown);
      if (payload !== undefined) payloads.push(payload);
    } catch {
      // Artifact content is optional telemetry; invalid payloads remain unavailable.
    }
  }
  return payloads;
}

function artifactPayload(root: RecordValue): RecordValue | undefined {
  for (const candidate of [root.payload, root.data, root.verification_run, root.review_run]) {
    const payload = parsePayload(candidate);
    if (payload !== undefined) return payload;
  }
  for (const contents of [root.body, root.contents]) {
    if (typeof contents !== "string") continue;
    const payload = jsonFence(contents).at(-1);
    if (payload !== undefined) return payload;
  }
  return undefined;
}

function artifactRecord(artifact: RunMetricsArtifact, order: number): ArtifactRecord | undefined {
  const root = record(artifact) ?? {};
  const frontMatter = artifactFrontMatter(artifact);
  const artifactInfo = record(frontMatter.artifact);
  const path = text(root.path) ?? text(record(root.ref)?.path);
  const pathType = path?.split("/")[0];
  const type =
    text(artifactInfo?.type) ??
    text(frontMatter.type) ??
    text(root.type) ??
    text(root.artifact_type) ??
    (pathType === "verification" || pathType === "review" ? pathType : undefined);
  if (type === undefined) return undefined;

  const status = text(artifactInfo?.status) ?? text(frontMatter.status) ?? text(root.status);
  const executionId =
    text(frontMatter.execution_id) ?? text(root.execution_id) ?? text(root.executionId);
  const stepId = text(frontMatter.step_id) ?? text(root.step_id) ?? text(root.stepId);
  const createdAt = text(frontMatter.created_at) ?? text(root.created_at);
  const stateRevision =
    integer(frontMatter.execution_state_revision) ?? integer(root.execution_state_revision);
  const payload = artifactPayload(root);
  return {
    type,
    ...(status === undefined ? {} : { status }),
    ...(executionId === undefined ? {} : { executionId }),
    ...(stepId === undefined ? {} : { stepId }),
    ...(path === undefined ? {} : { path }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(stateRevision === undefined ? {} : { stateRevision }),
    ...(payload === undefined ? {} : { payload }),
    order,
  };
}

function artifactRecords(artifacts: readonly RunMetricsArtifact[]): readonly ArtifactRecord[] {
  const seen = new Set<string>();
  const records: ArtifactRecord[] = [];
  for (const [order, artifact] of artifacts.entries()) {
    const parsed = artifactRecord(artifact, order);
    if (parsed === undefined) continue;
    const identity = `${parsed.type}:${parsed.executionId ?? parsed.path ?? order}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    records.push(parsed);
  }
  return records;
}

function artifactSort(left: ArtifactRecord, right: ArtifactRecord): number {
  const createdAt = (left.createdAt ?? "").localeCompare(right.createdAt ?? "");
  if (createdAt !== 0) return createdAt;
  const revision = (left.stateRevision ?? -1) - (right.stateRevision ?? -1);
  if (revision !== 0) return revision;
  const path = (left.path ?? "").localeCompare(right.path ?? "");
  return path !== 0 ? path : left.order - right.order;
}

function stepResultRecords(
  state: WorkflowState,
  type: "verification" | "review",
): readonly RecordValue[] {
  return state.snapshot.steps.steps
    .filter((step) => step.type === type && step.result !== null)
    .map((step) => record(step.result))
    .filter((result): result is RecordValue => result !== undefined);
}

function resultPayload(result: RecordValue): RecordValue | undefined {
  for (const candidate of [
    result.verification_run,
    result.verificationRun,
    result.review_run,
    result.reviewRun,
  ]) {
    const payload = parsePayload(candidate);
    if (payload !== undefined) return payload;
  }
  return result;
}

function executionIdsFor(
  state: WorkflowState,
  type: "verification" | "review",
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const step of state.snapshot.steps.steps) {
    if (step.type !== type || step.result === null) continue;
    const result = record(step.result);
    const identity = record(result?.identity);
    const id = text(identity?.executionId) ?? text(result?.execution_id);
    ids.add(id ?? `step:${step.id}`);
  }
  return ids;
}

function runCount(
  state: WorkflowState,
  events: readonly DomainEvent[],
  artifacts: readonly ArtifactRecord[],
  type: "verification" | "review",
): number {
  const fromArtifacts = new Set(
    artifacts
      .filter((artifact) => artifact.type === type)
      .map((artifact) => artifact.executionId ?? artifact.path ?? `artifact:${artifact.order}`),
  );
  if (fromArtifacts.size > 0) return fromArtifacts.size;

  const eventType = type === "verification" ? "verification.completed" : "review.completed";
  const fromEvents = new Set(
    events
      .filter((event) => event.type === eventType)
      .map((event) => eventExecutionId(event) ?? eventKey(event)),
  );
  if (fromEvents.size > 0) return fromEvents.size;

  return executionIdsFor(state, type).size;
}

function finalValue(
  payloads: readonly RecordValue[],
  keys: readonly string[],
  allowed?: ReadonlySet<string>,
): string | null {
  for (const payload of [...payloads].reverse()) {
    for (const key of keys) {
      const value = text(payload[key]);
      if (value !== undefined && (allowed === undefined || allowed.has(value))) return value;
    }
  }
  return null;
}

function arraysFrom(
  payloads: readonly RecordValue[],
  key: string,
): readonly (readonly unknown[])[] {
  return payloads.flatMap((payload) => {
    const value = payload[key];
    return Array.isArray(value) ? [value] : [];
  });
}

function verificationMetrics(
  state: WorkflowState,
  events: readonly DomainEvent[],
  artifacts: readonly ArtifactRecord[],
): VerificationMetrics {
  const verificationArtifacts = artifacts.filter((artifact) => artifact.type === "verification");
  const payloads = verificationArtifacts
    .slice()
    .sort(artifactSort)
    .map((artifact) => artifact.payload)
    .filter((payload): payload is RecordValue => payload !== undefined);
  const resultPayloads = stepResultRecords(state, "verification")
    .map(resultPayload)
    .filter((payload): payload is RecordValue => payload !== undefined);
  const allPayloads: readonly RecordValue[] = payloads.length > 0 ? payloads : resultPayloads;
  const checks = arraysFrom(allPayloads, "checks");
  const statuses = checks.flatMap((entries) => entries.map((entry) => record(entry)?.status));
  const checkCounts =
    checks.length === 0
      ? { passed_count: null, failed_count: null, skipped_count: null, unavailable_count: null }
      : Object.fromEntries(
          VERIFICATION_CHECK_STATUSES.map((status) => [
            `${status}_count`,
            statuses.filter((value) => value === status).length,
          ]),
        );
  const limitations = arraysFrom(allPayloads, "limitations");
  const acceptedLimitations = allPayloads.some((payload) => payload.accepted === true)
    ? limitations.reduce((total, values) => total + values.length, 0)
    : limitations.length === 0
      ? null
      : 0;
  const final = {
    result: finalValue(allPayloads, ["result", "verification_result"], VERIFICATION_RESULTS),
    freshness: finalValue(allPayloads, ["freshness"], FRESHNESS_STATUSES),
    strength: finalValue(allPayloads, ["strength"], VERIFICATION_STRENGTHS),
  };
  const runs = runCount(state, events, artifacts, "verification");
  return {
    runs_count: runs,
    invalidations_count: countEvents(events, "verification.invalidated"),
    reverifications_count: Math.max(0, runs - (runs > 0 ? 1 : 0)),
    checks: checkCounts as VerificationMetrics["checks"],
    accepted_limitations_count: acceptedLimitations,
    final,
  };
}

function reviewMetrics(
  state: WorkflowState,
  events: readonly DomainEvent[],
  artifacts: readonly ArtifactRecord[],
): ReviewMetrics {
  const findingsBySeverity = Object.fromEntries(
    FINDING_SEVERITIES.map((severity) => [
      severity,
      state.snapshot.findings.findings.filter((finding) => finding.severity === severity).length,
    ]),
  ) as ReviewMetrics["findings_by_severity"];
  const dispositions = Object.fromEntries(
    FINDING_DISPOSITIONS.map((disposition) => [
      disposition,
      state.snapshot.findings.findings.filter((finding) => finding.disposition === disposition)
        .length,
    ]),
  ) as ReviewMetrics["final_disposition_counts"];
  return {
    runs_count: runCount(state, events, artifacts, "review"),
    invalidations_count: countEvents(events, "review.invalidated"),
    rereviews_count: Math.max(0, runCount(state, events, artifacts, "review") - 1),
    findings_created_count: countEvents(events, "finding.created"),
    findings_reopened_count: countEvents(events, "finding.reopened"),
    findings_by_severity: findingsBySeverity,
    final_disposition_counts: dispositions,
  };
}

function orchestrationMetrics(
  state: WorkflowState,
  events: readonly DomainEvent[],
  executions: readonly ExecutionRecord[],
  verification: VerificationMetrics,
  review: ReviewMetrics,
): OrchestrationMetrics {
  const retries =
    counter(state, "retry_executions_count", "retries", "retry_count") ??
    countExecutionsByStep(executions);
  const replans =
    counter(state, "replans_count", "replans", "replan_count") ?? planRevisions(state, events);
  const fixes =
    counter(state, "fix_cycles_count", "fix_cycles", "fix_cycle_count") ?? fixCycles(state);
  return {
    base_steps_count: state.snapshot.steps.steps.filter((step) => step.origin !== "dynamic").length,
    dynamic_steps_count: state.snapshot.steps.steps.filter((step) => step.origin === "dynamic")
      .length,
    skipped_steps_count: state.snapshot.steps.steps.filter((step) => step.status === "skipped")
      .length,
    executions_count: executions.length,
    retry_executions_count: retries,
    replans_count: replans,
    playbook_switches_count: countEvents(events, "playbook.switched"),
    fix_cycles_count: fixes,
    reverification_count: verification.reverifications_count,
    rereview_count: review.rereviews_count,
    blocked_count: countEvents(events, "run.blocked") || (state.run.status === "blocked" ? 1 : 0),
  };
}

export function aggregateRunMetrics(input: RunMetricsAggregationInput): RunMetrics {
  const events = sortedEvents(input.events);
  const executions = executionRecords(input.state, events);
  const artifacts = artifactRecords(input.artifacts ?? []);
  const verification = verificationMetrics(input.state, events, artifacts);
  const review = reviewMetrics(input.state, events, artifacts);
  return {
    telemetry: telemetryMetrics(input.state, executions),
    orchestration: orchestrationMetrics(input.state, events, executions, verification, review),
    verification,
    review,
  };
}

export class RunMetricsAggregator {
  aggregate(input: RunMetricsAggregationInput): RunMetrics {
    return aggregateRunMetrics(input);
  }
}
