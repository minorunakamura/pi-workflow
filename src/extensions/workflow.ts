import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createPiUserInteraction,
  createWorkflowRuntime,
  type WorkflowRuntimeDependencies,
} from "../bootstrap/create-workflow-runtime.js";
import { registerWorkflowCommands } from "./commands/register-workflow-commands.js";

export default function workflowExtension(
  pi: Pick<ExtensionAPI, "registerCommand">,
  dependencies: WorkflowRuntimeDependencies = {},
): void {
  registerWorkflowCommands(pi, createWorkflowRuntime(dependencies), createPiUserInteraction);
}
