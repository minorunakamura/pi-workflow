import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { RootWorkflowRegistry } from "../runtime/root-lifecycle.ts";

export function beforeTreeNavigation(
  registry: RootWorkflowRegistry,
): { cancel: true } | undefined {
  return registry.hasActiveWorkflow() ? { cancel: true } : undefined;
}

export function registerSessionLifecycle(
  pi: Pick<ExtensionAPI, "on">,
  registry: RootWorkflowRegistry,
): void {
  pi.on("session_start", (_event, ctx) => {
    registry.restore(ctx.sessionManager.getBranch());
  });

  pi.on("session_before_tree", () => beforeTreeNavigation(registry));

  pi.on("session_tree", (_event, ctx) => {
    registry.restore(ctx.sessionManager.getBranch());
  });

  pi.on("session_shutdown", () => {
    registry.shutdown();
  });
}
