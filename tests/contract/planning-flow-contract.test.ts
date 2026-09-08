import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}/${path}`, "utf8");
}

describe("Planning Flow contract", () => {
  it("keeps commands as Main-session kickoff adapters", () => {
    const source = read("src/commands/workflow.ts");

    expect(source).toContain("pi.sendUserMessage");
    expect(source).not.toContain("pi-subagents");
    expect(source).not.toContain("mission.create");
    expect(source).not.toContain("workflowScript");
  });

  it("keeps external ownership out of the package runtime", () => {
    const runtime = read("src/runtime/plannotator/request.ts");
    const planReview = read("src/runtime/plannotator/plan-review.ts");

    expect(runtime).not.toContain("@plannotator");
    expect(runtime).not.toContain("pi-subagents");
    expect(planReview).not.toContain("@plannotator");
    expect(planReview).not.toContain("pi-subagents");
  });

  it("contains native Planning Flow roles in phase templates", () => {
    expect(read("workflow-scripts/discovery.js")).toContain('agent: "scout"');
    expect(read("workflow-scripts/research.js")).toContain(
      'agent: "pi-ketch.researcher"',
    );
    expect(read("workflow-scripts/planning.js")).toContain('agent: "reviewer"');
    expect(read("workflow-scripts/planning.js")).toContain(
      'skill: "pi-planning"',
    );
  });

  it("persists phase evidence through native Mission state", () => {
    expect(read("workflow-scripts/discovery.js")).toContain(
      'await state.set("discovery", discovery)',
    );
    expect(read("workflow-scripts/discovery.js")).toContain(
      "result: result.structuredOutput",
    );
    expect(read("workflow-scripts/research.js")).toContain(
      'await state.set("research", research)',
    );
    expect(read("workflow-scripts/planning.js")).toContain(
      'await state.set("planningDecision", planningDecision)',
    );
  });

  it("does not add custom Agents", () => {
    expect(existsSync(`${repoRoot}/agents`)).toBe(false);
  });
});
