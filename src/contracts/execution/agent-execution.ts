import type { ExecutionId, RunId, StepId } from "../../domain/primitives/ids.js";

export const AGENT_EXECUTION_MODES = ["read-only", "write", "verify-only"] as const;
export type AgentExecutionMode = (typeof AGENT_EXECUTION_MODES)[number];

export const AGENT_OUTCOMES = ["completed", "blocked", "failed"] as const;
export type AgentOutcome = (typeof AGENT_OUTCOMES)[number];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

export type SkillReference = Readonly<{
  id: string;
  version: string;
}>;

export type AgentExecutionIdentity = Readonly<{
  runId: RunId;
  stepId: StepId;
  executionId: ExecutionId;
  agentId: string;
  agentVersion: string;
}>;

export type AgentExecutionRequestV1 = Readonly<{
  identity: AgentExecutionIdentity;
  objective: Readonly<{
    objective: string;
    type: string;
    completionCriteria: readonly string[];
  }>;
  retry: Readonly<{
    attempt: number;
    context: JsonValue;
  }>;
  execution: Readonly<{
    mode: AgentExecutionMode;
    timeoutMs: number;
    cancellationPolicy: JsonValue;
  }>;
  authority: Readonly<{
    maximumDLevel: string;
    escalationRules: readonly JsonValue[];
  }>;
  permissions: Readonly<{
    filesystem: readonly JsonValue[];
    shell: readonly JsonValue[];
    git: readonly JsonValue[];
    network: readonly JsonValue[];
    repositoryTargets: readonly JsonValue[];
  }>;
  skills: Readonly<{
    required: readonly SkillReference[];
    optional: readonly SkillReference[];
  }>;
  tools: Readonly<{
    resolved: readonly JsonValue[];
    policy: JsonValue;
  }>;
  model: Readonly<{
    requested: JsonValue;
    actual: JsonValue;
    thinkingLevel: string;
    allowedFallback: readonly JsonValue[];
  }>;
  context: Readonly<{
    pack: JsonObject;
    manifest: JsonObject;
    artifactRefs: readonly string[];
  }>;
  outputs: Readonly<{
    expectedArtifactTypes: readonly string[];
    outputContract: JsonValue;
  }>;
}>;

export type StepResultIdentity = Readonly<{
  runId: RunId;
  stepId: StepId;
  executionId: ExecutionId;
}>;

export type ResultCandidate = JsonObject;

export type StepResultV1 = Readonly<{
  identity: StepResultIdentity;
  outcome: AgentOutcome;
  mode?: AgentExecutionMode;
  summary: string;
  artifacts: readonly JsonValue[];
  uncertainty_candidates: readonly ResultCandidate[];
  decision_requests: readonly ResultCandidate[];
  requirement_candidates: Readonly<{
    acceptance_criteria: readonly ResultCandidate[];
    constraints: readonly ResultCandidate[];
    assumptions: readonly ResultCandidate[];
  }>;
  finding_candidates: readonly ResultCandidate[];
  finding_rechecks: readonly ResultCandidate[];
  plan_deviations: readonly ResultCandidate[];
  skill_requests: readonly ResultCandidate[];
  execution_checks: readonly ResultCandidate[];
  observations: readonly ResultCandidate[];
  blocked: JsonObject | null;
  failure: JsonObject | null;
  runtime: JsonObject;
}>;

export type ContractIssue = Readonly<{
  path: string;
  expected: string;
}>;

export class ContractValidationError extends Error {
  readonly contract: string;
  readonly issues: readonly ContractIssue[];

  constructor(contract: string, issue: ContractIssue) {
    super(`${contract} validation failed at ${issue.path || "<root>"}: expected ${issue.expected}`);
    this.name = "ContractValidationError";
    this.contract = contract;
    this.issues = [issue];
  }
}

export type SafeParseResult<T> =
  | Readonly<{ success: true; data: T }>
  | Readonly<{ success: false; error: ContractValidationError }>;

export interface RuntimeSchema<T> {
  parse(input: unknown): T;
  safeParse(input: unknown): SafeParseResult<T>;
}

const REQUEST_CONTRACT = "AgentExecutionRequestV1";
const RESULT_CONTRACT = "StepResultV1";
const AUTHORITATIVE_STATE_ID = /^(?:run|step|exec)-\d+$|^(?:U|D|G|F|P|V|PD|CS|VR|RR)-\d+$/;

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

function numberValue(input: unknown, contract: string, path: string): number {
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
  const value = numberValue(input, contract, path);
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(contract, path, `a safe integer greater than or equal to ${minimum}`);
  }
  return value;
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
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function jsonValue(input: unknown, contract: string, path: string): JsonValue {
  if (!isJsonValue(input)) {
    fail(contract, path, "a JSON value");
  }
  return input;
}

function jsonObject(input: unknown, contract: string, path: string): JsonObject {
  const value = record(input, contract, path);
  for (const key of Object.keys(value)) {
    jsonValue(value[key], contract, `${path}.${key}`);
  }
  return value as JsonObject;
}

