import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerVerificationCommandTool } from "./verification-command-tool.js";

export default function verificationCommandExtension(pi: Pick<ExtensionAPI, "registerTool">): void {
  registerVerificationCommandTool(pi);
}
