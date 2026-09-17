import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { RootWorkflowRegistry } from "../runtime/root-lifecycle.ts";
import { registerSubagentLifecycleObservation } from "../runtime/subagents-rpc.ts";

const PLANNING_FAILURE_STATES = new Set([
  "failed",
  "partial",
  "paused",
  "stopped",
  "rejected",
]);

export function registerSubagentLifecycle(
  pi: Pick<ExtensionAPI, "events">,
  registry: RootWorkflowRegistry,
  sessionId?: string,
): () => void {
  return registerSubagentLifecycleObservation(pi.events, {
    ...(sessionId === undefined ? {} : { sessionId }),
    isRelevantRun: (runId) => registry.getState()?.planningRunId === runId,
    onComplete: (record) => {
      const state = registry.getState();
      if (state?.planningRunId !== record.runId) return;
      if (
        record.success === false ||
        PLANNING_FAILURE_STATES.has(record.state ?? "")
      ) {
        registry.transition("FAILED");
      }
    },
    onConflict: (runId) => {
      if (registry.getState()?.planningRunId === runId) {
        registry.transition("FAILED");
      }
    },
  });
}

export function beforeTreeNavigation(
  registry: RootWorkflowRegistry,
): { cancel: true } | undefined {
  return registry.hasActiveWorkflow() ? { cancel: true } : undefined;
}

export function registerSessionLifecycle(
  pi: Pick<ExtensionAPI, "on"> & Partial<Pick<ExtensionAPI, "events">>,
  registry: RootWorkflowRegistry,
  cleanup?: () => void,
  stopPlanningCoordinator?: (runId: string) => Promise<unknown>,
): void {
  let removeLifecycleObservation: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    removeLifecycleObservation?.();
    registry.restore(ctx.sessionManager.getBranch());
    const events = pi.events;
    if (events !== undefined) {
      removeLifecycleObservation = registerSubagentLifecycle(
        { events },
        registry,
        ctx.sessionManager.getSessionId(),
      );
    }
  });

  pi.on("session_before_tree", () => beforeTreeNavigation(registry));

  pi.on("session_tree", (_event, ctx) => {
    registry.restore(ctx.sessionManager.getBranch());
  });

  pi.on("session_shutdown", async () => {
    const current = registry.getState();
    const planningRunId = registry.hasActiveWorkflow()
      ? current?.planningRunId
      : undefined;
    if (planningRunId !== undefined && stopPlanningCoordinator !== undefined) {
      try {
        await stopPlanningCoordinator(planningRunId);
      } catch {
        // Shutdown remains fail-closed when the public stop request fails.
      }
    }

    try {
      registry.shutdown();
    } finally {
      try {
        removeLifecycleObservation?.();
      } finally {
        removeLifecycleObservation = undefined;
        cleanup?.();
      }
    }
  });
}
