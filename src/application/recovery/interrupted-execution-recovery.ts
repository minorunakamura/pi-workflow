import {
  AgentExecutionRequestV1Schema,
  type AgentExecutionRequestV1,
} from "../../contracts/execution/agent-execution.js";
import type { ArtifactStatus } from "../../contracts/artifacts/artifact.js";
import type { ExecutionId, RunId, StepId } from "../../domain/primitives/ids.js";
import type { ArtifactRef } from "../../ports/artifact-store.js";
import type {
  RepositoryAdapter,
  RepositoryDiff,
  RepositoryScope,
  RepositorySnapshot,
} from "../../ports/repository.js";

export type InterruptedExecutionInput = Readonly<{
  request: AgentExecutionRequestV1;
  before: RepositorySnapshot;
  executionStateRevision: number;
  writeScope?: RepositoryScope;
}>;

export type InterruptedWorkerFinalization = Readonly<{
  artifact: ArtifactRef;
  changeSet: Readonly<{
    status: ArtifactStatus;
    accepted: boolean;
  }>;
}>;

type InterruptedWorkerFinalizerInput = Readonly<{
  request: AgentExecutionRequestV1;
  result: null;
  before: RepositorySnapshot;
  after: RepositorySnapshot;
  diff: RepositoryDiff;
  writeScope?: RepositoryScope;
  executionStateRevision: number;
}>;

type InterruptedWorkerFinalizer = Readonly<{
  finalize(input: InterruptedWorkerFinalizerInput): Promise<InterruptedWorkerFinalization>;
}>;

export type InterruptedExecutionRecoveryResult = Readonly<{
  kind: "retryable" | "reconcile-required" | "partial";
  request: AgentExecutionRequestV1;
  before: RepositorySnapshot;
  after: RepositorySnapshot;
  diff: RepositoryDiff;
  finalization?: InterruptedWorkerFinalization;
}>;

export type InterruptedExecutionRecoveryOptions = Readonly<{
  repository: RepositoryAdapter;
  workerFinalizer?: InterruptedWorkerFinalizer;
}>;

export class UnsupportedInterruptedExecutionError extends Error {
  readonly code = "UNSUPPORTED_INTERRUPTED_EXECUTION";

  constructor(
    readonly runId: RunId,
    readonly stepId: StepId,
    readonly executionId: ExecutionId,
  ) {
    super(`Unsupported interrupted Execution: ${runId}/${stepId}/${executionId}`);
    this.name = "UnsupportedInterruptedExecutionError";
  }
}

function repositoryChanged(diff: RepositoryDiff): boolean {
  return (
    diff.changedFiles.length > 0 ||
    diff.headChanged ||
    diff.branchChanged ||
    diff.statusChanged ||
    diff.fingerprintChanged
  );
}

function validExecutionStateRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new RangeError("executionStateRevision must be a non-negative safe integer");
  }
}

/** Inspects the repository before allowing a retry or finalizing interrupted Worker work. */
export class InterruptedExecutionRecovery {
  private readonly repository: RepositoryAdapter;
  private readonly workerFinalizer: InterruptedWorkerFinalizer | undefined;

  constructor(options: InterruptedExecutionRecoveryOptions) {
    this.repository = options.repository;
    this.workerFinalizer = options.workerFinalizer;
  }

  async recover(input: InterruptedExecutionInput): Promise<InterruptedExecutionRecoveryResult> {
    const request = AgentExecutionRequestV1Schema.parse(input.request);
    validExecutionStateRevision(input.executionStateRevision);
    const after = await this.repository.captureSnapshot();
    const diff = await this.repository.diff(input.before, after);

    if (request.identity.agentId === "worker") {
      if (request.execution.mode !== "write" || this.workerFinalizer === undefined) {
        throw new UnsupportedInterruptedExecutionError(
          request.identity.runId,
          request.identity.stepId,
          request.identity.executionId,
        );
      }

      const finalization = await this.workerFinalizer.finalize({
        request,
        result: null,
        before: input.before,
        after,
        diff,
        ...(input.writeScope === undefined ? {} : { writeScope: input.writeScope }),
        executionStateRevision: input.executionStateRevision,
      });
      return {
        kind: "partial",
        request,
        before: input.before,
        after,
        diff,
        finalization,
      };
    }

    if (request.execution.mode !== "read-only") {
      throw new UnsupportedInterruptedExecutionError(
        request.identity.runId,
        request.identity.stepId,
        request.identity.executionId,
      );
    }

    return {
      kind: repositoryChanged(diff) ? "reconcile-required" : "retryable",
      request,
      before: input.before,
      after,
      diff,
    };
  }
}
