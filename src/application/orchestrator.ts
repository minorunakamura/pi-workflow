import {
  type AgentExecutionRequestV1,
  type StepResultV1,
} from "../contracts/execution/agent-execution.js";
import { validateAgentExecutionRequest } from "../agents/permission-policy.js";
import { validateEventDraft } from "../contracts/events/event.js";
import {
  createIdAllocator,
  type DecisionId,
  type IdAllocator,
  type RunId,
  type StepId,
} from "../domain/primitives/ids.js";
import {
  normalizeStepResult,
  type NormalizedCandidate,
  type ResultArtifactValidation,
  type ResultNormalizationResult,
  type ResultValidationPhase,
} from "./normalization/result-normalizer.js";
import type { CompletionEvaluation } from "../evaluation/completion-evaluator.js";
import type { AgentRuntime } from "../ports/agent-runtime.js";
import { TelemetryAgentRuntime, type TelemetryLevel } from "../telemetry/runtime-metrics.js";
import type { ArtifactReader } from "../ports/artifact-store.js";
import type { RunReader, WorkflowState } from "../ports/run-reader.js";
import type { StateStore } from "../ports/state-store.js";
import {
  USER_INTERACTION_KINDS,
  type UserInteraction,
  type UserInteractionRequest,
  type UserInteractionResult,
} from "../ports/user-interaction.js";
import type {
  SchedulerIdleReason,
  SchedulerResult,
  SchedulerStep,
} from "../domain/scheduling/scheduler.js";
import { FixReverifyRereviewRouter } from "./fix-reverify-rereview.js";
import {
  createWorkflowEventFactory,
  type WorkflowEventFactory,
  type WorkflowEventInput,
} from "./event-taxonomy.js";
import type {
  CancellationCoordinator,
  CancellationExecution,
} from "./recovery/cancellation-lifecycle.js";
import { withNextRevision } from "./state-revision.js";

const DEFAULT_MAX_ITERATIONS = 1_000;

type MaybePromise<T> = T | Promise<T>;

export type OrchestratorStatePhase = (state: WorkflowState) => MaybePromise<WorkflowState>;

export type OrchestratorCompletionPhase = (
  state: WorkflowState,
) => MaybePromise<CompletionEvaluation>;

export type OrchestratorSchedulePhase = (state: WorkflowState) => MaybePromise<SchedulerResult>;

export type OrchestratorRequestBuilder = (input: {
  state: WorkflowState;
  step: SchedulerStep;
  iteration: number;
}) => MaybePromise<AgentExecutionRequestV1>;

export type OrchestratorResultValidator = (input: {
  result: StepResultV1;
  request: AgentExecutionRequestV1;
  state: WorkflowState;
  step: SchedulerStep;
}) => MaybePromise<StepResultV1>;

export type OrchestratorResultValidationPhase = ResultValidationPhase;

export type OrchestratorArtifactValidator = (input: {
  state: WorkflowState;
  request: AgentExecutionRequestV1;
  result: StepResultV1;
  step: SchedulerStep;
  artifacts: ResultArtifactValidation;
  normalization: ResultNormalizationResult;
}) => MaybePromise<void>;

export type OrchestratorPostconditionPhase = (input: {
  state: WorkflowState;
  request: AgentExecutionRequestV1;
  result: StepResultV1;
  step: SchedulerStep;
}) => MaybePromise<WorkflowState>;

export type OrchestratorRuntimeFailurePhase = (input: {
  state: WorkflowState;
  request: AgentExecutionRequestV1;
  step: SchedulerStep;
  error: unknown;
}) => MaybePromise<WorkflowState>;

export type OrchestratorFinalizePhase = (input: {
  state: WorkflowState;
  completion: CompletionEvaluation;
  result: StepResultV1 | null;
  step: SchedulerStep | null;
  normalized?: ResultNormalizationResult | null;
}) => MaybePromise<WorkflowState>;

