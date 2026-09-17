import { startWorkflow } from "../runtime/start-workflow.ts";
import type { PlanningCoordinatorLaunchResult } from "../runtime/subagents-rpc.ts";
import type { WorkflowRequest } from "../core/index.ts";
import type { RootWorkflowRegistry } from "../runtime/root-lifecycle.ts";
import type { ResultDeliveryPreflightResult } from "../runtime/result-delivery.ts";
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
  stop: (runId: string) => Promise<unknown>;
  preflightResultDelivery: () => ResultDeliveryPreflightResult;
};

export function registerCommands(
  pi: WorkflowCommandRegistration,
  registry: RootWorkflowRegistry,
  planningCoordinator: PlanningCoordinatorLauncher,
): void {
  const start: StartWorkflowCommand = async (
    workflowType,
    request,
    context,
  ) => {
    const result = startWorkflow(registry, workflowType, request, context, () =>
      planningCoordinator.preflightResultDelivery(),
    );
    if (!result.started) return;

    try {
      const launch = await planningCoordinator.spawnPlanningCoordinator(
        result.request,
      );
      const attached = registry.setPlanningRunId(launch.runId);
      if (!attached.transitioned) {
        try {
          await planningCoordinator.stop(launch.runId);
        } catch {
          // Stop is best-effort; the Root result remains failed.
        }
        registry.transition("FAILED");
        context.ui.notify("Could not start the Planning Coordinator.", "error");
      }
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
