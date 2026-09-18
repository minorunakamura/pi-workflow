import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCommands } from "./commands/index.ts";
import { registerSessionLifecycle } from "./events/index.ts";
import { createRootWorkflowRegistry } from "./runtime/root-lifecycle.ts";
import { SubagentRpcAdapter } from "./runtime/subagents-rpc.ts";

export function isSubagentChildRuntime(
  marker = process.env.PI_SUBAGENT_CHILD,
): boolean {
  return marker === "1";
}

type RootExtensionAPI = Pick<
  ExtensionAPI,
  "on" | "appendEntry" | "registerCommand" | "events"
>;

export default function extension(pi: RootExtensionAPI): void {
  if (isSubagentChildRuntime()) {
    return;
  }

  const registry = createRootWorkflowRegistry(pi);
  const rpc = new SubagentRpcAdapter(pi.events);
  registerCommands(pi, registry, rpc);
  registerSessionLifecycle(
    pi,
    registry,
    () => {
      rpc.dispose();
    },
    (runId) => rpc.stop(runId),
    async () => {
      const request = registry.getActiveWorkflowRequest();
      if (request === undefined) {
        throw new Error("Active workflow request is unavailable");
      }
      return rpc.spawnPlanningCoordinator(request);
    },
  );
}
