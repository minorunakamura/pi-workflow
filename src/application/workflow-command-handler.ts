export type WorkflowCommand =
  | "feature"
  | "bug"
  | "hotfix"
  | "chore"
  | "refactor"
  | "investigation"
  | "status"
  | "resume"
  | "cancel";

export interface WorkflowCommandHandler {
  execute(command: WorkflowCommand, args: string): Promise<void>;
}
