import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createPiUserInteraction,
  createWorkflowRuntime,
  type WorkflowRuntimeDependencies,
} from "../bootstrap/create-workflow-runtime.js";
import { registerWorkflowCommands } from "./commands/register-workflow-commands.js";

export default function workflowExtension(
  pi: Pick<ExtensionAPI, "registerCommand"> & Partial<Pick<ExtensionAPI, "events" | "getAllTools">>,
  dependencies: WorkflowRuntimeDependencies = {},
): void {
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
