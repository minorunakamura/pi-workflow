import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { PlanningDecisionSchema } from "../core/planning/planning-decision-schema";
import {
  runPlanReview,
  type PlanReviewOutput,
} from "../runtime/plannotator/plan-review";

const PlanReviewInputSchema = Type.Object(
  {
    missionId: Type.String({
      minLength: 1,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
    }),
    planningDecision: PlanningDecisionSchema,
    round: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export type PlanReviewInput = Static<typeof PlanReviewInputSchema>;

export function createPlanReviewTool(pi: ExtensionAPI) {
  return defineTool<typeof PlanReviewInputSchema, PlanReviewOutput>({
    name: "pi_workflow_plan_review",
    label: "Review pi-workflow Plan",
    description:
      "Validate a PlanningDecisionV1, write its canonical plan.md, and wait for explicit Plannotator Plan approval.",
    parameters: PlanReviewInputSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await runPlanReview(pi, ctx.cwd, params, signal);
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
