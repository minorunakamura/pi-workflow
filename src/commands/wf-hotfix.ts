import {
  registerWorkflowCommand,
  type StartWorkflowCommand,
  type WorkflowCommandRegistration,
} from "./register-workflow-command.ts";

export function registerWfHotfixCommand(
  pi: WorkflowCommandRegistration,
  start: StartWorkflowCommand,
): void {
  registerWorkflowCommand(
    pi,
    "wf-hotfix",
    "hotfix",
    "Start a hotfix workflow",
    start,
  );
}
