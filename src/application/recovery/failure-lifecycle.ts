import { stringify as stringifyYaml } from "yaml";
import { ArtifactFrontMatterV1Schema } from "../../contracts/artifacts/artifact.js";
import type {
  AgentExecutionRequestV1,
  JsonObject,
  JsonValue,
} from "../../contracts/execution/agent-execution.js";
import type { DomainEventDraft } from "../../contracts/events/event.js";
import type { ExecutionId, IdAllocator, RunId, StepId } from "../../domain/primitives/ids.js";
import { createIdAllocator } from "../../domain/primitives/ids.js";
import { redactSecrets } from "../../telemetry/redaction.js";
import type { ArtifactReader, ArtifactRef, ArtifactStore } from "../../ports/artifact-store.js";
import type { RunReader, WorkflowState } from "../../ports/run-reader.js";
import type { StateStore } from "../../ports/state-store.js";
import { withNextRevision } from "../state-revision.js";

const RUN_ID_PATTERN = /^run-\d+$/;
const STEP_ID_PATTERN = /^step-\d+$/;
const EXECUTION_ID_PATTERN = /^exec-\d+$/;
const DEFAULT_AGENT_VERSION = "1.0.0";
const FAILURE_RECORD_COUNTER = "failure_record_last_issued";
const OUTCOME_PATH = "outcome.md";

export type FailureRequestOptions = Readonly<{
  resumable: boolean;
  reason?: string;
  error?: unknown;
  execution?: AgentExecutionRequestV1;
}>;

export type FailureLifecycleDependencies = Readonly<{
  runReader: RunReader;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  artifactReader?: ArtifactReader;
  idAllocator?: IdAllocator;
  now?: () => Date;
}>;

type FailureProvenance = Readonly<{
  stepId: StepId;
  executionId: ExecutionId;
  agentId: string;
  agentVersion: number;
  skills: readonly JsonValue[];
}>;

type FailureRecordResult = Readonly<{
  artifact: ArtifactRef;
  number: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRunId(runId: RunId): RunId {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid Run ID: ${runId}`);
  }
  return runId;
}

function validText(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  return redactSecrets(value);
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError("now must return a valid Date");
  }
  return value.toISOString();
}

function isArtifactAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "ARTIFACT_ALREADY_EXISTS";
}

function idFrom(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function currentStepRecord(state: WorkflowState): Readonly<Record<string, unknown>> {
  return isRecord(state.run.current_step) ? state.run.current_step : {};
}

function agentVersionNumber(version: string): number {
  const match = /^(\d+)(?:\.\d+){0,2}(?:[-+].*)?$/.exec(version.trim());
  const value = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Agent version must start with a positive numeric version: ${version}`);
  }
  return value;
}

function failureProvenance(
  state: WorkflowState,
  execution: AgentExecutionRequestV1 | undefined,
  allocator: IdAllocator,
): FailureProvenance {
  if (execution !== undefined) {
    if (execution.identity.runId !== state.run.run_id) {
      throw new Error("Failure execution Run ID does not match the current Run");
    }
    if (!STEP_ID_PATTERN.test(execution.identity.stepId)) {
      throw new Error(`Invalid Step ID: ${execution.identity.stepId}`);
    }
    if (!EXECUTION_ID_PATTERN.test(execution.identity.executionId)) {
      throw new Error(`Invalid Execution ID: ${execution.identity.executionId}`);
    }
    return {
      stepId: execution.identity.stepId,
      executionId: execution.identity.executionId,
      agentId: execution.identity.agentId,
      agentVersion: agentVersionNumber(execution.identity.agentVersion),
      skills: [...execution.skills.required, ...execution.skills.optional],
    };
  }

  const currentStep = currentStepRecord(state);
  const stepId =
    idFrom(currentStep.id, STEP_ID_PATTERN) ??
    idFrom(currentStep.step_id, STEP_ID_PATTERN) ??
    allocator.issueStepId();
  const executionId =
    idFrom(currentStep.execution_id, EXECUTION_ID_PATTERN) ?? allocator.issueExecutionId();

  return {
    stepId: stepId as StepId,
    executionId: executionId as ExecutionId,
    agentId: "orchestrator",
    agentVersion: agentVersionNumber(DEFAULT_AGENT_VERSION),
    skills: [],
  };
}

function errorValue(error: unknown): JsonValue {
  if (error instanceof Error) {
    const details = error as unknown as Record<string, unknown>;
    const code = typeof details.code === "string" ? redactSecrets(details.code) : undefined;
    const category =
      typeof details.category === "string" ? redactSecrets(details.category) : undefined;
    const retryable = typeof details.retryable === "boolean" ? details.retryable : undefined;
    const recoverable = typeof details.recoverable === "boolean" ? details.recoverable : undefined;
    return {
      name: redactSecrets(error.name),
      message: redactSecrets(error.message),
      ...(code === undefined ? {} : { code }),
      ...(category === undefined ? {} : { category }),
      ...(retryable === undefined ? {} : { retryable }),
      ...(recoverable === undefined ? {} : { recoverable }),
    };
  }
  return redactSecrets(String(error));
}

