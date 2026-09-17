import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { RootWorkflowRegistry } from "../runtime/root-lifecycle.ts";

export function registerSessionLifecycle(
  pi: Pick<ExtensionAPI, "on">,
  registry: RootWorkflowRegistry,
): void {
  pi.on("session_start", (_event, ctx) => {
    registry.restore(ctx.sessionManager.getBranch());
  });

  pi.on("session_shutdown", () => {
    registry.shutdown();
  });
}
