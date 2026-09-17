import {
  registerWorkflowCommand,
  type StartWorkflowCommand,
  type WorkflowCommandRegistration,
} from "./register-workflow-command.ts";

export function registerWfChoreCommand(
  pi: WorkflowCommandRegistration,
  start: StartWorkflowCommand,
): void {
  registerWorkflowCommand(
    pi,
    "wf-chore",
    "chore",
    "Start a chore workflow",
    start,
  );
}
