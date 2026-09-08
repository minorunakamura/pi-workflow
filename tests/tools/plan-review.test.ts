import { describe, expect, it } from "vitest";
import { createPlanReviewTool } from "../../src/tools/plan-review";
import { registerTools } from "../../src/tools";

const decision = {
  version: 1 as const,
  requestSummary: "Add a search endpoint.",
  scope: { inScope: ["endpoint"], outOfScope: ["UI"] },
  acceptanceCriteria: [{ id: "ac-1", text: "Search works." }],
  constraints: [],
  risks: [],
  verification: [
    { id: "verify-1", description: "Tests pass.", command: "pnpm test" },
  ],
  implementation: {
    mode: "single" as const,
    workUnits: [
      {
        id: "unit-1",
        title: "Implement endpoint",
        objective: "Add endpoint.",
        dependsOn: [],
        writeScope: ["src/api.ts"],
        acceptanceCriteriaIds: ["ac-1"],
        focusedVerificationIds: ["verify-1"],
      },
    ],
    finalVerificationIds: ["verify-1"],
  },
  unresolvedDecisions: [],
};

describe("pi_workflow_plan_review", () => {
  it("exposes the declared input contract", () => {
    const tool = createPlanReviewTool({} as never);

    expect(Object.keys(tool.parameters.properties)).toEqual([
      "missionId",
      "planningDecision",
      "round",
    ]);
    expect(tool.parameters.additionalProperties).toBe(false);
  });

  it("registers beside the phase preparation tool", () => {
    const registered: unknown[] = [];
    registerTools({
      registerTool: (tool: unknown) => registered.push(tool),
    } as never);

    expect(registered.map((tool) => (tool as { name: string }).name)).toEqual([
      "pi_workflow_prepare_phase",
      "pi_workflow_plan_review",
    ]);
  });

  it("delegates execution to the runtime boundary", async () => {
    const responses: unknown[] = [];
    const tool = createPlanReviewTool({
      events: {
        emit: (_channel: string, data: unknown) => {
          const request = data as {
            action: string;
            respond: (response: unknown) => void;
          };
          responses.push(request.action);
          if (request.action === "plan-review") {
            request.respond({
              status: "handled",
              result: { status: "pending", reviewId: "tool-review" },
            });
            return;
          }
          request.respond({
            status: "handled",
            result: {
              status: "completed",
              reviewId: "tool-review",
              approved: true,
            },
          });
        },
        on: () => () => undefined,
      },
    } as never);

    const result = await tool.execute(
      "tool-call",
      { missionId: "mission-tool", planningDecision: decision, round: 1 },
      new AbortController().signal,
      undefined,
      { cwd: "/tmp" } as never,
    );

    expect(result.details).toMatchObject({ approved: true });
    expect(responses).toEqual(["plan-review", "review-status"]);
  });
});
