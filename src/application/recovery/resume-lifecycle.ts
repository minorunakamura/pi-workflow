import type { RunId } from "../../domain/primitives/ids.js";
import type { RunReader, WorkflowState } from "../../ports/run-reader.js";
import type { StateStore } from "../../ports/state-store.js";
import { withNextRevision } from "../state-revision.js";
import { assertRunResumeAllowed, resumeRun } from "./recovery-manager.js";

type MaybePromise<T> = T | Promise<T>;

export type ResumeFreshnessPhase = (state: WorkflowState) => MaybePromise<WorkflowState>;

export type ResumeLifecycleDependencies = Readonly<{
  runReader: RunReader;
  stateStore: StateStore;
  recheckRepositoryAndFreshness: ResumeFreshnessPhase;
  now?: () => Date;
}>;

function assertRunIdentity(runId: RunId, state: WorkflowState): void {
  if (state.run.run_id !== runId) {
    throw new Error(`Loaded Run ID does not match requested Run ID: ${runId}`);
  }
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError("now must return a valid Date");
  }
  return value.toISOString();
}

export class ResumeLifecycle {
  private readonly now: () => Date;

  constructor(private readonly dependencies: ResumeLifecycleDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async resume(runId: RunId): Promise<WorkflowState> {
    const loaded = await this.dependencies.runReader.load(runId);
    assertRunIdentity(runId, loaded);
    assertRunResumeAllowed(loaded);

    const checked = await this.dependencies.recheckRepositoryAndFreshness(loaded);
    assertRunIdentity(runId, checked);
    assertRunResumeAllowed(checked);

    const candidate = resumeRun(checked);
    const next = withNextRevision(checked, candidate);
    return this.dependencies.stateStore.commit({
      expectedRevision: checked.run.state_revision,
      next,
      events: [
        {
          schema_version: 1,
          type: "run.resumed",
          timestamp: timestamp(this.now),
          run_id: runId,
          source: { component: "resume" },
          actor: { type: "user" },
          state_revision: next.run.state_revision,
          correlation_id: runId,
          data: { from: checked.run.status, to: next.run.status },
        },
      ],
    });
  }
}
