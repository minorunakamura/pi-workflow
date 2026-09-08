import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands";
import { registerTools } from "./tools";

export default function piWorkflow(pi: ExtensionAPI): void {
  registerCommands(pi);
  registerTools(pi);
}
