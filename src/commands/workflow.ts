import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const WORKFLOW_REQUEST_TYPES = [
  "feature",
  "bug",
  "chore",
  "hotfix",
] as const;

export type WorkflowRequestType = (typeof WORKFLOW_REQUEST_TYPES)[number];

export function buildWorkflowKickoff(
  type: WorkflowRequestType,
  request: string,
): string {
  return [
    "Run pi-workflow.",
    `Request type: ${type}`,
    `Request: ${request}`,
    "Follow the pi-workflow Skill as the Main Session control-plane policy.",
    "Use the model-facing subagent tool and stop after an explicit Plannotator Plan approval.",
  ].join("\n");
}

export function registerWorkflowCommand(
  pi: ExtensionAPI,
  type: WorkflowRequestType,
): void {
  pi.registerCommand(`wf-${type}`, {
    description: `Start a ${type} pi-workflow planning flow`,
    handler: async (args, ctx) => {
      const request = args.trim();
      if (!request) {
        ctx.ui.notify(`Usage: /wf-${type} <request>`, "error");
        return;
      }

      pi.sendUserMessage(buildWorkflowKickoff(type, request));
    },
  });
}

export function registerWorkflowCommands(pi: ExtensionAPI): void {
  for (const type of WORKFLOW_REQUEST_TYPES) {
    registerWorkflowCommand(pi, type);
  }
}