function failureDetails(options: FailureRequestOptions): JsonObject {
  return {
    status: "failed",
    resumable: options.resumable,
    summary: "Run failed",
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.error === undefined ? {} : { error: errorValue(options.error) }),
  };
}

function failureRecordContents(
  state: WorkflowState,
  options: FailureRequestOptions,
  provenance: FailureProvenance,
  createdAt: string,
): string {
  const frontMatter = ArtifactFrontMatterV1Schema.parse({
    schema_version: 1,
    run_id: state.run.run_id,
    step_id: provenance.stepId,
    execution_id: provenance.executionId,
    execution_state_revision: state.run.state_revision,
    agent: { id: provenance.agentId, version: provenance.agentVersion },
    artifact: { type: "failure", status: "complete" },
    created_at: createdAt,
    skills: provenance.skills,
  });

  return [
    "---",
    stringifyYaml(frontMatter).trimEnd(),
    "---",
    "## Failure Record",
    "",
    "```json",
    redactSecrets(JSON.stringify(failureDetails(options), null, 2)),
    "```",
    "",
  ].join("\n");
}

function outcomeContents(
  state: WorkflowState,
  options: FailureRequestOptions,
  provenance: FailureProvenance,
  failureRecordPath: string,
  createdAt: string,
): string {
  const frontMatter = ArtifactFrontMatterV1Schema.parse({
    schema_version: 1,
    run_id: state.run.run_id,
    step_id: provenance.stepId,
    execution_id: provenance.executionId,
    execution_state_revision: state.run.state_revision,
    agent: { id: provenance.agentId, version: provenance.agentVersion },
    artifact: { type: "outcome", status: "complete" },
    created_at: createdAt,
    skills: provenance.skills,
  });
  const outcome: JsonObject = {
    status: "failed",
    request_satisfied: false,
    summary: "Run failed",
    failure_artifact_path: failureRecordPath,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  };

  return [
    "---",
    stringifyYaml(frontMatter).trimEnd(),
    "---",
    "## Outcome",
    "",
    "```json",
    redactSecrets(JSON.stringify(outcome, null, 2)),
    "```",
    "",
  ].join("\n");
}

