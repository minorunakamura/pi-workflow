import { describe, expect, it, vi } from "vitest";
import researcherTools, {
  createResearchSearchTool,
} from "../../src/researcher-tools";

function createExecution() {
  const exec = vi.fn().mockResolvedValue({
    stdout: "[]",
    stderr: "",
    code: 0,
    killed: false,
  });
  return {
    tool: createResearchSearchTool({ exec }),
    exec,
  };
}

describe("pi_workflow_ketch_search", () => {
  it("registers only the pi-workflow-owned search tool", () => {
    const registered: { name: string }[] = [];
    researcherTools({
      registerTool: (registeredTool: { name: string }) =>
        registered.push(registeredTool),
      exec: vi.fn(),
    } as never);

    expect(registered.map(({ name }) => name)).toEqual([
      "pi_workflow_ketch_search",
    ]);
  });

  it("exposes only query and backend", () => {
    const { tool } = createExecution();

    expect(Object.keys(tool.parameters.properties)).toEqual([
      "query",
      "backend",
    ]);
    expect(tool.parameters.additionalProperties).toBe(false);
  });

  it("maps omitted and selected backends to configured and single providers", async () => {
    const configured = createExecution();
    await configured.tool.execute(
      "call-configured",
      { query: "  pi extensions  " },
      undefined,
      undefined,
      { cwd: "/tmp/project" } as never,
    );
    expect(configured.exec).toHaveBeenCalledWith(
      "ketch",
      ["search", "pi extensions", "--json"],
      expect.objectContaining({ cwd: "/tmp/project" }),
    );

    const single = createExecution();
    await single.tool.execute(
      "call-single",
      { query: "pi", backend: " brave " },
      undefined,
      undefined,
      { cwd: "/tmp/project" } as never,
    );
    expect(single.exec).toHaveBeenCalledWith(
      "ketch",
      ["search", "pi", "--backend", "brave", "--json"],
      expect.objectContaining({ cwd: "/tmp/project" }),
    );
  });

  it.each(["brave,ddg", "all", "random", "unknown"])(
    "rejects %s without executing a non-single search",
    async (backend) => {
      const execution = createExecution();

      await expect(
        execution.tool.execute(
          "call-invalid",
          { query: "pi", backend },
          undefined,
          undefined,
          { cwd: "/tmp/project" } as never,
        ),
      ).rejects.toThrow("[validation] backend");
      expect(execution.exec).not.toHaveBeenCalled();
    },
  );

  it("rejects blank queries before execution", async () => {
    const execution = createExecution();

    await expect(
      execution.tool.execute(
        "call-blank",
        { query: "   " },
        undefined,
        undefined,
        { cwd: "/tmp/project" } as never,
      ),
    ).rejects.toMatchObject({ code: "validation" });
    expect(execution.exec).not.toHaveBeenCalled();
  });
});
