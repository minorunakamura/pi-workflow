import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { MAX_PLAN_REVIEW_ROUNDS } from "../core/state/contracts";
import { ReferenceValueSchema } from "../core/state/references";
import {
  runPlanReview,
  type PlanReviewOutput,
} from "../runtime/plannotator/plan-review";

const PlanReviewInputSchema = Type.Object(
  {
    missionId: ReferenceValueSchema,
    round: Type.Integer({ minimum: 1, maximum: MAX_PLAN_REVIEW_ROUNDS }),
    planRef: ReferenceValueSchema,
  },
  { additionalProperties: false },
);

export type PlanReviewInput = Static<typeof PlanReviewInputSchema>;

export function createPlanReviewTool(pi: ExtensionAPI) {
  return defineTool<typeof PlanReviewInputSchema, PlanReviewOutput>({
    name: "pi_workflow_plan_review",
    label: "Review pi-workflow Plan",
    description:
      "Open the canonical Plan Artifact referenced by planRef for explicit Plannotator approval.",
    parameters: PlanReviewInputSchema,
    async execute(_toolCallId, params, signal) {
      const result = await runPlanReview(pi, params, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}

export function registerPlanReviewTool(pi: ExtensionAPI): void {
  pi.registerTool(createPlanReviewTool(pi));
}
