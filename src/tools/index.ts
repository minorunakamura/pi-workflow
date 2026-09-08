import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPreparePhaseTool } from "./prepare-phase";

export function registerTools(pi: ExtensionAPI): void {
  registerPreparePhaseTool(pi);
}
