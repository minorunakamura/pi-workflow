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

export interface StartWorkflowUseCase {
  execute(command: StartWorkflowCommand, args: string): Promise<void>;
}

export interface WorkflowCommandHandler {
  execute(command: WorkflowCommand, args: string): Promise<void>;
}
