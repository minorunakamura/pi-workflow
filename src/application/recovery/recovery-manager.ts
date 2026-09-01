import type { RunStatus } from "../../contracts/state/workflow-state.js";
import type { RunId } from "../../domain/primitives/ids.js";
import type { RunLock, RunLockHandle } from "../../ports/run-lock.js";
import type { RunReader, WorkflowState } from "../../ports/run-reader.js";
import type { WorkspaceLock, WorkspaceLockHandle } from "../../ports/workspace-lock.js";

type MaybePromise<T> = T | Promise<T>;

export type RecoveryValidationPhase = (state: WorkflowState) => MaybePromise<void>;
export type RecoveryStatePhase = (state: WorkflowState) => MaybePromise<WorkflowState>;

export type RecoveryManagerDependencies = Readonly<{
  runReader: RunReader;
  runLock: RunLock;
  workspaceLock: WorkspaceLock;
  validateEffectiveConfig: RecoveryValidationPhase;
  checkRepositoryDrift: RecoveryStatePhase;
  recoverInterruptedExecution: RecoveryStatePhase;
  processCancellation: RecoveryStatePhase;
  reconcile: RecoveryStatePhase;
  processTriggers: RecoveryStatePhase;
}>;

export type RecoverySession = Readonly<{
  state: WorkflowState;
  runLock: RunLockHandle;
  workspaceLock: WorkspaceLockHandle;
  release(): Promise<void>;
}>;

export type RecoveryContinuation<T> = (session: RecoverySession) => MaybePromise<T>;

export class NonResumableRunError extends Error {
  readonly code = "RUN_NOT_RESUMABLE";

  constructor(
    readonly runId: RunId,
    readonly status: RunStatus,
  ) {
    super(`Run ${runId} is not resumable: ${status}`);
    this.name = "NonResumableRunError";
  }
}

function hasResumableFailure(state: WorkflowState): boolean {
  return state.run.failure?.resumable === true;
}

export function isRunResumeAllowed(state: WorkflowState): boolean {
  return (
    !state.run.finalized &&
    (state.run.status === "blocked" ||
      (state.run.status === "failed" && hasResumableFailure(state)))
  );
}

export function assertRunResumeAllowed(state: WorkflowState): void {
  if (!isRunResumeAllowed(state)) {
    throw new NonResumableRunError(state.run.run_id, state.run.status);
  }
}

export function resumeRun(state: WorkflowState): WorkflowState {
  assertRunResumeAllowed(state);
  return {
    ...state,
    run: {
      ...state.run,
      status: "running",
      blocked: null,
      failure: null,
    },
  };
}

export function assertRunResumable(state: WorkflowState): void {
  if (
    state.run.finalized ||
    state.run.status === "completed" ||
    state.run.status === "cancelled" ||
    (state.run.status === "failed" && !hasResumableFailure(state))
  ) {
    throw new NonResumableRunError(state.run.run_id, state.run.status);
  }
}

function assertRunIdentity(runId: RunId, state: WorkflowState): void {
  if (state.run.run_id !== runId) {
    throw new Error(`Loaded Run ID does not match requested Run ID: ${runId}`);
  }
}

async function releaseLocks(
  runLock: RunLockHandle,
  workspaceLock: WorkspaceLockHandle | undefined,
): Promise<void> {
  const errors: unknown[] = [];
  if (workspaceLock !== undefined) {
    try {
      await workspaceLock.release();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await runLock.release();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw errors[0];
  }
}

export class RecoveryManager {
  constructor(private readonly dependencies: RecoveryManagerDependencies) {}

  async recover(runId: RunId): Promise<RecoverySession> {
    let state = await this.dependencies.runReader.load(runId);
    assertRunIdentity(runId, state);
    assertRunResumable(state);
    await this.dependencies.validateEffectiveConfig(state);

    const runLock = await this.dependencies.runLock.acquire(runId, { recoverStale: true });
    let workspaceLock: WorkspaceLockHandle | undefined;

    try {
      state = await this.dependencies.runReader.load(runId);
      assertRunIdentity(runId, state);
      assertRunResumable(state);
      await this.dependencies.validateEffectiveConfig(state);

      workspaceLock = await this.dependencies.workspaceLock.acquire({ recoverStale: true });
      state = await this.applyStatePhase(runId, state, this.dependencies.checkRepositoryDrift);
      state = await this.applyStatePhase(
        runId,
        state,
        this.dependencies.recoverInterruptedExecution,
      );
      state = await this.applyStatePhase(runId, state, this.dependencies.processCancellation);
      state = await this.applyStatePhase(runId, state, this.dependencies.reconcile);
      state = await this.applyStatePhase(runId, state, this.dependencies.processTriggers);

      const session: RecoverySession = {
        state,
        runLock,
        workspaceLock,
        release: () => releaseLocks(runLock, workspaceLock),
      };
      return session;
    } catch (error) {
      await releaseLocks(runLock, workspaceLock).catch(() => undefined);
      throw error;
    }
  }

  async run<T>(runId: RunId, continueScheduling: RecoveryContinuation<T>): Promise<T> {
    const session = await this.recover(runId);
    try {
      return await continueScheduling(session);
    } finally {
      await session.release();
    }
  }

  private async applyStatePhase(
    runId: RunId,
    state: WorkflowState,
    phase: RecoveryStatePhase,
  ): Promise<WorkflowState> {
    const next = await phase(state);
    assertRunIdentity(runId, next);
    return next;
  }
}
