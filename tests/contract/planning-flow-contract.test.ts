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

  it("requires validation of the exact rendered script before launch", () => {
    const skill = read("skills/pi-workflow/SKILL.md");

    expect(skill).toContain('subagent({ action: "validate", workflowScript })');
    expect(skill).toContain("byte-for-byte identical");
    expect(skill).toContain("stop without launching the phase");
    expect(skill).toContain("injects the package-owned");
  });

  it("dispatches migrated Discovery through its named resource", () => {
    const skill = read("skills/pi-workflow/SKILL.md");

    expect(skill).toContain('workflow: "pi-workflow.discovery"');
    expect(skill).toContain("async: false");
    expect(skill).toContain(
      "The resource owns the full investigation, metadata schema, output",
    );
    expect(skill).toContain("read `discoveryRef` and `discoveryMeta`");
    expect(skill).not.toContain('Prepare `phase: "discovery"');
  });

  it("dispatches conditional Research through its named resource", () => {
    const skill = read("skills/pi-workflow/SKILL.md");
    const research = read("workflow-scripts/research.js");

    expect(skill).toContain("discoveryMeta.externalResearchRequired === true");
    expect(skill).toContain('workflow: "pi-workflow.research"');
    expect(skill).toContain("args: { attempt: 1 }");
    expect(skill).toContain("control-only skip path");
    expect(skill).toContain('researchMeta.status === "skipped"');
    expect(skill).not.toContain('Prepare `phase: "research"');
    expect(research).toContain(
      'if (input.resource === "pi-workflow.research")',
    );
    expect(research).toContain('agent: "pi-ketch.researcher"');
    expect(research).toContain("async: false");
  });

  it("keeps clarification Main-only and fail-closed", () => {
    const skill = read("skills/pi-workflow/SKILL.md");
    const research = read("workflow-scripts/research.js");

    expect(skill).toContain("### Main-only Human clarification");
    expect(skill).toContain("`ask_user_question` capability");
    expect(skill).toContain(
      "When it is `false`, do not invoke `ask_user_question`",
    );
    expect(skill).toContain("details.cancelled === false");
    expect(skill).toContain("never invent `No`, `Skip`, `Continue`");
    expect(skill).toContain(
      "Children, including Discovery and Research resources",
    );
    expect(research).not.toContain("ask_user_question");
    expect(research).not.toContain("Plannotator");
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
    expect(read("workflow-scripts/planning.js")).toContain(
      "outputSchema: input.outputSchema",
    );
    expect(read("workflow-scripts/planning.js")).toContain(
      "planning-correction",
    );
    expect(read("workflow-scripts/planning.js")).toContain("planning-invalid");
  });

  it("persists phase evidence through native Mission state", () => {
    expect(read("workflow-scripts/discovery.js")).toContain(
      'await state.set("phase", "discovery")',
    );
    expect(read("workflow-scripts/discovery.js")).toContain(
      'await state.set("discovery", discovery)',
    );
    expect(read("workflow-scripts/discovery.js")).toContain(
      "result: result.structuredOutput",
    );
    expect(read("workflow-scripts/research.js")).toContain(
      'await state.set("phase", "research")',
    );
    expect(read("workflow-scripts/research.js")).toContain(
      'await state.set("research", research)',
    );
    expect(read("workflow-scripts/planning.js")).toContain(
      'await state.set("phase", "planning")',
    );
    expect(read("workflow-scripts/planning.js")).toContain(
      'await state.set("planningDecision", planningDecision)',
    );
    expect(read("workflow-scripts/planning.js")).toContain(
      'await state.set("phase", "plan-review")',
    );
  });

  it("documents canonical dependency references for the Planning reviewer", () => {
    const skill = read("skills/pi-planning/SKILL.md");

    expect(skill).toContain(
      "A WorkUnit with no dependency must use `dependsOn: []`.",
    );
    expect(skill).toContain("`none`, `なし`, or `N/A`");
    expect(skill).toContain("Every ID-reference field may contain only an ID");
  });

  it("does not add custom Agents", () => {
    expect(existsSync(`${repoRoot}/agents`)).toBe(false);
  });
});
