import { stringify as stringifyYaml } from "yaml";
import { ArtifactFrontMatterV1Schema } from "../../contracts/artifacts/artifact.js";
import type {
  AgentExecutionRequestV1,
  JsonObject,
  JsonValue,
} from "../../contracts/execution/agent-execution.js";
import type { DomainEventDraft } from "../../contracts/events/event.js";
import type { IdAllocator, RunId, StepId, ExecutionId } from "../../domain/primitives/ids.js";
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
const OUTCOME_PATH = "outcome.md";

export type CancellationIntent = JsonObject &
  Readonly<{
    requested: true;
    requested_at: string;
    requested_by: string;
    reason?: string;
  }>;

export type CancellationRequestOptions = Readonly<{
  requestedBy?: string;
  reason?: string;
  execution?: AgentExecutionRequestV1;
}>;

export type CancellationExecution = Readonly<{
  request: AgentExecutionRequestV1;
  controller: AbortController;
  settled: Promise<unknown>;
  reconcile?: (cause: unknown) => Promise<unknown>;
}>;

export type CancellationCoordinator = Readonly<{
  isRequested(runId: RunId): boolean;
  register(execution: CancellationExecution): () => void;
}>;

export type CancellationLifecycleDependencies = Readonly<{
  runReader: RunReader;
  stateStore: StateStore;
  artifactStore: ArtifactStore;
  artifactReader?: ArtifactReader;
  idAllocator?: IdAllocator;
  now?: () => Date;
}>;

export class CancellationNotRequestedError extends Error {
  readonly code = "CANCELLATION_NOT_REQUESTED";

  constructor(readonly runId: RunId) {
    super(`Run ${runId} has no persisted cancellation intent`);
    this.name = "CancellationNotRequestedError";
  }
}

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

function isTerminal(state: WorkflowState): boolean {
  return (
    state.run.finalized || state.run.status === "completed" || state.run.status === "cancelled"
  );
}

