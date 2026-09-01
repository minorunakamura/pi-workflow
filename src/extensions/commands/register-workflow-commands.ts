import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  WorkflowCommand,
  WorkflowCommandHandler,
} from "../../application/workflow-command-handler.js";

export const WORKFLOW_COMMANDS = [
  { name: "wf-feature", command: "feature", description: "Start a feature workflow." },
  { name: "wf-bug", command: "bug", description: "Start a bug workflow." },
  { name: "wf-hotfix", command: "hotfix", description: "Start a hotfix workflow." },
  { name: "wf-chore", command: "chore", description: "Start a chore workflow." },
  { name: "wf-refactor", command: "refactor", description: "Start a refactor workflow." },
  {
    name: "wf-investigation",
    command: "investigation",
    description: "Start an investigation workflow.",
  },
  { name: "wf-status", command: "status", description: "Show workflow status." },
  { name: "wf-resume", command: "resume", description: "Resume a workflow." },
  { name: "wf-cancel", command: "cancel", description: "Cancel a workflow." },
] as const satisfies ReadonlyArray<{
  name: string;
  command: WorkflowCommand;
  description: string;
}>;

export function registerWorkflowCommands(
  pi: Pick<ExtensionAPI, "registerCommand">,
  handler: WorkflowCommandHandler,
): void {
  for (const command of WORKFLOW_COMMANDS) {
    pi.registerCommand(command.name, {
      description: command.description,
      handler: async (args, context) => {
        try {
          const output = await handler.execute(command.command, args);
          if (output !== undefined) context.ui.notify(output, "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          context.ui.notify(message, "error");
        }
      },
    });
  }
}
