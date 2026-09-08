import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowCommands } from "./workflow";

export function registerCommands(pi: ExtensionAPI): void {
  registerWorkflowCommands(pi);
}
