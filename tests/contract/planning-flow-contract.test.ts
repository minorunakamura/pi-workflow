import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}/${path}`, "utf8");
}

describe("Planning MVP contract", () => {
  it("keeps commands as Main-session kickoff adapters", () => {
    const source = read("src/commands/workflow.ts");

    expect(source).toContain("pi.sendUserMessage");
    expect(source).toContain("approved Plan");
    expect(source).not.toContain("pi-subagents");
    expect(source).not.toContain("mission.create");
    expect(source).not.toContain("workflowScript");
    expect(source).not.toContain("Unit ");
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

  it("uses only the named resource boundary", () => {
    const skill = read("skills/pi-workflow/SKILL.md");

    expect(skill).toContain('workflow: "pi-workflow.discovery"');
    expect(skill).toContain('workflow: "pi-workflow.research"');
    expect(skill).toContain('workflow: "pi-workflow.planning"');
    expect(skill).not.toContain("prepare_phase");
    expect(skill).not.toContain("workflowScript");
    expect(skill).not.toMatch(/Unit [56]/u);
  });

  it("documents the structured_output envelope without weakening plan content", () => {
    const skill = read("skills/pi-planning/SKILL.md");
    const planning = read("workflow-scripts/planning.js");

    expect(skill).toContain('{ "value": <PlanningDecisionV1> }');
    expect(skill).toContain("fix only the");
    expect(skill).toContain("preserve the substantive planning content");
    expect(skill).toContain('"x"');
    expect(skill).toContain('"todo"');
    expect(skill).toContain('"dummy"');

    expect(planning).toContain(
      "pi-subagents 0.67.0 structured_output contract",
    );
    expect(planning).toContain("<PlanningDecisionV1>");
    expect(planning).toContain("fix only the value envelope");
    expect(planning).toContain("preserve the substantive planning content");
    expect(planning).toContain("placeholders");
  });

  it("makes Research skip explicit through absence of Research state", () => {
    const skill = read("skills/pi-workflow/SKILL.md");
    const research = read("workflow-scripts/research.js");
    const planning = read("workflow-scripts/planning.js");

    expect(skill).toContain(
      "When `discoveryMeta.externalResearchRequired === false`, do not invoke the",
    );
    expect(skill).toContain("Do not create skipped Research state");
    expect(planning).toContain("Research state to be absent");
    expect(research).toContain('agent: "pi-workflow.researcher"');
    expect(research).not.toContain("ask_user_question");
    expect(research).not.toContain("Plannotator");
  });

  it("keeps Human clarification Main-only and conditional", () => {
    const skill = read("skills/pi-workflow/SKILL.md");

    expect(skill).toContain("Optional Human clarification");
    expect(skill).toContain("ask_user_question");
    expect(skill).toContain(
      "When `discoveryMeta.humanClarificationRequired === false`",
    );
    expect(skill).toContain("Children never invoke");
  });

  it("simplifies Plan Review to one terminal record", () => {
    const skill = read("skills/pi-workflow/SKILL.md");
    const args = read("src/core/phases/args.ts");

    expect(skill).toContain(
      "prepare-review → Mission waiting → pi_workflow_plan_review → record-review terminal result",
    );
    expect(skill).toContain("Record the terminal result exactly once");
    expect(skill).toContain('status: "approved"');
    expect(skill).toContain("mission.close(completed) → STOP");
    expect(args).not.toContain('Type.Literal("pending")');
  });

  it("declares the package-owned Research Agent without a verification Skill", () => {
    expect(existsSync(`${repoRoot}/agents/researcher.md`)).toBe(true);
    expect(existsSync(`${repoRoot}/skills/pi-verification/SKILL.md`)).toBe(
      false,
    );
  });
});