export type OrchestratorEventInput = WorkflowEventInput;
export type OrchestratorEventFactory = WorkflowEventFactory;

export type OrchestratorDependencies = Readonly<{
  stateStore: StateStore;
  runReader?: RunReader;
  agentRuntime: AgentRuntime;
  telemetryLevel?: TelemetryLevel;
  buildRequest: OrchestratorRequestBuilder;
  completion: OrchestratorCompletionPhase;
  schedule: OrchestratorSchedulePhase;
  postconditions?: OrchestratorPostconditionPhase;
  runtimeFailure?: OrchestratorRuntimeFailurePhase;
  finalize?: OrchestratorFinalizePhase;
  recover?: OrchestratorStatePhase;
  reconcile?: OrchestratorStatePhase;
  trigger?: OrchestratorStatePhase;
  validateResult?: OrchestratorResultValidator;
  validateRole?: OrchestratorResultValidationPhase;
  validateReferences?: OrchestratorResultValidationPhase;
  validatePermissions?: OrchestratorResultValidationPhase;
  validateArtifacts?: OrchestratorArtifactValidator;
  artifactReader?: ArtifactReader;
  maxArtifactBytes?: number;
  idAllocator?: IdAllocator;
  events?: OrchestratorEventFactory;
  fixCycle?: Pick<FixReverifyRereviewRouter, "guardCompletion" | "route"> | false;
  cancellation?: Pick<CancellationCoordinator, "isRequested" | "register">;
  userInteraction?: UserInteraction;
  maxIterations?: number;
}>;

export type OrchestratorRunResult =
  | Readonly<{
      kind: "completed";
      state: WorkflowState;
      iterations: number;
    }>
  | Readonly<{
      kind: "idle";
      state: WorkflowState;
      iterations: number;
      reason: SchedulerIdleReason;
    }>;

export class OrchestratorIterationLimitError extends Error {
  constructor(
    readonly runId: RunId,
    readonly maxIterations: number,
  ) {
    super(`Orchestrator iteration limit exceeded for ${runId}: ${maxIterations}`);
    this.name = "OrchestratorIterationLimitError";
  }
}

const unchanged: OrchestratorStatePhase = (state) => state;
const noPostconditions: OrchestratorPostconditionPhase = ({ state }) => state;
const noFinalization: OrchestratorFinalizePhase = ({ state }) => state;
const pendingDecisionCompletion: CompletionEvaluation = {
  eligible: false,
  blockers: ["DECISION_PENDING"],
};

type D3Candidate = NormalizedCandidate<DecisionId>;

type D3Resolution = Readonly<{
  state: WorkflowState;
  changed: boolean;
  cancelled: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`D3 interaction ${path} must be a non-empty string`);
  }
  return value;
}

function interactionKind(value: unknown): UserInteractionRequest["kind"] {
  const kind =
    typeof value === "string"
      ? USER_INTERACTION_KINDS.find((candidate) => candidate === value)
      : undefined;
  if (kind === undefined) {
    throw new Error(`D3 interaction kind must be one of ${USER_INTERACTION_KINDS.join(", ")}`);
  }
  return kind;
}

function optionValues(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("D3 options interaction requires a non-empty string options array");
  }
  const options = value.filter((option): option is string => typeof option === "string");
  if (options.length !== value.length || options.some((option) => option.trim().length === 0)) {
    throw new Error("D3 options interaction requires non-empty option labels");
  }
  return options;
}

function d3InteractionRequest(
  runId: RunId,
  candidate: D3Candidate,
): UserInteractionRequest | undefined {
  if (candidate.class !== "D3") return undefined;

  const kind = interactionKind(candidate.kind);
  const title = requiredText(candidate.title, "title");
  const message = requiredText(candidate.message, "message");
  const base = { runId, decisionId: candidate.id, class: "D3" as const, title, message };

  switch (kind) {
    case "approval":
      return { ...base, kind };
    case "options":
      return { ...base, kind, options: optionValues(candidate.options) };
    case "custom": {
      const placeholder = candidate.placeholder;
      if (placeholder !== undefined && typeof placeholder !== "string") {
        throw new Error("D3 custom interaction placeholder must be a string");
      }
      return {
        ...base,
        kind,
        ...(placeholder === undefined ? {} : { placeholder }),
      };
    }
  }
  throw new Error("Unsupported D3 interaction kind");
}

