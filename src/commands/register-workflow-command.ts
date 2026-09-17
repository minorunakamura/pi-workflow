import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import type { WorkflowType } from "../core/index.ts";

export type WorkflowCommandRegistration = Pick<ExtensionAPI, "registerCommand">;

export type StartWorkflowCommand = (
  workflowType: WorkflowType,
  request: string,
  context: ExtensionCommandContext,
) => void | Promise<void>;

export function registerWorkflowCommand(
  pi: WorkflowCommandRegistration,
  command: string,
  workflowType: WorkflowType,
  description: string,
  start: StartWorkflowCommand,
): void {
  pi.registerCommand(command, {
    description,
    handler: async (args, context) => {
      const request = args.trim();
      if (request.length === 0) {
        context.ui.notify("Workflow request is required.", "error");
        return;
      }
      await start(workflowType, request, context);
    },
  });
}
