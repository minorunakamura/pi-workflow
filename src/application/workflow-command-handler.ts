import type { RunId } from "../domain/primitives/ids.js";
import type { WorkflowState } from "../ports/run-reader.js";
import type { CancellationRequestOptions } from "./recovery/cancellation-lifecycle.js";

export const START_WORKFLOW_COMMANDS = [
  "feature",
  "bug",
  "hotfix",
  "chore",
  "refactor",
  "investigation",
] as const;

export type StartWorkflowCommand = (typeof START_WORKFLOW_COMMANDS)[number];

export type WorkflowCommand = StartWorkflowCommand | "status" | "resume" | "cancel";
export type WorkflowCommandOutput = string;

export interface StartWorkflowUseCase {
  execute(command: StartWorkflowCommand, args: string): Promise<void>;
}

export interface StatusWorkflowUseCase {
  execute(runId: RunId): Promise<WorkflowState>;
}

export interface ResumeWorkflowUseCase {
  execute(runId: RunId): Promise<WorkflowState>;
}

export interface CancelWorkflowUseCase {
  execute(runId: RunId, options?: CancellationRequestOptions): Promise<WorkflowState>;
}

export interface WorkflowCommandHandler {
  execute(command: WorkflowCommand, args: string): Promise<WorkflowCommandOutput | void>;
}
