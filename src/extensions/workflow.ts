import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createPiUserInteraction,
  createWorkflowRuntime,
  type WorkflowRuntimeDependencies,
} from "../bootstrap/create-workflow-runtime.js";
import { registerVerificationCommandTool } from "../adapters/pi/verification-command-tool.js";
import { registerWorkflowCommands } from "./commands/register-workflow-commands.js";

export default function workflowExtension(
  pi: Pick<ExtensionAPI, "registerCommand"> &
    Partial<Pick<ExtensionAPI, "events" | "getAllTools" | "registerTool">>,
  dependencies: WorkflowRuntimeDependencies = {},
): void {
  if (pi.registerTool !== undefined) {
    registerVerificationCommandTool({ registerTool: pi.registerTool });
  }

  const runtimeDependencies =
    pi.events === undefined
      ? dependencies
      : {
          ...dependencies,
          pi: {
            events: pi.events,
            ...(pi.getAllTools === undefined ? {} : { getAllTools: () => pi.getAllTools!() }),
          },
        };
  registerWorkflowCommands(pi, createWorkflowRuntime(runtimeDependencies), createPiUserInteraction);
}
