import type { DomainEventDraft } from "../contracts/events/event.js";
import type { RunId } from "../domain/primitives/ids.js";
import type { RunReader, WorkflowState } from "./run-reader.js";

export type StateStoreCreateInput = Readonly<{
  initial: WorkflowState;
  request: string;
  effectiveConfig: string;
  events?: readonly DomainEventDraft[];
}>;

export type StateStoreCommitInput = Readonly<{
  expectedRevision: number;
  next: WorkflowState;
  events?: readonly DomainEventDraft[];
}>;

export interface StateStore extends RunReader {
  commit(input: StateStoreCommitInput): Promise<WorkflowState>;
}

export interface RunStore extends StateStore {
  /** Allocates a Run ID that is not present in the consuming repository. */
  issueRunId(): Promise<RunId>;
  create(input: StateStoreCreateInput): Promise<WorkflowState>;
}
