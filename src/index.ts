import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerSessionLifecycle } from "./events/index.ts";
import { createRootWorkflowRegistry } from "./runtime/root-lifecycle.ts";

export default function extension(pi: ExtensionAPI): void {
  const registry = createRootWorkflowRegistry(pi);
  registerSessionLifecycle(pi, registry);
}