function assertUserInteractionResult(
  request: UserInteractionRequest,
  result: UserInteractionResult,
): void {
  if (!isRecord(result) || (result.kind !== "answered" && result.kind !== "cancelled")) {
    throw new Error("UserInteraction returned an invalid result");
  }
  if (result.kind !== "answered") return;

  if (request.kind === "approval" && typeof result.answer !== "boolean") {
    throw new Error("D3 approval interaction requires a boolean answer");
  }
  if (request.kind === "options") {
    if (typeof result.answer !== "string" || !request.options.includes(result.answer)) {
      throw new Error("D3 options interaction requires one of the offered options");
    }
  }
  if (request.kind === "custom" && typeof result.answer !== "string") {
    throw new Error("D3 custom interaction requires a string answer");
  }
}

function stepIdFrom(value: unknown): StepId | undefined {
  return typeof value === "string" && /^step-\d+$/.test(value) ? (value as StepId) : undefined;
}

function reopenBlockedStep(state: WorkflowState, stepId: StepId | undefined): WorkflowState {
  if (stepId === undefined) return state;

  const steps = state.snapshot.steps.steps.map((step) =>
    step.id === stepId && step.status === "blocked"
      ? { ...step, status: "ready" as const, blocked_by: [] }
      : step,
  );
  const currentStep = state.run.current_step;
  const nextCurrentStep =
    isRecord(currentStep) && currentStep.id === stepId && currentStep.status === "blocked"
      ? { ...currentStep, status: "ready" }
      : currentStep;

  return {
    ...state,
    run: { ...state.run, current_step: nextCurrentStep },
    snapshot: {
      ...state.snapshot,
      steps: { ...state.snapshot.steps, steps },
    },
  };
}

function applyD3Response(
  state: WorkflowState,
  candidate: D3Candidate,
  response: UserInteractionResult,
  stepId: StepId | undefined,
): WorkflowState {
  const existing = state.snapshot.decisions.decisions.find(({ id }) => id === candidate.id);
  if (existing !== undefined && existing.class !== "D3") {
    throw new Error(`Decision ${candidate.id} is not a D3 decision`);
  }

  const decision = {
    ...candidate,
    id: candidate.id,
    class: "D3" as const,
    ...(stepId === undefined ? {} : { step_id: stepId }),
    status: response.kind === "answered" ? ("resolved" as const) : ("pending" as const),
    ...(response.kind === "answered" ? { authority: "user", resolution: response.answer } : {}),
  };
  const decisions =
    existing === undefined
      ? [...state.snapshot.decisions.decisions, decision]
      : state.snapshot.decisions.decisions.map((current) =>
          current.id === candidate.id ? decision : current,
        );
  const next = {
    ...state,
    run:
      response.kind === "answered"
        ? { ...state.run, status: "running" as const, blocked: null }
        : {
            ...state.run,
            status: "blocked" as const,
            blocked: { reason: "user-input-required", decision_id: candidate.id },
          },
    snapshot: {
      ...state.snapshot,
      decisions: { ...state.snapshot.decisions, decisions },
    },
  };

  return response.kind === "answered" ? reopenBlockedStep(next, stepId) : next;
}