function jsonArray(input: unknown, contract: string, path: string): readonly JsonValue[] {
  const value = arrayValue(input, contract, path);
  return value.map((entry, index) => jsonValue(entry, contract, `${path}[${index}]`));
}

function stringArray(input: unknown, contract: string, path: string): readonly string[] {
  const value = arrayValue(input, contract, path);
  return value.map((entry, index) => nonEmptyString(entry, contract, `${path}[${index}]`));
}

function skillReferences(
  input: unknown,
  contract: string,
  path: string,
): readonly SkillReference[] {
  const value = arrayValue(input, contract, path);
  return value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const item = record(entry, contract, itemPath);
    return {
      id: nonEmptyString(item.id, contract, `${itemPath}.id`),
      version: nonEmptyString(item.version, contract, `${itemPath}.version`),
    };
  });
}

function idValue(
  input: unknown,
  contract: string,
  path: string,
  prefix: "run" | "step" | "exec",
): string {
  const value = nonEmptyString(input, contract, path);
  if (!new RegExp(`^${prefix}-\\d+$`).test(value)) {
    fail(contract, path, `${prefix}-<number> identity`);
  }
  return value;
}

function requestIdentity(input: unknown): AgentExecutionIdentity {
  const value = record(input, REQUEST_CONTRACT, "identity");
  return {
    runId: idValue(value.runId, REQUEST_CONTRACT, "identity.runId", "run") as RunId,
    stepId: idValue(value.stepId, REQUEST_CONTRACT, "identity.stepId", "step") as StepId,
    executionId: idValue(
      value.executionId,
      REQUEST_CONTRACT,
      "identity.executionId",
      "exec",
    ) as ExecutionId,
    agentId: nonEmptyString(value.agentId, REQUEST_CONTRACT, "identity.agentId"),
    agentVersion: nonEmptyString(value.agentVersion, REQUEST_CONTRACT, "identity.agentVersion"),
  };
}

function resultIdentity(input: unknown): StepResultIdentity {
  const value = record(input, RESULT_CONTRACT, "identity");
  return {
    runId: idValue(value.runId, RESULT_CONTRACT, "identity.runId", "run") as RunId,
    stepId: idValue(value.stepId, RESULT_CONTRACT, "identity.stepId", "step") as StepId,
    executionId: idValue(
      value.executionId,
      RESULT_CONTRACT,
      "identity.executionId",
      "exec",
    ) as ExecutionId,
  };
}

function modeValue(input: unknown, contract: string, path: string): AgentExecutionMode {
  const value = stringValue(input, contract, path);
  if (!(AGENT_EXECUTION_MODES as readonly string[]).includes(value)) {
    fail(contract, path, `one of ${AGENT_EXECUTION_MODES.join(", ")}`);
  }
  return value as AgentExecutionMode;
}

function outcomeValue(input: unknown): AgentOutcome {
  const value = stringValue(input, RESULT_CONTRACT, "outcome");
  if (!(AGENT_OUTCOMES as readonly string[]).includes(value)) {
    fail(RESULT_CONTRACT, "outcome", `one of ${AGENT_OUTCOMES.join(", ")}`);
  }
  return value as AgentOutcome;
}

function nullableStructuredObject(
  input: unknown,
  contract: string,
  path: string,
): JsonObject | null {
  if (input === null) {
    return null;
  }
  const value = jsonObject(input, contract, path);
  if (Object.keys(value).length === 0) {
    fail(contract, path, "a non-empty object or null");
  }
  return value;
}

function candidateArray(
  input: unknown,
  contract: string,
  path: string,
): readonly ResultCandidate[] {
  const value = arrayValue(input, contract, path);
  return value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const candidate = jsonObject(entry, contract, itemPath);
    const stateIdPath = findAuthoritativeStateId(candidate, itemPath);
    if (stateIdPath) {
      fail(contract, stateIdPath, "no authoritative State ID in an Agent candidate");
    }
    return candidate;
  });
}

