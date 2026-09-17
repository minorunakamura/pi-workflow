import {
  registerWorkflowCommand,
  type StartWorkflowCommand,
  type WorkflowCommandRegistration,
} from "./register-workflow-command.ts";

export function registerWfFeatureCommand(
  pi: WorkflowCommandRegistration,
  start: StartWorkflowCommand,
): void {
  registerWorkflowCommand(
    pi,
    "wf-feature",
    "feature",
    "Start a feature workflow",
    start,
  );
}
