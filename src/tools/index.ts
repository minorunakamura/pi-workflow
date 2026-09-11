import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPlanReviewTool } from "./plan-review";

export function registerTools(pi: ExtensionAPI): void {
  registerPlanReviewTool(pi);
}
