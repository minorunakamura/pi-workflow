import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlanReviewTool } from "../../src/tools/plan-review";
import { registerTools } from "../../src/tools";

async function planFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-workflow-tool-plan-"));
  const path = join(directory, "plan.md");
  await writeFile(path, "# Plan\n\ncanonical\n", "utf8");
  return path;
}

describe("pi_workflow_plan_review", () => {
  it("exposes only the reference-centric input contract", () => {
    const tool = createPlanReviewTool({} as never);

    expect(Object.keys(tool.parameters.properties)).toEqual([
      "missionId",
      "round",
      "planRef",
    ]);
    expect(tool.parameters.additionalProperties).toBe(false);
  });

  it("rejects body, path, script, and unknown fields", async () => {
    const tool = createPlanReviewTool({} as never);
    for (const field of [
      "planningDecision",
      "planContent",
      "planPath",
      "feedbackText",
      "outputPath",
      "workflowScript",
      "unknown",
    ]) {
      await expect(
        tool.execute(
          "tool-call",
          {
            missionId: "mission-tool",
            round: 1,
            planRef: "plan-ref",
            [field]: "not allowed",
          } as never,
          new AbortController().signal,
          undefined,
          { cwd: "/tmp" } as never,
        ),
      ).rejects.toThrow("unknown fields");
    }
  });

  it("registers the Planning MVP review tool", () => {
    const registered: unknown[] = [];
    registerTools({
      registerTool: (tool: unknown) => registered.push(tool),
    } as never);

    expect(registered.map((tool) => (tool as { name: string }).name)).toEqual([
      "pi_workflow_plan_review",
    ]);
  });

  it("delegates execution without transporting a PlanningDecision or Plan body", async () => {
    const planRef = await planFile();
    const responses: unknown[] = [];
    const listeners = new Set<(data: unknown) => void>();
    const tool = createPlanReviewTool({
      events: {
        emit: (_channel: string, data: unknown) => {
          const request = data as {
            action: string;
            payload: Record<string, unknown>;
            respond: (response: unknown) => void;
          };
          responses.push(request.action);
          if (request.action === "plan-review") {
            request.respond({
              status: "handled",
              result: { status: "pending", reviewId: "tool-review" },
            });
            setTimeout(() => {
              for (const listener of listeners) {
                listener({ reviewId: "tool-review", approved: true });
              }
            }, 0);
            return;
          }
        },
        on: (_channel: string, handler: (data: unknown) => void) => {
          listeners.add(handler);
          return () => listeners.delete(handler);
        },
      },
    } as never);

    const result = await tool.execute(
      "tool-call",
      { missionId: "mission-tool", round: 1, planRef },
      new AbortController().signal,
      undefined,
      { cwd: "/tmp" } as never,
    );

    expect(result.details).toEqual({
      approved: true,
      reviewId: "tool-review",
      planRef,
    });
    expect(JSON.stringify(result.details)).not.toContain("canonical");
    expect(responses).toEqual(["plan-review"]);
  });
});
