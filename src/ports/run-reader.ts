import type {
  DecisionsSnapshotV1,
  FindingsSnapshotV1,
  GatesSnapshotV1,
  RequirementSnapshotV1,
  RunYamlV1,
  SnapshotManifestV1,
  StepsSnapshotV1,
  UncertaintiesSnapshotV1,
} from "../contracts/state/workflow-state.js";
import type { RunId } from "../domain/primitives/ids.js";

export type StateSnapshot = Readonly<{
  requirement: RequirementSnapshotV1;
  steps: StepsSnapshotV1;
  uncertainties: UncertaintiesSnapshotV1;
  decisions: DecisionsSnapshotV1;
  gates: GatesSnapshotV1;
  findings: FindingsSnapshotV1;
  manifest: SnapshotManifestV1;
}>;

export type WorkflowState = Readonly<{
  run: RunYamlV1;
  snapshot: StateSnapshot;
}>;

export interface RunReader {
  load(runId: RunId): Promise<WorkflowState>;
}
