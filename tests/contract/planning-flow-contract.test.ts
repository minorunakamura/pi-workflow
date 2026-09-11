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
    expect(planReview).not.toContain("PlanningDecision");
    expect(planReview).not.toContain("renderPlan");
  });

  it("keeps legacy validation separate from the named Planning resource", () => {
    const skill = read("skills/pi-workflow/SKILL.md");

    expect(skill).toContain('subagent({ action: "validate", workflowScript })');
    expect(skill).toContain("byte-for-byte identical");
    expect(skill).toContain("stop without launching the phase");
    expect(skill).toContain('workflow: "pi-workflow.planning"');
    expect(skill).toContain("resource-owned `PlanningDecisionV1` schema");
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
    expect(research).toContain('agent: "pi-workflow.researcher"');
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

  it("keeps Plan Review input reference-centric and separate from code review", () => {
    const tool = read("src/tools/plan-review.ts");
    const bridge = read("src/runtime/plannotator/plan-review.ts");

    expect(tool).toContain("missionId:");
    expect(tool).toContain("round:");
    expect(tool).toContain("planRef:");
    for (const field of [
      "planningDecision",
      "planContent",
      "planPath",
      "feedbackText",
      "outputPath",
      "workflowScript",
    ]) {
      expect(tool).not.toContain(field);
    }
    expect(bridge).toContain("readPlanArtifact");
    expect(bridge).toContain("writeFeedbackArtifact");
    expect(bridge).toContain("savedPath");
    expect(bridge).not.toContain("feedbackRef: status.savedPath");
  });

  it("contains native Planning Flow roles in phase templates", () => {
    const planning = read("workflow-scripts/planning.js");
    expect(read("workflow-scripts/discovery.js")).toContain('agent: "scout"');
    expect(read("workflow-scripts/research.js")).toContain(
      'agent: "pi-workflow.researcher"',
    );
    expect(planning).toContain('agent: "reviewer"');
    expect(planning).toContain('skill: "pi-planning"');
    expect(planning).toContain("planningDecisionSchema");
    expect(planning).toContain("plan-artifact");
    expect(planning).toContain("planning-correction");
    expect(planning).toContain("planning-invalid");
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
    const planning = read("workflow-scripts/planning.js");
    expect(planning).toContain("planningDecision,");
    expect(planning).toContain("planRef: input.planArtifactPath");
    expect(planning).toContain("await state.set(key, nextState[key])");
  });

  it("documents canonical dependency references for the Planning reviewer", () => {
    const skill = read("skills/pi-planning/SKILL.md");

    expect(skill).toContain(
      "A WorkUnit with no dependency must use `dependsOn: []`.",
    );
    expect(skill).toContain("`none`, `なし`, or `N/A`");
    expect(skill).toContain("Every ID-reference field may contain only an ID");
  });

  it("declares only the package-owned Research Agent", () => {
    expect(existsSync(`${repoRoot}/agents/researcher.md`)).toBe(true);
    expect(existsSync(`${repoRoot}/agents/planner.md`)).toBe(false);
  });
});
