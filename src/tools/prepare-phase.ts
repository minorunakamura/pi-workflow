import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { renderPhase } from "../core/phases/render-phase";
import type { PreparedPhase } from "../core/phases/render-phase";

const PreparePhaseInputSchema = Type.Object(
  {
    phase: Type.Union([
      Type.Literal("discovery"),
      Type.Literal("research"),
      Type.Literal("planning"),
      Type.Literal("implementation"),
      Type.Literal("verification"),
      Type.Literal("verification-fix"),
      Type.Literal("review"),
    ]),
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

export type PreparePhaseInput = Static<typeof PreparePhaseInputSchema>;

export const preparePhaseTool = defineTool<
  typeof PreparePhaseInputSchema,
  PreparedPhase
>({
  name: "pi_workflow_prepare_phase",
  label: "Prepare Pi Workflow Phase",
  description:
    "Render one allowlisted pi-workflow phase script from validated JSON input.",
  parameters: PreparePhaseInputSchema,
  async execute(_toolCallId, params) {
    const prepared = renderPhase(params.phase, params.payload);
    return {
      content: [{ type: "text", text: JSON.stringify(prepared) }],
      details: prepared,
    };
  },
});

export function registerPreparePhaseTool(pi: ExtensionAPI): void {
  pi.registerTool(preparePhaseTool);
}
