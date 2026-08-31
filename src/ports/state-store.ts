import type { DomainEventDraft } from "../contracts/events/event.js";
import type { RunReader, WorkflowState } from "./run-reader.js";

export type StateStoreCommitInput = Readonly<{
  expectedRevision: number;
  next: WorkflowState;
  events?: readonly DomainEventDraft[];
}>;

export interface StateStore extends RunReader {
  commit(input: StateStoreCommitInput): Promise<WorkflowState>;
}
