import type { RunReader, WorkflowState } from "./run-reader.js";

export type StateStoreCommitInput = Readonly<{
  expectedRevision: number;
  next: WorkflowState;
}>;

export interface StateStore extends RunReader {
  commit(input: StateStoreCommitInput): Promise<WorkflowState>;
}
