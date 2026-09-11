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

  it("deduplicates normalized exact searches while allowing material changes", async () => {
    const execution = createExecution();
    const context = { cwd: "/tmp/project" } as never;

    await execution.tool.execute(
      "call-first",
      { query: " Pi extensions " },
      undefined,
      undefined,
      context,
    );
    await expect(
      execution.tool.execute(
        "call-whitespace-duplicate",
        { query: "Pi extensions" },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toMatchObject({
      name: "ResearchSearchGuardError",
      code: "duplicate_search",
    });

    await execution.tool.execute(
      "call-different-query",
      { query: "Pi extensions API" },
      undefined,
      undefined,
      context,
    );
    await execution.tool.execute(
      "call-different-backend",
      { query: "Pi extensions", backend: " brave " },
      undefined,
      undefined,
      context,
    );
    await expect(
      execution.tool.execute(
        "call-backend-duplicate",
        { query: "Pi extensions", backend: "brave" },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toMatchObject({
      name: "ResearchSearchGuardError",
      code: "duplicate_search",
    });
    await execution.tool.execute(
      "call-other-backend",
      { query: "Pi extensions", backend: "ddg" },
      undefined,
      undefined,
      context,
    );

    expect(execution.exec).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["validation", { stdout: "", stderr: "bad query", code: 2 }],
    ["precondition", { stdout: "", stderr: "missing config", code: 5 }],
    ["invalid_output", { stdout: "{}", stderr: "", code: 0 }],
  ] as const)(
    "suppresses an unchanged %s failure after one execution",
    async (code, response) => {
      const execution = createExecution();
      execution.exec.mockResolvedValue(response);
      const context = { cwd: "/tmp/project" } as never;

      await expect(
        execution.tool.execute(
          "call-failure",
          { query: "same failed search" },
          undefined,
          undefined,
          context,
        ),
      ).rejects.toMatchObject({ code });
      await expect(
        execution.tool.execute(
          "call-retry",
          { query: " same failed search " },
          undefined,
          undefined,
          context,
        ),
      ).rejects.toMatchObject({
        name: "ResearchSearchGuardError",
        code: "failed_search",
      });

      expect(execution.exec).toHaveBeenCalledTimes(1);
    },
  );

  it("does not automatically retry transient failures", async () => {
    const execution = createExecution();
    execution.exec.mockResolvedValue({
      stdout: "",
      stderr: "upstream unavailable",
      code: 4,
    });

    await expect(
      execution.tool.execute(
        "call-upstream-failure",
        { query: "transient search" },
        undefined,
        undefined,
        { cwd: "/tmp/project" } as never,
      ),
    ).rejects.toMatchObject({ code: "upstream" });

    expect(execution.exec).toHaveBeenCalledTimes(1);
  });

  it("propagates cancellation without converting it to a retry", async () => {
    const controller = new AbortController();
    const execution = createExecution();
    execution.exec.mockImplementation(async () => {
      controller.abort();
      return { stdout: "[]", stderr: "", code: 0, killed: false };
    });

    await expect(
      execution.tool.execute(
        "call-cancelled",
        { query: "cancelled search" },
        controller.signal,
        undefined,
        { cwd: "/tmp/project" } as never,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(execution.exec).toHaveBeenCalledTimes(1);
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
