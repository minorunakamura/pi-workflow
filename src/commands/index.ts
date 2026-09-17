import { startWorkflow } from "../runtime/start-workflow.ts";
import type { RootWorkflowRegistry } from "../runtime/root-lifecycle.ts";
import { registerWfBugCommand } from "./wf-bug.ts";
import { registerWfChoreCommand } from "./wf-chore.ts";
import { registerWfFeatureCommand } from "./wf-feature.ts";
import { registerWfHotfixCommand } from "./wf-hotfix.ts";
import type { StartWorkflowCommand } from "./register-workflow-command.ts";
import type { WorkflowCommandRegistration } from "./register-workflow-command.ts";

export function registerCommands(
  pi: WorkflowCommandRegistration,
  registry: RootWorkflowRegistry,
): void {
  const start: StartWorkflowCommand = (workflowType, request, context) => {
    startWorkflow(registry, workflowType, request, context);
  };

  registerWfFeatureCommand(pi, start);
  registerWfBugCommand(pi, start);
  registerWfChoreCommand(pi, start);
  registerWfHotfixCommand(pi, start);
}