function findAuthoritativeStateId(value: JsonValue, path: string): string | undefined {
  if (typeof value === "string") {
    return AUTHORITATIVE_STATE_ID.test(value) ? path : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findAuthoritativeStateId(entry, `${path}[${index}]`);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as JsonObject;
    for (const key of Object.keys(object)) {
      if (AUTHORITATIVE_STATE_ID.test(key)) {
        return `${path}.${key}`;
      }
      const entry = object[key];
      if (entry === undefined) {
        continue;
      }
      const found = findAuthoritativeStateId(entry, `${path}.${key}`);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

export function parseAgentExecutionRequestV1(input: unknown): AgentExecutionRequestV1 {
  const root = record(input, REQUEST_CONTRACT, "");
  requestIdentity(root.identity);

  const objective = record(root.objective, REQUEST_CONTRACT, "objective");
  nonEmptyString(objective.objective, REQUEST_CONTRACT, "objective.objective");
  nonEmptyString(objective.type, REQUEST_CONTRACT, "objective.type");
  stringArray(objective.completionCriteria, REQUEST_CONTRACT, "objective.completionCriteria");

  const retry = record(root.retry, REQUEST_CONTRACT, "retry");
  safeIntegerAtLeast(retry.attempt, REQUEST_CONTRACT, "retry.attempt", 1);
  jsonValue(retry.context, REQUEST_CONTRACT, "retry.context");

  const execution = record(root.execution, REQUEST_CONTRACT, "execution");
  modeValue(execution.mode, REQUEST_CONTRACT, "execution.mode");
  if (numberValue(execution.timeoutMs, REQUEST_CONTRACT, "execution.timeoutMs") < 0) {
    fail(REQUEST_CONTRACT, "execution.timeoutMs", "a non-negative finite number");
  }
  jsonValue(execution.cancellationPolicy, REQUEST_CONTRACT, "execution.cancellationPolicy");

  const authority = record(root.authority, REQUEST_CONTRACT, "authority");
  nonEmptyString(authority.maximumDLevel, REQUEST_CONTRACT, "authority.maximumDLevel");
  jsonArray(authority.escalationRules, REQUEST_CONTRACT, "authority.escalationRules");

  const permissions = record(root.permissions, REQUEST_CONTRACT, "permissions");
  for (const name of ["filesystem", "shell", "git", "network", "repositoryTargets"] as const) {
    jsonArray(permissions[name], REQUEST_CONTRACT, `permissions.${name}`);
  }

  const skills = record(root.skills, REQUEST_CONTRACT, "skills");
  skillReferences(skills.required, REQUEST_CONTRACT, "skills.required");
  skillReferences(skills.optional, REQUEST_CONTRACT, "skills.optional");

  const tools = record(root.tools, REQUEST_CONTRACT, "tools");
  jsonArray(tools.resolved, REQUEST_CONTRACT, "tools.resolved");
  jsonValue(tools.policy, REQUEST_CONTRACT, "tools.policy");

  const model = record(root.model, REQUEST_CONTRACT, "model");
  jsonValue(model.requested, REQUEST_CONTRACT, "model.requested");
  jsonValue(model.actual, REQUEST_CONTRACT, "model.actual");
  nonEmptyString(model.thinkingLevel, REQUEST_CONTRACT, "model.thinkingLevel");
  jsonArray(model.allowedFallback, REQUEST_CONTRACT, "model.allowedFallback");

  const context = record(root.context, REQUEST_CONTRACT, "context");
  jsonObject(context.pack, REQUEST_CONTRACT, "context.pack");
  jsonObject(context.manifest, REQUEST_CONTRACT, "context.manifest");
  stringArray(context.artifactRefs, REQUEST_CONTRACT, "context.artifactRefs");

  const outputs = record(root.outputs, REQUEST_CONTRACT, "outputs");
  stringArray(outputs.expectedArtifactTypes, REQUEST_CONTRACT, "outputs.expectedArtifactTypes");
  jsonValue(outputs.outputContract, REQUEST_CONTRACT, "outputs.outputContract");

  return input as AgentExecutionRequestV1;
}

export function parseStepResultV1(input: unknown): StepResultV1 {
  const root = record(input, RESULT_CONTRACT, "");
  resultIdentity(root.identity);
  if ("mode" in root) {
    modeValue(root.mode, RESULT_CONTRACT, "mode");
  }

  const outcome = outcomeValue(root.outcome);
  stringValue(root.summary, RESULT_CONTRACT, "summary");
  jsonArray(root.artifacts, RESULT_CONTRACT, "artifacts");

  for (const name of [
    "uncertainty_candidates",
    "decision_requests",
    "finding_candidates",
    "finding_rechecks",
    "plan_deviations",
    "skill_requests",
    "execution_checks",
    "observations",
  ] as const) {
    candidateArray(root[name], RESULT_CONTRACT, name);
  }

  const requirements = record(
    root.requirement_candidates,
    RESULT_CONTRACT,
    "requirement_candidates",
  );
  for (const name of ["acceptance_criteria", "constraints", "assumptions"] as const) {
    candidateArray(requirements[name], RESULT_CONTRACT, `requirement_candidates.${name}`);
  }

  const blocked = nullableStructuredObject(root.blocked, RESULT_CONTRACT, "blocked");
  const failure = nullableStructuredObject(root.failure, RESULT_CONTRACT, "failure");
  jsonObject(root.runtime, RESULT_CONTRACT, "runtime");

  if (outcome === "completed" && (blocked !== null || failure !== null)) {
    fail(RESULT_CONTRACT, "outcome", "null blocked and failure fields for a completed result");
  }
  if (outcome === "blocked" && (blocked === null || failure !== null)) {
    fail(RESULT_CONTRACT, "blocked", "a structured blocked value and null failure");
  }
  if (outcome === "failed" && (failure === null || blocked !== null)) {
    fail(RESULT_CONTRACT, "failure", "a structured failure value and null blocked");
  }

  return input as StepResultV1;
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

export const AgentExecutionRequestV1Schema = createRuntimeSchema(parseAgentExecutionRequestV1);
export const StepResultV1Schema = createRuntimeSchema(parseStepResultV1);

export const agentExecutionRequestV1Schema = AgentExecutionRequestV1Schema;
export const stepResultV1Schema = StepResultV1Schema;
