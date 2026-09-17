import {
  registerWorkflowCommand,
  type StartWorkflowCommand,
  type WorkflowCommandRegistration,
} from "./register-workflow-command.ts";

export function registerWfBugCommand(
  pi: WorkflowCommandRegistration,
  start: StartWorkflowCommand,
): void {
  registerWorkflowCommand(pi, "wf-bug", "bug", "Start a bug workflow", start);
}
