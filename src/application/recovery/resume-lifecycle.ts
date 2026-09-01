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
}>;

function assertRunIdentity(runId: RunId, state: WorkflowState): void {
  if (state.run.run_id !== runId) {
    throw new Error(`Loaded Run ID does not match requested Run ID: ${runId}`);
  }
}

export class ResumeLifecycle {
  constructor(private readonly dependencies: ResumeLifecycleDependencies) {}

  async resume(runId: RunId): Promise<WorkflowState> {
    const loaded = await this.dependencies.runReader.load(runId);
    assertRunIdentity(runId, loaded);
    assertRunResumeAllowed(loaded);

    const checked = await this.dependencies.recheckRepositoryAndFreshness(loaded);
    assertRunIdentity(runId, checked);
    assertRunResumeAllowed(checked);

    const candidate = resumeRun(checked);
    return this.dependencies.stateStore.commit({
      expectedRevision: checked.run.state_revision,
      next: withNextRevision(checked, candidate),
    });
  }
}
