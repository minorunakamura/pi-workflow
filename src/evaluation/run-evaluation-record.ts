import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "../contracts/execution/agent-execution.js";
import type { DomainEvent } from "../contracts/events/event.js";
import type { RunId } from "../domain/primitives/ids.js";
import {
  aggregateRunMetrics,
  type RunMetrics,
  type RunMetricsAggregationInput,
} from "./run-metrics-aggregator.js";
import {
  DEFAULT_TELEMETRY_LEVEL,
  TELEMETRY_LEVELS,
  type TelemetryLevel,
} from "../telemetry/runtime-metrics.js";
import { redactSecrets } from "../telemetry/redaction.js";

export const EVALUATION_SCHEMA_VERSION = 1 as const;
export const DEFAULT_EVALUATOR_VERSION = 1;
export const EVALUATION_STATUSES = ["provisional", "final"] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

export const TELEMETRY_QUALITY_STATUSES = ["healthy", "degraded"] as const;
export type TelemetryQualityStatus = (typeof TELEMETRY_QUALITY_STATUSES)[number];

export const EVALUATION_DIMENSIONS = [
  "correctness",
  "efficiency",
  "context-efficiency",
  "decision-quality",
  "review-quality",
  "orchestration-quality",
] as const;
export type EvaluationDimension = (typeof EVALUATION_DIMENSIONS)[number];

type TelemetryQuality = Readonly<{
  status: TelemetryQualityStatus;
  telemetry_level: TelemetryLevel;
}>;

type EvaluationSource = Readonly<{
  state_revision: number;
  last_event_sequence: number;
  finalized: boolean;
}>;

type ContextTelemetry = Pick<
  RunMetrics["telemetry"],
  | "input_tokens"
  | "output_tokens"
  | "tokens"
  | "cached_input_tokens"
  | "reasoning_tokens"
  | "pack_tokens_estimated_total"
  | "pack_tokens_estimated_peak"
  | "trim_count"
  | "budget_exceeded_count"
  | "required_context_missing_count"
>;

type DecisionEvidence = Readonly<{
  created_count: number;
  resolved_count: number;
  superseded_count: number;
  replans_count: number;
}>;

export type RunEvaluationDimensions = Readonly<{
  correctness: Readonly<{
    requirement: Readonly<{
      acceptance_criteria: readonly JsonValue[];
      constraints: readonly JsonValue[];
    }>;
    outcome: JsonObject | null;
    verification: RunMetrics["verification"];
    review: RunMetrics["review"];
  }>;
  efficiency: Readonly<{
    telemetry: RunMetrics["telemetry"];
    orchestration: RunMetrics["orchestration"];
  }>;
  "context-efficiency": Readonly<{
    telemetry: ContextTelemetry;
  }>;
  "decision-quality": DecisionEvidence;
  "review-quality": Readonly<{
    review: RunMetrics["review"];
  }>;
  "orchestration-quality": Readonly<{
    orchestration: RunMetrics["orchestration"];
  }>;
}>;

export type RunEvaluationComparisonInput = Readonly<{
  repositoryBaseline?: JsonValue;
  workflowVersion?: JsonValue;
  effectiveConfig?: JsonValue;
  modelProviderUsage?: readonly JsonValue[];
  agentVersions?: readonly JsonValue[];
  skillVersions?: readonly JsonValue[];
  comparisonGroup?: string;
  variant?: string;
}>;

export type RunEvaluationComparison = Readonly<{
  request_id: string;
  request_type: string;
  repository_baseline?: JsonValue;
  workflow_version?: JsonValue;
  initial_playbook_version?: JsonValue;
  final_playbook_version?: JsonValue;
  effective_config_fingerprint?: string;
  model_provider_usage?: readonly JsonValue[];
  agent_versions?: readonly JsonValue[];
  skill_versions?: readonly JsonValue[];
  final_requirement_revision: number;
  telemetry_level: TelemetryLevel;
  telemetry_quality: TelemetryQualityStatus;
  comparison_group?: string;
  variant?: string;
}>;

export type RunEvaluationRecordInput = RunMetricsAggregationInput &
  Readonly<{
    evaluatorVersion?: number;
    comparison?: RunEvaluationComparisonInput;
  }>;

