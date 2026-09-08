import { describe, expect, it } from "vitest";
import { preparePhaseTool } from "../../src/tools/prepare-phase";
import { registerTools } from "../../src/tools";

const input = {
  phase: "discovery" as const,
  payload: {
    task: "Inspect the repository.",
    outputSchema: { type: "object" },
  },
};

describe("pi_workflow_prepare_phase", () => {
  it("exposes only phase and payload parameters", () => {
    expect(Object.keys(preparePhaseTool.parameters.properties)).toEqual([
      "phase",
      "payload",
    ]);
    expect(preparePhaseTool.parameters.additionalProperties).toBe(false);
  });

  it("renders a validated phase without accepting a template path", async () => {
    const result = await preparePhaseTool.execute(
      "tool-call",
      input,
      new AbortController().signal,
      () => undefined,
      {} as never,
    );

    expect(result).not.toHaveProperty("isError");
    expect(result.details).toMatchObject({ phase: "discovery" });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(
      result.content[0].type === "text" && result.content[0].text,
    ).toContain("workflowScript");
  });

  it("returns an error for a payload that does not match the phase contract", async () => {
    await expect(
      preparePhaseTool.execute(
        "tool-call",
        {
          phase: "research",
          payload: {
            task: "Research the primary source.",
            templatePath: "./unsafe.js",
          },
        },
        new AbortController().signal,
        () => undefined,
        {} as never,
      ),
    ).rejects.toThrow();
  });

  it("registers one foundation tool", () => {
    const registered: unknown[] = [];
    registerTools({
      registerTool: (tool: unknown) => registered.push(tool),
    } as never);

    expect(registered).toHaveLength(1);
    expect((registered[0] as { name: string }).name).toBe(
      "pi_workflow_prepare_phase",
    );
  });
});