export class Orchestrator {
  private readonly agentRuntime: AgentRuntime;
  private readonly runReader: RunReader;
  private readonly recover: OrchestratorStatePhase;
  private readonly reconcile: OrchestratorStatePhase;
  private readonly trigger: OrchestratorStatePhase;
  private readonly postconditions: OrchestratorPostconditionPhase;
  private readonly finalize: OrchestratorFinalizePhase;
  private readonly events: OrchestratorEventFactory;
  private readonly fixCycle:
    | Pick<FixReverifyRereviewRouter, "guardCompletion" | "route">
    | undefined;
  private readonly idAllocator: IdAllocator;
  private readonly cancellation:
    | Pick<CancellationCoordinator, "isRequested" | "register">
    | undefined;
  private readonly maxIterations: number;

  constructor(private readonly dependencies: OrchestratorDependencies) {
    this.agentRuntime = new TelemetryAgentRuntime(
      dependencies.agentRuntime,
      dependencies.telemetryLevel === undefined ? {} : { level: dependencies.telemetryLevel },
    );
    const maxIterations = dependencies.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
      throw new RangeError("maxIterations must be a positive safe integer");
    }

    this.runReader = dependencies.runReader ?? dependencies.stateStore;
    this.recover = dependencies.recover ?? unchanged;
    this.reconcile = dependencies.reconcile ?? unchanged;
    this.trigger = dependencies.trigger ?? unchanged;
    this.postconditions = dependencies.postconditions ?? noPostconditions;
    this.finalize = dependencies.finalize ?? noFinalization;
    this.events = dependencies.events ?? createWorkflowEventFactory();
    this.idAllocator = dependencies.idAllocator ?? createIdAllocator();
    this.cancellation = dependencies.cancellation;
    this.fixCycle =
      dependencies.fixCycle === false
        ? undefined
        : (dependencies.fixCycle ??
          new FixReverifyRereviewRouter({ idAllocator: this.idAllocator }));
    this.maxIterations = maxIterations;
  }

  async run(runId: RunId): Promise<OrchestratorRunResult> {
    for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
      const loaded = await this.runReader.load(runId);
      if (loaded.run.run_id !== runId) {
        throw new Error(`Loaded Run ID does not match requested Run ID: ${runId}`);
      }
      let state = loaded;

      state = await this.recover(state);
      state = await this.reconcile(state);
      state = await this.trigger(state);

      if (this.isCancellationRequested(runId, state)) {
        return {
          kind: "idle",
          state,
          iterations: iteration,
          reason: "RUN_TERMINAL",
        };
      }

      const pendingDecisions =
        state.run.finalized || state.run.status === "completed" || state.run.status === "cancelled"
          ? []
          : state.snapshot.decisions.decisions.filter(
              (decision) =>
                decision.class === "D3" && decision.status === "pending" && "kind" in decision,
            );
      if (pendingDecisions.length > 0) {
        const resolved = await this.resolveD3Candidates({
          state,
          candidates: pendingDecisions,
        });
        if (resolved.changed) {
          const committed = await this.commit({
            before: loaded,
            candidate: resolved.state,
            completion: pendingDecisionCompletion,
            result: null,
            step: null,
            normalized: null,
            iteration,
          });
          if (resolved.cancelled) {
            return {
              kind: "idle",
              state: committed,
              iterations: iteration,
              reason: "RECOVERABLE_BLOCKER",
            };
          }
          continue;
        }
      }

      const evaluatedCompletion = await this.dependencies.completion(state);
      const completion = this.fixCycle
        ? this.fixCycle.guardCompletion(state, evaluatedCompletion)
        : evaluatedCompletion;

      if (!completion.eligible && this.fixCycle !== undefined) {
        const recovery = this.fixCycle.route({ state, blockers: completion.blockers });
        if (recovery.inserted) {
          await this.commit({
            before: loaded,
            candidate: recovery.state,
            completion,
            result: null,
            step: null,
            normalized: null,
            iteration,
          });
          continue;
        }
      }

      if (completion.eligible) {
        if (this.isCancellationRequested(runId, state)) {
          return {
            kind: "idle",
            state,
            iterations: iteration,
            reason: "RUN_TERMINAL",
          };
        }
        const finalized = await this.finalize({
          state,
          completion,
          result: null,
          step: null,
          normalized: null,
        });
        const terminal = {
          ...finalized,
          run: { ...finalized.run, status: "completed" as const, finalized: true },
        };
        if (this.isCancellationRequested(runId, terminal)) {
          return {
            kind: "idle",
            state: terminal,
            iterations: iteration,
            reason: "RUN_TERMINAL",
          };
        }
        let committed: WorkflowState;
        try {
          committed = await this.commit({
            before: loaded,
            candidate: terminal,
            completion,
            result: null,
            step: null,
            normalized: null,
            iteration,
          });
        } catch (error) {
          if (!this.isCancellationRequested(runId, state)) throw error;
          return {
            kind: "idle",
            state: await this.runReader.load(runId),
            iterations: iteration,
            reason: "RUN_TERMINAL",
          };
        }
        return { kind: "completed", state: committed, iterations: iteration };
      }

      if (this.isCancellationRequested(runId, state)) {
        return {
          kind: "idle",
          state,
          iterations: iteration,
          reason: "RUN_TERMINAL",
        };
      }

      const scheduled = await this.dependencies.schedule(state);
      if (scheduled.kind === "idle") {
        return {
          kind: "idle",
          state,
          iterations: iteration,
          reason: scheduled.reason,
        };
      }

      const step = scheduled.step;
      const request = validateAgentExecutionRequest(
        await this.dependencies.buildRequest({ state, step, iteration }),
      );
      this.assertRequestIdentity(request, runId, step);

      let settleExecution!: () => void;
      const settled = new Promise<void>((resolve) => {
        settleExecution = resolve;
      });
      const controller = new AbortController();
      const activeExecution: CancellationExecution = {
        request,
        controller,
        settled,
      };
      const unregister = this.cancellation?.register(activeExecution);

      try {
        if (controller.signal.aborted || this.isCancellationRequested(runId, state)) {
          return {
            kind: "idle",
            state: await this.runReader.load(runId),
            iterations: iteration,
            reason: "RUN_TERMINAL",
          };
        }

        let untrustedResult: unknown;
        try {
          untrustedResult = await this.agentRuntime.run(request, controller.signal);
        } catch (error) {
          if (controller.signal.aborted || this.isCancellationRequested(runId, state)) {
            return {
              kind: "idle",
              state: await this.runReader.load(runId),
              iterations: iteration,
              reason: "RUN_TERMINAL",
            };
          }
          const runtimeFailure = this.dependencies.runtimeFailure;
          if (runtimeFailure === undefined) throw error;
          const recovered = await runtimeFailure({ state, request, step, error });
          if (recovered.run.run_id !== runId) {
            throw new Error(`Runtime failure handler returned a different Run ID: ${runId}`);
          }
          return {
            kind: "idle",
            state: recovered,
            iterations: iteration,
            reason: "RECOVERABLE_BLOCKER",
          };
        }
        if (controller.signal.aborted || this.isCancellationRequested(runId, state)) {
          return {
            kind: "idle",
            state: await this.runReader.load(runId),
            iterations: iteration,
            reason: "RUN_TERMINAL",
          };
        }
        const normalized = await normalizeStepResult(
          { result: untrustedResult, request, state, step },
          {
            resultValidator: this.dependencies.validateResult,
            validateRole: this.dependencies.validateRole,
            validateReferences: this.dependencies.validateReferences,
            validatePermissions: this.dependencies.validatePermissions,
            postconditions: this.postconditions,
            allocator: this.idAllocator,
            artifactReader: this.dependencies.artifactReader,
            maxArtifactBytes: this.dependencies.maxArtifactBytes,
          },
        );
        state = normalized.state;
        if (this.dependencies.validateArtifacts !== undefined) {
          await this.dependencies.validateArtifacts({
            state,
            request,
            result: normalized.result,
            step,
            artifacts: normalized.artifacts,
            normalization: normalized,
          });
        }
        state = await this.finalize({
          state,
          completion,
          result: normalized.result,
          step,
          normalized,
        });
        if (this.fixCycle !== undefined) {
          const recovery = this.fixCycle.route({
            state,
            step,
            result: normalized.result,
          });
          state = recovery.state;
        }
        const d3Resolution = await this.resolveD3Candidates({
          state,
          candidates: normalized.candidates.decision_requests,
          stepId: step.id,
          signal: controller.signal,
        });
        state = d3Resolution.state;
        if (controller.signal.aborted || this.isCancellationRequested(runId, state)) {
          return {
            kind: "idle",
            state: await this.runReader.load(runId),
            iterations: iteration,
            reason: "RUN_TERMINAL",
          };
        }
        const committed = await this.commit({
          before: loaded,
          candidate: state,
          completion,
          result: normalized.result,
          step,
          normalized,
          iteration,
        });
        if (d3Resolution.cancelled) {
          return {
            kind: "idle",
            state: committed,
            iterations: iteration,
            reason: "RECOVERABLE_BLOCKER",
          };
        }
      } catch (error) {
        if (controller.signal.aborted || this.isCancellationRequested(runId, state)) {
          return {
            kind: "idle",
            state: await this.runReader.load(runId),
            iterations: iteration,
            reason: "RUN_TERMINAL",
          };
        }
        throw error;
      } finally {
        settleExecution();
        unregister?.();
      }
    }

    throw new OrchestratorIterationLimitError(runId, this.maxIterations);
  }

  private async resolveD3Candidates(input: {
    state: WorkflowState;
    candidates: readonly D3Candidate[];
    stepId?: StepId;
    signal?: AbortSignal;
  }): Promise<D3Resolution> {
    let state = input.state;
    let changed = false;

    for (const candidate of input.candidates) {
      const request = d3InteractionRequest(state.run.run_id, candidate);
      if (request === undefined) continue;
      const userInteraction = this.dependencies.userInteraction;
      if (userInteraction === undefined) {
        throw new Error("D3 decision requires a UserInteraction adapter");
      }

      const response = await userInteraction.ask(request, input.signal);
      assertUserInteractionResult(request, response);
      state = applyD3Response(
        state,
        candidate,
        response,
        input.stepId ?? stepIdFrom(candidate.step_id),
      );
      changed = true;
      if (response.kind === "cancelled") {
        return { state, changed, cancelled: true };
      }
    }

    return { state, changed, cancelled: false };
  }

  private async commit(input: {
    before: WorkflowState;
    candidate: WorkflowState;
    completion: CompletionEvaluation;
    result: StepResultV1 | null;
    step: SchedulerStep | null;
    normalized: ResultNormalizationResult | null;
    iteration: number;
  }): Promise<WorkflowState> {
    const next = withNextRevision(input.before, input.candidate);
    const events = await this.events({
      before: input.before,
      after: next,
      completion: input.completion,
      result: input.result,
      step: input.step,
      normalized: input.normalized,
      iteration: input.iteration,
    });
    for (const event of events) validateEventDraft(event);
    return this.dependencies.stateStore.commit({
      expectedRevision: input.before.run.state_revision,
      next,
      events,
    });
  }

  private isCancellationRequested(runId: RunId, state: WorkflowState): boolean {
    return state.run.cancellation !== null || this.cancellation?.isRequested(runId) === true;
  }

  private assertRequestIdentity(
    request: AgentExecutionRequestV1,
    runId: RunId,
    step: SchedulerStep,
  ): void {
    if (request.identity.runId !== runId || request.identity.stepId !== step.id) {
      throw new Error("Agent execution request identity does not match dispatched Step");
    }
    if (request.identity.agentId !== step.agent) {
      throw new Error("Agent execution request role does not match dispatched Step");
    }
  }
}
