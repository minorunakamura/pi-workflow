import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCommands } from "./commands/index.ts";
import { registerSessionLifecycle } from "./events/index.ts";
import { createRootWorkflowRegistry } from "./runtime/root-lifecycle.ts";

export function isSubagentChildRuntime(
  marker = process.env.PI_SUBAGENT_CHILD,
): boolean {
  return marker === "1";
}

type RootExtensionAPI = Pick<
  ExtensionAPI,
  "on" | "appendEntry" | "registerCommand"
>;

export default function extension(pi: RootExtensionAPI): void {
  if (isSubagentChildRuntime()) {
    return;
  }

  const registry = createRootWorkflowRegistry(pi);
  registerCommands(pi, registry);
  registerSessionLifecycle(pi, registry);
}