export type RunEvaluationRecord = Readonly<{
  evaluation_schema_version: typeof EVALUATION_SCHEMA_VERSION;
  evaluator_version: number;
  run_id: RunId;
  evaluation_status: EvaluationStatus;
  source: EvaluationSource;
  telemetry_quality: TelemetryQuality;
  comparison: RunEvaluationComparison;
  dimensions: RunEvaluationDimensions;
  metrics: RunMetrics;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function property(
  value: JsonObject | null | undefined,
  keys: readonly string[],
): JsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function eventTelemetryLevel(event: DomainEvent): unknown {
  const telemetry = event.data.telemetry;
  return isRecord(telemetry) ? telemetry.telemetry_level : undefined;
}

function resultTelemetryLevel(result: JsonObject | null): unknown {
  if (result === null) return undefined;
  const runtime = result.runtime;
  if (!isRecord(runtime)) return undefined;
  const telemetry = runtime.telemetry;
  return isRecord(telemetry) ? telemetry.telemetry_level : undefined;
}

function telemetryQuality(input: RunEvaluationRecordInput): TelemetryQuality {
  const levels: TelemetryLevel[] = [];
  let unsupported = false;
  const addLevel = (value: unknown): void => {
    if (value === undefined) return;
    if ((TELEMETRY_LEVELS as readonly unknown[]).includes(value)) {
      levels.push(value as TelemetryLevel);
    } else {
      unsupported = true;
    }
  };

  for (const event of input.events) addLevel(eventTelemetryLevel(event));
  for (const step of input.state.snapshot.steps.steps) addLevel(resultTelemetryLevel(step.result));

  const order = new Map<TelemetryLevel, number>([
    ["minimal", 0],
    ["standard", 1],
    ["debug", 2],
  ]);
  const telemetryLevel = levels.reduce(
    (lowest, current) => (order.get(current)! < order.get(lowest)! ? current : lowest),
    DEFAULT_TELEMETRY_LEVEL,
  );

  return {
    status: input.state.run.telemetry.degraded || unsupported ? "degraded" : "healthy",
    telemetry_level: telemetryLevel,
  };
}

function lastEventSequence(events: readonly DomainEvent[]): number {
  return events.reduce((last, event) => Math.max(last, event.sequence), 0);
}

function isSecretKey(key: string): boolean {
  const probe = `${key}: value`;
  return redactSecrets(probe) !== probe;
}

function canonicalJson(value: JsonValue, secret = false): string {
  if (secret) return JSON.stringify("[REDACTED_SECRET]");
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(redactSecrets(value));
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;

  const entries = Object.entries(value)
    .map(([key, entry]) => ({ key: redactSecrets(key), entry, secret: isSecretKey(key) }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return `{${entries
    .map(
      ({ key, entry, secret: secretValue }) =>
        `${JSON.stringify(key)}:${canonicalJson(entry, secretValue)}`,
    )
    .join(",")}}`;
}

function configFingerprint(config: JsonValue): string {
  return createHash("sha256").update(canonicalJson(config), "utf8").digest("hex");
}

function sortedJsonValues(values: readonly JsonValue[]): readonly JsonValue[] {
  return [...values].sort((left, right) => {
    const leftJson = canonicalJson(left);
    const rightJson = canonicalJson(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });
}

function dimensions(input: RunEvaluationRecordInput, metrics: RunMetrics): RunEvaluationDimensions {
  const countDecisionEvents = (type: DomainEvent["type"]): number =>
    input.events.filter((event) => event.type === type).length;

  return {
    correctness: {
      requirement: {
        acceptance_criteria: input.state.snapshot.requirement.acceptance_criteria,
        constraints: input.state.snapshot.requirement.constraints,
      },
      outcome: input.state.run.outcome,
      verification: metrics.verification,
      review: metrics.review,
    },
    efficiency: {
      telemetry: metrics.telemetry,
      orchestration: metrics.orchestration,
    },
    "context-efficiency": {
      telemetry: {
        input_tokens: metrics.telemetry.input_tokens,
        output_tokens: metrics.telemetry.output_tokens,
        tokens: metrics.telemetry.tokens,
        cached_input_tokens: metrics.telemetry.cached_input_tokens,
        reasoning_tokens: metrics.telemetry.reasoning_tokens,
        pack_tokens_estimated_total: metrics.telemetry.pack_tokens_estimated_total,
        pack_tokens_estimated_peak: metrics.telemetry.pack_tokens_estimated_peak,
        trim_count: metrics.telemetry.trim_count,
        budget_exceeded_count: metrics.telemetry.budget_exceeded_count,
        required_context_missing_count: metrics.telemetry.required_context_missing_count,
      },
    },
    "decision-quality": {
      created_count: countDecisionEvents("decision.created"),
      resolved_count: countDecisionEvents("decision.resolved"),
      superseded_count: countDecisionEvents("decision.superseded"),
      replans_count: metrics.orchestration.replans_count,
    },
    "review-quality": {
      review: metrics.review,
    },
    "orchestration-quality": {
      orchestration: metrics.orchestration,
    },
  };
}

function comparison(
  input: RunEvaluationRecordInput,
  quality: TelemetryQuality,
): RunEvaluationComparison {
  const state = input.state;
  const provided = input.comparison;
  const repositoryBaseline =
    provided?.repositoryBaseline ??
    property(state.run.repository, ["baseline", "baseline_id", "commit", "commit_sha", "sha"]);
  const workflowVersion =
    provided?.workflowVersion ??
    property(state.run.playbook.current, ["workflow_version", "workflowVersion"]);
  const initialPlaybookVersion = property(state.run.playbook.initial, ["version"]);
  const finalPlaybookVersion = property(state.run.playbook.current, ["version"]);
  const comparisonRecord: RunEvaluationComparison = {
    request_id: state.run.request.id,
    request_type: state.run.request.type,
    ...(repositoryBaseline === undefined ? {} : { repository_baseline: repositoryBaseline }),
    ...(workflowVersion === undefined ? {} : { workflow_version: workflowVersion }),
    ...(initialPlaybookVersion === undefined
      ? {}
      : { initial_playbook_version: initialPlaybookVersion }),
    ...(finalPlaybookVersion === undefined ? {} : { final_playbook_version: finalPlaybookVersion }),
    ...(provided?.effectiveConfig === undefined
      ? {}
      : { effective_config_fingerprint: configFingerprint(provided.effectiveConfig) }),
    ...(provided?.modelProviderUsage === undefined
      ? {}
      : { model_provider_usage: sortedJsonValues(provided.modelProviderUsage) }),
    ...(provided?.agentVersions === undefined
      ? {}
      : { agent_versions: sortedJsonValues(provided.agentVersions) }),
    ...(provided?.skillVersions === undefined
      ? {}
      : { skill_versions: sortedJsonValues(provided.skillVersions) }),
    final_requirement_revision: state.snapshot.requirement.revision,
    telemetry_level: quality.telemetry_level,
    telemetry_quality: quality.status,
    ...(provided?.comparisonGroup === undefined
      ? {}
      : { comparison_group: provided.comparisonGroup }),
    ...(provided?.variant === undefined ? {} : { variant: provided.variant }),
  };
  return comparisonRecord;
}

function version(value: number | undefined): number {
  const resolved = value ?? DEFAULT_EVALUATOR_VERSION;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError("evaluatorVersion must be a positive safe integer");
  }
  return resolved;
}

export function buildRunEvaluationRecord(input: RunEvaluationRecordInput): RunEvaluationRecord {
  const evaluatorVersion = version(input.evaluatorVersion);
  const metrics = aggregateRunMetrics(input);
  const quality = telemetryQuality(input);

  return {
    evaluation_schema_version: EVALUATION_SCHEMA_VERSION,
    evaluator_version: evaluatorVersion,
    run_id: input.state.run.run_id,
    evaluation_status: input.state.run.finalized ? "final" : "provisional",
    source: {
      state_revision: input.state.run.state_revision,
      last_event_sequence: lastEventSequence(input.events),
      finalized: input.state.run.finalized,
    },
    telemetry_quality: quality,
    comparison: comparison(input, quality),
    dimensions: dimensions(input, metrics),
    metrics,
  };
}

export const createRunEvaluationRecord = buildRunEvaluationRecord;

export class RunEvaluationRecordEvaluator {
  constructor(private readonly evaluatorVersion = DEFAULT_EVALUATOR_VERSION) {}

  evaluate(input: Omit<RunEvaluationRecordInput, "evaluatorVersion">): RunEvaluationRecord {
    return buildRunEvaluationRecord({ ...input, evaluatorVersion: this.evaluatorVersion });
  }
}
