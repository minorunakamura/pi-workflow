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
): () => void {
  return registerSubagentLifecycleObservation(pi.events, {
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
  pi: Pick<ExtensionAPI, "on">,
  registry: RootWorkflowRegistry,
  cleanup?: () => void,
): void {
  pi.on("session_start", (_event, ctx) => {
    registry.restore(ctx.sessionManager.getBranch());
  });

  pi.on("session_before_tree", () => beforeTreeNavigation(registry));

  pi.on("session_tree", (_event, ctx) => {
    registry.restore(ctx.sessionManager.getBranch());
  });

  pi.on("session_shutdown", () => {
    try {
      registry.shutdown();
    } finally {
      cleanup?.();
    }
  });
}
