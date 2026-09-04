import {
  ContractValidationError,
  type JsonObject,
  type JsonValue,
  type RuntimeSchema,
  type SafeParseResult,
} from "../execution/agent-execution.js";
import type {
  DecisionId,
  FindingId,
  GateId,
  RunId,
  StepId,
  UncertaintyId,
} from "../../domain/primitives/ids.js";

export const RUN_REQUEST_TYPES = [
  "feature",
  "bug",
  "hotfix",
  "chore",
  "refactor",
  "investigation",
] as const;
export type RunRequestType = (typeof RUN_REQUEST_TYPES)[number];

export const RUN_STATUSES = [
  "created",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const PLAN_APPLICABILITY_STATUSES = [
  "current",
  "compatible",
  "replan-required",
  "unknown",
] as const;
export type PlanApplicabilityStatus = (typeof PLAN_APPLICABILITY_STATUSES)[number];

export const STEP_TYPES = [
  "analysis",
  "research",
  "decision",
  "planning",
  "implementation",
  "verification",
  "review",
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const STEP_STATUSES = [
  "pending",
  "ready",
  "running",
  "blocked",
  "completed",
  "failed",
  "skipped",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const UNCERTAINTY_STATUSES = [
  "open",
  "resolving",
  "resolved",
  "accepted",
  "escalated",
] as const;
export type UncertaintyStatus = (typeof UNCERTAINTY_STATUSES)[number];

export const UNCERTAINTY_CATEGORIES = [
  "requirement",
  "behavior",
  "design",
  "external",
  "impact",
  "verification",
] as const;
export type UncertaintyCategory = (typeof UNCERTAINTY_CATEGORIES)[number];

export const DECISION_CLASSES = ["D1", "D2", "D3"] as const;
export type DecisionClass = (typeof DECISION_CLASSES)[number];

export const DECISION_STATUSES = ["pending", "resolved", "superseded"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const GATE_TYPES = [
  "evidence",
  "uncertainty",
  "decision",
  "verification",
  "approval",
  "completion",
] as const;
export type GateType = (typeof GATE_TYPES)[number];

export const GATE_STATUSES = ["waiting", "passed", "failed", "superseded"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

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

export const STATE_SNAPSHOT_FILES = [
  "requirement.yaml",
  "steps.yaml",
  "uncertainties.yaml",
  "decisions.yaml",
  "gates.yaml",
  "findings.yaml",
] as const;
export type StateSnapshotFile = (typeof STATE_SNAPSHOT_FILES)[number];

export type SnapshotHeaderV1 = Readonly<{
  schema_version: 1;
  run_id: RunId;
  state_revision: number;
}>;

export type PlanApplicabilityV1 = JsonObject &
  Readonly<{
    status: PlanApplicabilityStatus;
  }>;

export type CurrentPlanV1 = JsonObject &
  Readonly<{
    applicability?: PlanApplicabilityV1;
  }>;

export type RunYamlV1 = Readonly<{
  schema_version: 1;
  run_id: RunId;
  request: Readonly<{
    id: string;
    type: RunRequestType;
  }>;
  status: RunStatus;
  finalized: boolean;
  state_revision: number;
  graph_revision: number;
  playbook: Readonly<{
    initial: JsonObject;
    current: JsonObject;
  }>;
  current_step: JsonObject;
  current_plan: CurrentPlanV1 | null;
  current_changes: Readonly<{
    relevant_change_sets: readonly JsonValue[];
    external_reconciliation: JsonObject | null;
  }>;
  repository: JsonObject;
  blocked: JsonObject | null;
  failure: JsonObject | null;
  cancellation: JsonObject | null;
  limits: JsonObject;
  counters: JsonObject;
  telemetry: Readonly<{
    degraded: boolean;
  }>;
  outcome: JsonObject | null;
  timestamps: JsonObject;
}>;

export type RequirementSnapshotV1 = SnapshotHeaderV1 &
  Readonly<{
    revision: number;
    goal: string;
    scope: Readonly<{
      in: readonly JsonValue[];
      out: readonly JsonValue[];
    }>;
    constraints: readonly JsonValue[];
    acceptance_criteria: readonly JsonValue[];
    non_goals: readonly JsonValue[];
    supplied_evidence: readonly JsonValue[];
    assumptions: readonly JsonValue[];
    open_questions: readonly JsonValue[];
  }>;

export type StepStateV1 = JsonObject &
  Readonly<{
    id: StepId;
    type: StepType;
    objective: string;
    agent: string;
    skills: readonly JsonValue[];
    inputs: readonly JsonValue[];
    outputs: readonly JsonValue[];
    depends_on: readonly JsonValue[];
    completion_criteria: readonly JsonValue[];
    status: StepStatus;
    blocked_by: readonly JsonValue[];
    result: JsonObject | null;
  }>;

export type StepsSnapshotV1 = SnapshotHeaderV1 &
  Readonly<{
    graph_revision: number;
    steps: readonly StepStateV1[];
  }>;

export type UncertaintyStateV1 = JsonObject &
  Readonly<{
    id: UncertaintyId;
    status: UncertaintyStatus;
    category: UncertaintyCategory;
    question?: string;
    basis?: JsonValue;
    impact?: string;
    created_by?: JsonObject;
    created_at?: string;
    resolution_attempts?: readonly JsonValue[];
    resolution?: JsonObject;
  }>;

export type UncertaintiesSnapshotV1 = SnapshotHeaderV1 &
  Readonly<{
    uncertainties: readonly UncertaintyStateV1[];
  }>;

export type DecisionStateV1 = JsonObject &
  Readonly<{
    id: DecisionId;
    class: DecisionClass;
    status: DecisionStatus;
  }>;

export type DecisionsSnapshotV1 = SnapshotHeaderV1 &
  Readonly<{
    decisions: readonly DecisionStateV1[];
  }>;

export type GateStateV1 = JsonObject &
  Readonly<{
    id: GateId;
    type: GateType;
    status: GateStatus;
  }>;

export type GatesSnapshotV1 = SnapshotHeaderV1 &
  Readonly<{
    gates: readonly GateStateV1[];
  }>;

export type FindingStateV1 = JsonObject &
  Readonly<{
    id: FindingId;
    state: FindingState;
    disposition: FindingDisposition;
    severity: FindingSeverity;
    confidence: FindingConfidence;
  }>;

export type FindingsSnapshotV1 = SnapshotHeaderV1 &
  Readonly<{
    findings: readonly FindingStateV1[];
  }>;

export type SnapshotManifestV1 = SnapshotHeaderV1 &
  Readonly<{
    previous_state_revision: number;
    created_at: string;
    files: readonly StateSnapshotFile[];
  }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(contract: string, path: string, expected: string): never {
  throw new ContractValidationError(contract, { path, expected });
}

function record(input: unknown, contract: string, path: string): Record<string, unknown> {
  if (!isRecord(input)) {
    fail(contract, path, "an object");
  }
  return input;
}

function stringValue(input: unknown, contract: string, path: string): string {
  if (typeof input !== "string") {
    fail(contract, path, "a string");
  }
  return input;
}

function nonEmptyString(input: unknown, contract: string, path: string): string {
  const value = stringValue(input, contract, path);
  if (value.trim().length === 0) {
    fail(contract, path, "a non-empty string");
  }
  return value;
}

function finiteNumber(input: unknown, contract: string, path: string): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    fail(contract, path, "a finite number");
  }
  return input;
}

function safeIntegerAtLeast(
  input: unknown,
  contract: string,
  path: string,
  minimum: number,
): number {
  const value = finiteNumber(input, contract, path);
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(contract, path, `a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function booleanValue(input: unknown, contract: string, path: string): boolean {
  if (typeof input !== "boolean") {
    fail(contract, path, "a boolean");
  }
  return input;
}

function arrayValue(input: unknown, contract: string, path: string): readonly unknown[] {
  if (!Array.isArray(input)) {
    fail(contract, path, "an array");
  }
  return input;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function jsonValue(input: unknown, contract: string, path: string): JsonValue {
  if (!isJsonValue(input)) {
    fail(contract, path, "a JSON value");
  }
  return input;
}

function jsonObject(input: unknown, contract: string, path: string): JsonObject {
  const value = record(input, contract, path);
  for (const [key, entry] of Object.entries(value)) {
    jsonValue(entry, contract, `${path}.${key}`);
  }
  return value as JsonObject;
}

function jsonArray(input: unknown, contract: string, path: string): readonly JsonValue[] {
  const value = arrayValue(input, contract, path);
  return value.map((entry, index) => jsonValue(entry, contract, `${path}[${index}]`));
}

function nullableObject(input: unknown, contract: string, path: string): JsonObject | null {
  return input === null ? null : jsonObject(input, contract, path);
}

function enumValue<T extends readonly string[]>(
  input: unknown,
  contract: string,
  path: string,
  values: T,
): T[number] {
  const value = stringValue(input, contract, path);
  if (!(values as readonly string[]).includes(value)) {
    fail(contract, path, `one of ${values.join(", ")}`);
  }
  return value as T[number];
}

function domainId(input: unknown, contract: string, path: string, prefix: string): string {
  const value = nonEmptyString(input, contract, path);
  if (!new RegExp(`^${prefix}-\\d+$`).test(value)) {
    fail(contract, path, `${prefix}-<number> identity`);
  }
  return value;
}

function schemaVersion(input: unknown, contract: string, path: string): void {
  if (input !== 1) {
    fail(contract, path, "schema version 1");
  }
}

function snapshotHeader(
  root: Record<string, unknown>,
  contract: string,
  includeGraphRevision = false,
): void {
  schemaVersion(root.schema_version, contract, "schema_version");
  domainId(root.run_id, contract, "run_id", "run");
  safeIntegerAtLeast(root.state_revision, contract, "state_revision", 0);
  if (includeGraphRevision) {
    safeIntegerAtLeast(root.graph_revision, contract, "graph_revision", 0);
  }
}

function runYamlCurrentPlan(input: unknown): CurrentPlanV1 | null {
  const contract = "RunYamlV1";
  if (input === null) {
    return null;
  }

  const value = jsonObject(input, contract, "current_plan");
  if (value.applicability !== undefined) {
    const applicability = jsonObject(value.applicability, contract, "current_plan.applicability");
    enumValue(
      applicability.status,
      contract,
      "current_plan.applicability.status",
      PLAN_APPLICABILITY_STATUSES,
    );
  }
  return value as CurrentPlanV1;
}

export function parseRunYamlV1(input: unknown): RunYamlV1 {
  const contract = "RunYamlV1";
  const root = record(input, contract, "");
  schemaVersion(root.schema_version, contract, "schema_version");
  domainId(root.run_id, contract, "run_id", "run");

  const request = record(root.request, contract, "request");
  nonEmptyString(request.id, contract, "request.id");
  enumValue(request.type, contract, "request.type", RUN_REQUEST_TYPES);

  const status = enumValue(root.status, contract, "status", RUN_STATUSES);
  const finalized = booleanValue(root.finalized, contract, "finalized");
  safeIntegerAtLeast(root.state_revision, contract, "state_revision", 0);
  safeIntegerAtLeast(root.graph_revision, contract, "graph_revision", 0);

  const playbook = record(root.playbook, contract, "playbook");
  jsonObject(playbook.initial, contract, "playbook.initial");
  jsonObject(playbook.current, contract, "playbook.current");
  jsonObject(root.current_step, contract, "current_step");
  runYamlCurrentPlan(root.current_plan);

  const currentChanges = record(root.current_changes, contract, "current_changes");
  jsonArray(currentChanges.relevant_change_sets, contract, "current_changes.relevant_change_sets");
  nullableObject(
    currentChanges.external_reconciliation,
    contract,
    "current_changes.external_reconciliation",
  );

  jsonObject(root.repository, contract, "repository");
  nullableObject(root.blocked, contract, "blocked");
  const failure = nullableObject(root.failure, contract, "failure");
  nullableObject(root.cancellation, contract, "cancellation");
  jsonObject(root.limits, contract, "limits");
  jsonObject(root.counters, contract, "counters");

  const telemetry = record(root.telemetry, contract, "telemetry");
  booleanValue(telemetry.degraded, contract, "telemetry.degraded");
  const outcome = nullableObject(root.outcome, contract, "outcome");
  jsonObject(root.timestamps, contract, "timestamps");

  if (status === "failed") {
    if (failure === null) {
      fail(contract, "failure", "a Failure Record pointer");
    }
    if (typeof failure.resumable !== "boolean") {
      fail(contract, "failure.resumable", "a boolean");
    }
    if (failure.resumable === finalized) {
      fail(contract, "failure.resumable", "true only for a non-finalized failed Run");
    }
    if (finalized && outcome === null) {
      fail(contract, "outcome", "an Outcome for a finalized failed Run");
    }
    if (!finalized && outcome !== null) {
      fail(contract, "outcome", "null for a resumable failed Run");
    }
  }

  if (["created", "running", "blocked"].includes(status) && finalized) {
    fail(contract, "finalized", "false for a non-terminal Run status");
  }
  if (["completed", "cancelled"].includes(status) && !finalized) {
    fail(contract, "finalized", "true for a terminal Run status");
  }

  return input as RunYamlV1;
}

function parseSnapshotHeader(
  input: unknown,
  contract: string,
  includeGraphRevision = false,
): Record<string, unknown> {
  const root = record(input, contract, "");
  snapshotHeader(root, contract, includeGraphRevision);
  return root;
}

export function parseRequirementSnapshotV1(input: unknown): RequirementSnapshotV1 {
  const contract = "RequirementSnapshotV1";
  const root = parseSnapshotHeader(input, contract);
  safeIntegerAtLeast(root.revision, contract, "revision", 1);
  nonEmptyString(root.goal, contract, "goal");

  const scope = record(root.scope, contract, "scope");
  jsonArray(scope.in, contract, "scope.in");
  jsonArray(scope.out, contract, "scope.out");
  for (const name of [
    "constraints",
    "acceptance_criteria",
    "non_goals",
    "supplied_evidence",
    "assumptions",
    "open_questions",
  ] as const) {
    jsonArray(root[name], contract, name);
  }
  return input as RequirementSnapshotV1;
}

function stepState(input: unknown, path: string): StepStateV1 {
  const contract = "StepsSnapshotV1";
  const value = jsonObject(input, contract, path);
  domainId(value.id, contract, `${path}.id`, "step");
  enumValue(value.type, contract, `${path}.type`, STEP_TYPES);
  nonEmptyString(value.objective, contract, `${path}.objective`);
  nonEmptyString(value.agent, contract, `${path}.agent`);
  for (const name of [
    "skills",
    "inputs",
    "outputs",
    "depends_on",
    "completion_criteria",
    "blocked_by",
  ] as const) {
    jsonArray(value[name], contract, `${path}.${name}`);
  }
  enumValue(value.status, contract, `${path}.status`, STEP_STATUSES);
  nullableObject(value.result, contract, `${path}.result`);
  return value as StepStateV1;
}

export function parseStepsSnapshotV1(input: unknown): StepsSnapshotV1 {
  const contract = "StepsSnapshotV1";
  const root = parseSnapshotHeader(input, contract, true);
  const steps = arrayValue(root.steps, contract, "steps");
  steps.forEach((step, index) => stepState(step, `steps[${index}]`));
  return input as StepsSnapshotV1;
}

function uncertaintyState(input: unknown, path: string): UncertaintyStateV1 {
  const contract = "UncertaintiesSnapshotV1";
  const value = jsonObject(input, contract, path);
  domainId(value.id, contract, `${path}.id`, "U");
  enumValue(value.status, contract, `${path}.status`, UNCERTAINTY_STATUSES);
  enumValue(value.category, contract, `${path}.category`, UNCERTAINTY_CATEGORIES);
  if (value.question !== undefined) nonEmptyString(value.question, contract, `${path}.question`);
  if (value.impact !== undefined) nonEmptyString(value.impact, contract, `${path}.impact`);
  if (value.basis !== undefined) jsonValue(value.basis, contract, `${path}.basis`);
  if (value.created_by !== undefined) jsonObject(value.created_by, contract, `${path}.created_by`);
  if (value.created_at !== undefined)
    nonEmptyString(value.created_at, contract, `${path}.created_at`);
  if (value.resolution_attempts !== undefined) {
    jsonArray(value.resolution_attempts, contract, `${path}.resolution_attempts`);
  }
  if (value.resolution !== undefined) jsonObject(value.resolution, contract, `${path}.resolution`);
  return value as UncertaintyStateV1;
}

export function parseUncertaintiesSnapshotV1(input: unknown): UncertaintiesSnapshotV1 {
  const contract = "UncertaintiesSnapshotV1";
  const root = parseSnapshotHeader(input, contract);
  const uncertainties = arrayValue(root.uncertainties, contract, "uncertainties");
  uncertainties.forEach((entry, index) => uncertaintyState(entry, `uncertainties[${index}]`));
  return input as UncertaintiesSnapshotV1;
}

function decisionState(input: unknown, path: string): DecisionStateV1 {
  const contract = "DecisionsSnapshotV1";
  const value = jsonObject(input, contract, path);
  domainId(value.id, contract, `${path}.id`, "D");
  enumValue(value.class, contract, `${path}.class`, DECISION_CLASSES);
  enumValue(value.status, contract, `${path}.status`, DECISION_STATUSES);
  return value as DecisionStateV1;
}

export function parseDecisionsSnapshotV1(input: unknown): DecisionsSnapshotV1 {
  const contract = "DecisionsSnapshotV1";
  const root = parseSnapshotHeader(input, contract);
  const decisions = arrayValue(root.decisions, contract, "decisions");
  decisions.forEach((entry, index) => decisionState(entry, `decisions[${index}]`));
  return input as DecisionsSnapshotV1;
}

function gateState(input: unknown, path: string): GateStateV1 {
  const contract = "GatesSnapshotV1";
  const value = jsonObject(input, contract, path);
  domainId(value.id, contract, `${path}.id`, "G");
  enumValue(value.type, contract, `${path}.type`, GATE_TYPES);
  enumValue(value.status, contract, `${path}.status`, GATE_STATUSES);
  return value as GateStateV1;
}

export function parseGatesSnapshotV1(input: unknown): GatesSnapshotV1 {
  const contract = "GatesSnapshotV1";
  const root = parseSnapshotHeader(input, contract);
  const gates = arrayValue(root.gates, contract, "gates");
  gates.forEach((entry, index) => gateState(entry, `gates[${index}]`));
  return input as GatesSnapshotV1;
}

function findingState(input: unknown, path: string): FindingStateV1 {
  const contract = "FindingsSnapshotV1";
  const value = jsonObject(input, contract, path);
  const state = enumValue(value.state, contract, `${path}.state`, FINDING_STATES);
  const disposition = enumValue(
    value.disposition,
    contract,
    `${path}.disposition`,
    FINDING_DISPOSITIONS,
  );
  enumValue(value.severity, contract, `${path}.severity`, FINDING_SEVERITIES);
  enumValue(value.confidence, contract, `${path}.confidence`, FINDING_CONFIDENCES);

  const validDisposition =
    state === "open" ? ["pending", "fix-required", "accepted"] : ["fixed", "dismissed"];
  if (!validDisposition.includes(disposition)) {
    fail(contract, `${path}.disposition`, `a valid disposition for ${state} findings`);
  }
  domainId(value.id, contract, `${path}.id`, "F");
  return value as FindingStateV1;
}

export function parseFindingsSnapshotV1(input: unknown): FindingsSnapshotV1 {
  const contract = "FindingsSnapshotV1";
  const root = parseSnapshotHeader(input, contract);
  const findings = arrayValue(root.findings, contract, "findings");
  findings.forEach((entry, index) => findingState(entry, `findings[${index}]`));
  return input as FindingsSnapshotV1;
}

export function parseSnapshotManifestV1(input: unknown): SnapshotManifestV1 {
  const contract = "SnapshotManifestV1";
  const root = parseSnapshotHeader(input, contract);
  safeIntegerAtLeast(root.previous_state_revision, contract, "previous_state_revision", 0);
  nonEmptyString(root.created_at, contract, "created_at");
  const files = arrayValue(root.files, contract, "files").map((file, index) =>
    nonEmptyString(file, contract, `files[${index}]`),
  );
  if (
    files.length !== STATE_SNAPSHOT_FILES.length ||
    new Set(files).size !== STATE_SNAPSHOT_FILES.length ||
    files.some((file) => !(STATE_SNAPSHOT_FILES as readonly string[]).includes(file))
  ) {
    fail(contract, "files", `the six canonical files ${STATE_SNAPSHOT_FILES.join(", ")}`);
  }
  return input as SnapshotManifestV1;
}

function createRuntimeSchema<T>(parser: (input: unknown) => T): RuntimeSchema<T> {
  return {
    parse: parser,
    safeParse(input: unknown): SafeParseResult<T> {
      try {
        return { success: true, data: parser(input) };
      } catch (error) {
        if (error instanceof ContractValidationError) {
          return { success: false, error };
        }
        throw error;
      }
    },
  };
}

export const RunYamlV1Schema = createRuntimeSchema(parseRunYamlV1);
export const RequirementSnapshotV1Schema = createRuntimeSchema(parseRequirementSnapshotV1);
export const StepsSnapshotV1Schema = createRuntimeSchema(parseStepsSnapshotV1);
export const UncertaintiesSnapshotV1Schema = createRuntimeSchema(parseUncertaintiesSnapshotV1);
export const DecisionsSnapshotV1Schema = createRuntimeSchema(parseDecisionsSnapshotV1);
export const GatesSnapshotV1Schema = createRuntimeSchema(parseGatesSnapshotV1);
export const FindingsSnapshotV1Schema = createRuntimeSchema(parseFindingsSnapshotV1);
export const SnapshotManifestV1Schema = createRuntimeSchema(parseSnapshotManifestV1);

export const runYamlV1Schema = RunYamlV1Schema;
export const requirementSnapshotV1Schema = RequirementSnapshotV1Schema;
export const stepsSnapshotV1Schema = StepsSnapshotV1Schema;
export const uncertaintiesSnapshotV1Schema = UncertaintiesSnapshotV1Schema;
export const decisionsSnapshotV1Schema = DecisionsSnapshotV1Schema;
export const gatesSnapshotV1Schema = GatesSnapshotV1Schema;
export const findingsSnapshotV1Schema = FindingsSnapshotV1Schema;
export const snapshotManifestV1Schema = SnapshotManifestV1Schema;
