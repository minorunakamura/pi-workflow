import { startWorkflow } from "../runtime/start-workflow.ts";
import type { PlanningCoordinatorLaunchResult } from "../runtime/subagents-rpc.ts";
import type { WorkflowRequest } from "../core/index.ts";
import type { RootWorkflowRegistry } from "../runtime/root-lifecycle.ts";
import { registerWfBugCommand } from "./wf-bug.ts";
import { registerWfChoreCommand } from "./wf-chore.ts";
import { registerWfFeatureCommand } from "./wf-feature.ts";
import { registerWfHotfixCommand } from "./wf-hotfix.ts";
import type { StartWorkflowCommand } from "./register-workflow-command.ts";
import type { WorkflowCommandRegistration } from "./register-workflow-command.ts";

export type PlanningCoordinatorLauncher = {
  spawnPlanningCoordinator: (
    request: WorkflowRequest,
  ) => Promise<PlanningCoordinatorLaunchResult>;
};

export function registerCommands(
  pi: WorkflowCommandRegistration,
  registry: RootWorkflowRegistry,
  planningCoordinator?: PlanningCoordinatorLauncher,
): void {
  const start: StartWorkflowCommand = async (
    workflowType,
    request,
    context,
  ) => {
    const result = startWorkflow(registry, workflowType, request, context);
    if (!result.started || planningCoordinator === undefined) return;

    try {
      const launch = await planningCoordinator.spawnPlanningCoordinator(
        result.request,
      );
      const attached = registry.setPlanningRunId(launch.runId);
      if (!attached.transitioned) throw new Error(attached.reason);
    } catch {
      registry.transition("FAILED");
      context.ui.notify("Could not start the Planning Coordinator.", "error");
    }
  };

  registerWfFeatureCommand(pi, start);
  registerWfBugCommand(pi, start);
  registerWfChoreCommand(pi, start);
  registerWfHotfixCommand(pi, start);
}
