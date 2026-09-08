import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTools } from "./tools";

export default function piWorkflow(pi: ExtensionAPI): void {
  registerTools(pi);
}