function failureRecordNumber(state: WorkflowState): number {
  const value = state.run.counters[FAILURE_RECORD_COUNTER];
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${FAILURE_RECORD_COUNTER} must be a non-negative safe integer`);
  }
  if (value === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Failure Record sequence exhausted");
  }
  return value + 1;
}

function failurePath(number: number): string {
  return `failures/failure-${String(number).padStart(3, "0")}.md`;
}

function failurePointer(options: FailureRequestOptions, artifact: ArtifactRef): JsonObject {
  return {
    artifact_path: artifact.path,
    resumable: options.resumable,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  };
}

function failureOutcome(artifact: ArtifactRef, failure: ArtifactRef): JsonObject {
  return {
    status: "failed",
    request_satisfied: false,
    summary: "Run failed",
    artifact_path: artifact.path,
    failure_artifact_path: failure.path,
  };
}

function isTerminal(state: WorkflowState): boolean {
  return (
    state.run.finalized || state.run.status === "completed" || state.run.status === "cancelled"
  );
}

function hasCurrentFailure(state: WorkflowState, resumable: boolean): boolean {
  return (
    state.run.status === "failed" &&
    isRecord(state.run.failure) &&
    state.run.failure.resumable === resumable &&
    typeof state.run.failure.artifact_path === "string"
  );
}

function sameFailurePointer(state: WorkflowState, path: string): boolean {
  return isRecord(state.run.failure) && state.run.failure.artifact_path === path;
}

function normalizeOptions(options: FailureRequestOptions): FailureRequestOptions {
  if (typeof options.resumable !== "boolean") {
    throw new TypeError("resumable must be a boolean");
  }
  const reason = options.reason === undefined ? undefined : validText(options.reason, "reason");
  return {
    resumable: options.resumable,
    ...(reason === undefined ? {} : { reason }),
    ...(options.error === undefined ? {} : { error: options.error }),
    ...(options.execution === undefined ? {} : { execution: options.execution }),
  };
}

/** Persists an immutable Failure Record before updating the authoritative Run state. */
export class FailureLifecycle {
  private readonly pending = new Map<RunId, Promise<WorkflowState>>();
  private readonly idAllocator: IdAllocator;
  private readonly now: () => Date;

  constructor(private readonly dependencies: FailureLifecycleDependencies) {
    this.idAllocator = dependencies.idAllocator ?? createIdAllocator();
    this.now = dependencies.now ?? (() => new Date());
  }

  fail(runId: RunId, options: FailureRequestOptions): Promise<WorkflowState> {
    const validId = validRunId(runId);
    const normalized = normalizeOptions(options);
    const previous = this.pending.get(validId);
    const queued = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.failOnce(validId, normalized));

    let tracked: Promise<WorkflowState>;
    tracked = queued.then(
      (state) => {
        if (this.pending.get(validId) === tracked) this.pending.delete(validId);
        return state;
      },
      (error: unknown) => {
        if (this.pending.get(validId) === tracked) this.pending.delete(validId);
        throw error;
      },
    );
    this.pending.set(validId, tracked);
    return tracked;
  }

  finalize(
    runId: RunId,
    options: Omit<FailureRequestOptions, "resumable"> = {},
  ): Promise<WorkflowState> {
    return this.fail(runId, { ...options, resumable: false });
  }

  private async failOnce(runId: RunId, options: FailureRequestOptions): Promise<WorkflowState> {
    let state = await this.dependencies.runReader.load(runId);
    if (state.run.run_id !== runId) {
      throw new Error(`Loaded Run ID does not match requested Run ID: ${runId}`);
    }
    if (isTerminal(state) || hasCurrentFailure(state, options.resumable)) return state;

    const createdAt = timestamp(this.now);
    const provenance = failureProvenance(state, options.execution, this.idAllocator);
    const failure = await this.writeFailureRecord(state, options, provenance, createdAt);
    const outcomeArtifact = options.resumable
      ? null
      : await this.writeOutcome(state, options, provenance, failure.artifact.path, createdAt);
    const outcome =
      outcomeArtifact === null ? null : failureOutcome(outcomeArtifact, failure.artifact);
    const candidate: WorkflowState = {
      ...state,
      run: {
        ...state.run,
        status: "failed",
        finalized: !options.resumable,
        blocked: null,
        failure: failurePointer(options, failure.artifact),
        counters: {
          ...state.run.counters,
          [FAILURE_RECORD_COUNTER]: failure.number,
        },
        outcome,
      },
    };
    const next = withNextRevision(state, candidate);

    try {
      return await this.dependencies.stateStore.commit({
        expectedRevision: state.run.state_revision,
        next,
        events: [
          {
            schema_version: 1,
            type: "run.failed",
            timestamp: createdAt,
            run_id: runId,
            source: { component: "failure" },
            actor: { type: "system" },
            state_revision: next.run.state_revision,
            correlation_id: provenance.executionId,
            data: {
              status: "failed",
              resumable: options.resumable,
              finalized: !options.resumable,
              failure_artifact_path: failure.artifact.path,
              ...(outcomeArtifact === null ? {} : { artifact_path: outcomeArtifact.path }),
            },
          } satisfies DomainEventDraft,
        ],
      });
    } catch (error) {
      const latest = await this.dependencies.runReader.load(runId);
      if (isTerminal(latest) || sameFailurePointer(latest, failure.artifact.path)) return latest;
      throw error;
    }
  }

  private async writeFailureRecord(
    state: WorkflowState,
    options: FailureRequestOptions,
    provenance: FailureProvenance,
    createdAt: string,
  ): Promise<FailureRecordResult> {
    let number = failureRecordNumber(state);
    while (true) {
      const path = failurePath(number);
      const staged = await this.dependencies.artifactStore.stage({
        runId: state.run.run_id,
        executionId: provenance.executionId,
        contents: failureRecordContents(state, options, provenance, createdAt),
      });
      try {
        const artifact = await this.dependencies.artifactStore.finalize(staged, path);
        if (artifact.status !== "complete") {
          throw new Error("Failure Record Artifact must be finalized as complete");
        }
        return { artifact, number };
      } catch (error) {
        if (!isArtifactAlreadyExists(error)) throw error;
        if (number === Number.MAX_SAFE_INTEGER) {
          throw new RangeError("Failure Record sequence exhausted");
        }
        number += 1;
      }
    }
  }

  private async writeOutcome(
    state: WorkflowState,
    options: FailureRequestOptions,
    provenance: FailureProvenance,
    failurePathValue: string,
    createdAt: string,
  ): Promise<ArtifactRef> {
    const contents = outcomeContents(state, options, provenance, failurePathValue, createdAt);
    const staged = await this.dependencies.artifactStore.stage({
      runId: state.run.run_id,
      executionId: provenance.executionId,
      contents,
    });

    try {
      const artifact = await this.dependencies.artifactStore.finalize(staged, OUTCOME_PATH);
      if (artifact.status !== "complete") {
        throw new Error("Failure Outcome Artifact must be finalized as complete");
      }
      return artifact;
    } catch (error) {
      if (!isArtifactAlreadyExists(error)) throw error;
      const artifact: ArtifactRef = {
        runId: state.run.run_id,
        path: OUTCOME_PATH,
        status: "complete",
      };
      if (this.dependencies.artifactReader !== undefined) {
        const existing = await this.dependencies.artifactReader.read(artifact);
        if (
          existing.frontMatter.artifact.type !== "outcome" ||
          existing.frontMatter.artifact.status !== "complete"
        ) {
          throw error;
        }
      }
      return artifact;
    }
  }
}

export type { FailureLifecycle as RunFailureLifecycle };
