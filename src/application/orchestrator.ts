import {
  type AgentExecutionRequestV1,
  type StepResultV1,
} from "../contracts/execution/agent-execution.js";
import type { DomainEventDraft } from "../contracts/events/event.js";
import { createIdAllocator, type IdAllocator, type RunId } from "../domain/primitives/ids.js";
import {
  normalizeStepResult,
  type ResultArtifactValidation,
  type ResultNormalizationResult,
  type ResultValidationPhase,
} from "./normalization/result-normalizer.js";
import type { CompletionEvaluation } from "../evaluation/completion-evaluator.js";
import type { AgentRuntime } from "../ports/agent-runtime.js";
import type { ArtifactReader } from "../ports/artifact-store.js";
import type { RunReader, WorkflowState } from "../ports/run-reader.js";
import type { StateStore } from "../ports/state-store.js";
import type {
  SchedulerIdleReason,
  SchedulerResult,
  SchedulerStep,
} from "../domain/scheduling/scheduler.js";
import { FixReverifyRereviewRouter } from "./fix-reverify-rereview.js";
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

export type OrchestratorFinalizePhase = (input: {
  state: WorkflowState;
  completion: CompletionEvaluation;
  result: StepResultV1 | null;
  step: SchedulerStep | null;
  normalized?: ResultNormalizationResult | null;
}) => MaybePromise<WorkflowState>;

export type OrchestratorEventFactory = (input: {
  before: WorkflowState;
  after: WorkflowState;
  completion: CompletionEvaluation;
  result: StepResultV1 | null;
  step: SchedulerStep | null;
  normalized?: ResultNormalizationResult | null;
  iteration: number;
}) => MaybePromise<readonly DomainEventDraft[]>;

export type OrchestratorDependencies = Readonly<{
  stateStore: StateStore;
  runReader?: RunReader;
  agentRuntime: AgentRuntime;
  buildRequest: OrchestratorRequestBuilder;
  completion: OrchestratorCompletionPhase;
  schedule: OrchestratorSchedulePhase;
  postconditions?: OrchestratorPostconditionPhase;
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
const noEvents: OrchestratorEventFactory = () => [];

export class Orchestrator {
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
    this.events = dependencies.events ?? noEvents;
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
      const request = await this.dependencies.buildRequest({ state, step, iteration });
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

        const untrustedResult = await this.dependencies.agentRuntime.run(
          request,
          controller.signal,
        );
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
        await this.commit({
          before: loaded,
          candidate: state,
          completion,
          result: normalized.result,
          step,
          normalized,
          iteration,
        });
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
  }
}
