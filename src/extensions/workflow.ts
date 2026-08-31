import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkflowRuntime } from "../bootstrap/create-workflow-runtime.js";
import { registerWorkflowCommands } from "./commands/register-workflow-commands.js";

export default function workflowExtension(pi: Pick<ExtensionAPI, "registerCommand">): void {
  registerWorkflowCommands(pi, createWorkflowRuntime());
}