function isArtifactAlreadyExists(error: unknown): boolean {
  return (
    isRecord(error) && error.code === "ARTIFACT_ALREADY_EXISTS" && typeof error.message === "string"
  );
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

type OutcomeProvenance = Readonly<{
  stepId: StepId;
  executionId: ExecutionId;
  agentId: string;
  agentVersion: number;
  skills: readonly JsonValue[];
}>;

function outcomeProvenance(
  state: WorkflowState,
  execution: AgentExecutionRequestV1 | undefined,
  allocator: IdAllocator,
): OutcomeProvenance {
  if (execution !== undefined) {
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

function outcomeContents(
  state: WorkflowState,
  intent: JsonObject,
  provenance: OutcomeProvenance,
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
    status: "cancelled",
    request_satisfied: false,
    summary: "Run cancelled",
    cancellation: intent,
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

function cancellationOutcome(intent: JsonObject, artifact: ArtifactRef): JsonObject {
  return {
    status: "cancelled",
    request_satisfied: false,
    summary: "Run cancelled",
    artifact_path: artifact.path,
    ...(typeof intent.reason === "string" ? { reason: intent.reason } : {}),
  };
}

function cancellationEvent(
  state: WorkflowState,
  type: "run.cancel-requested" | "run.cancelled",
  data: JsonObject,
  timestampValue: string,
  executionId?: ExecutionId,
): DomainEventDraft {
  return {
    schema_version: 1,
    type,
    timestamp: timestampValue,
    run_id: state.run.run_id,
    source: { component: "cancellation" },
    actor: { type: "user" },
    state_revision: state.run.state_revision,
    correlation_id: executionId ?? state.run.run_id,
    data,
  };
}

/** Persists cancellation before aborting active work and terminalizes it safely. */
export class CancellationLifecycle implements CancellationCoordinator {
  private readonly active = new Map<RunId, CancellationExecution>();
  private readonly requested = new Set<RunId>();
  private readonly pending = new Map<RunId, Promise<WorkflowState>>();
  private readonly idAllocator: IdAllocator;
  private readonly now: () => Date;

  constructor(private readonly dependencies: CancellationLifecycleDependencies) {
    this.idAllocator = dependencies.idAllocator ?? createIdAllocator();
    this.now = dependencies.now ?? (() => new Date());
  }

  isRequested(runId: RunId): boolean {
    return this.requested.has(validRunId(runId));
  }

  register(execution: CancellationExecution): () => void {
    const runId = validRunId(execution.request.identity.runId);
    this.active.set(runId, execution);
    if (this.requested.has(runId)) {
      execution.controller.abort();
    }

    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      if (this.active.get(runId) === execution && !this.requested.has(runId)) {
        this.active.delete(runId);
      }
    };
  }

  cancel(runId: RunId, options: CancellationRequestOptions = {}): Promise<WorkflowState> {
    const validId = validRunId(runId);
    const previous = this.pending.get(validId);
    const queued = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.cancelOnce(validId, options));

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

  request(runId: RunId, options: CancellationRequestOptions = {}): Promise<WorkflowState> {
    return this.cancel(runId, options);
  }

  finalize(runId: RunId): Promise<WorkflowState> {
    return this.cancel(runId);
  }

  private async cancelOnce(
    runId: RunId,
    options: CancellationRequestOptions,
  ): Promise<WorkflowState> {
    let state = await this.dependencies.runReader.load(runId);
    if (state.run.run_id !== runId) {
      throw new Error(`Loaded Run ID does not match requested Run ID: ${runId}`);
    }
    if (isTerminal(state)) return state;

    const active = this.active.get(runId);
    const execution = options.execution ?? active?.request;
    if (state.run.cancellation === null) {
      const requestedBy = validText(options.requestedBy ?? "user", "requestedBy");
      const requestedAt = timestamp(this.now);
      const intent: CancellationIntent = {
        requested: true,
        requested_at: requestedAt,
        requested_by: requestedBy,
        ...(options.reason === undefined ? {} : { reason: validText(options.reason, "reason") }),
      };
      const candidate = withNextRevision(state, {
        ...state,
        run: { ...state.run, cancellation: intent },
      });
      try {
        state = await this.dependencies.stateStore.commit({
          expectedRevision: state.run.state_revision,
          next: candidate,
          events: [
            cancellationEvent(
              candidate,
              "run.cancel-requested",
              {
                cancellation_requested: true,
                requested_by: requestedBy,
                ...(intent.reason === undefined ? {} : { reason: intent.reason }),
              },
              requestedAt,
              execution?.identity.executionId,
            ),
          ],
        });
      } catch (error) {
        const latest = await this.dependencies.runReader.load(runId);
        if (isTerminal(latest)) return latest;
        if (latest.run.cancellation === null) throw error;
        state = latest;
      }
    }

    this.requested.add(runId);
    const activeAfterIntent = this.active.get(runId) ?? active;
    if (activeAfterIntent !== undefined) {
      activeAfterIntent.controller.abort();
      let cause: unknown;
      try {
        await activeAfterIntent.settled;
      } catch (error) {
        cause = error;
      }
      if (activeAfterIntent.request.identity.agentId === "worker") {
        await activeAfterIntent.reconcile?.(cause);
      }
    }

    return this.finalizeCancellation(runId, activeAfterIntent?.request ?? execution);
  }

  private async finalizeCancellation(
    runId: RunId,
    execution: AgentExecutionRequestV1 | undefined,
  ): Promise<WorkflowState> {
    let state = await this.dependencies.runReader.load(runId);
    if (isTerminal(state)) return state;
    const intent = state.run.cancellation;
    if (intent === null) {
      throw new CancellationNotRequestedError(runId);
    }

    const provenance = outcomeProvenance(state, execution, this.idAllocator);
    const createdAt = timestamp(this.now);
    const artifact = await this.writeOutcome(state, intent, provenance, createdAt);
    const outcome = cancellationOutcome(intent, artifact);
    const candidate: WorkflowState = {
      ...state,
      run: {
        ...state.run,
        status: "cancelled",
        finalized: true,
        outcome,
      },
    };

    const next = withNextRevision(state, candidate);
    try {
      const committed = await this.dependencies.stateStore.commit({
        expectedRevision: state.run.state_revision,
        next,
        events: [
          cancellationEvent(
            next,
            "run.cancelled",
            { status: "cancelled", artifact_path: artifact.path },
            createdAt,
            provenance.executionId,
          ),
        ],
      });
      this.active.delete(runId);
      return committed;
    } catch (error) {
      const latest = await this.dependencies.runReader.load(runId);
      if (isTerminal(latest)) {
        this.active.delete(runId);
        return latest;
      }
      if (latest.run.cancellation === null) throw error;

      const retryCandidate: WorkflowState = {
        ...latest,
        run: { ...latest.run, status: "cancelled", finalized: true, outcome },
      };
      const retryNext = withNextRevision(latest, retryCandidate);
      const committed = await this.dependencies.stateStore.commit({
        expectedRevision: latest.run.state_revision,
        next: retryNext,
        events: [
          cancellationEvent(
            retryNext,
            "run.cancelled",
            { status: "cancelled", artifact_path: artifact.path },
            createdAt,
            provenance.executionId,
          ),
        ],
      });
      this.active.delete(runId);
      return committed;
    }
  }

  private async writeOutcome(
    state: WorkflowState,
    intent: JsonObject,
    provenance: OutcomeProvenance,
    createdAt: string,
  ): Promise<ArtifactRef> {
    const contents = outcomeContents(state, intent, provenance, createdAt);
    const staged = await this.dependencies.artifactStore.stage({
      runId: state.run.run_id,
      executionId: provenance.executionId,
      contents,
    });

    try {
      const artifact = await this.dependencies.artifactStore.finalize(staged, OUTCOME_PATH);
      if (artifact.status !== "complete") {
        throw new Error("Cancellation Outcome Artifact must be finalized as complete");
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

export type { CancellationLifecycle as RunCancellationLifecycle };
