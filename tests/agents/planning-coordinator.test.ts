import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const AGENT_PATH = new URL(
  "../../agents/planning-coordinator.md",
  import.meta.url,
);

it("declares the Planning Coordinator as a bounded fresh package agent", () => {
  const source = readFileSync(AGENT_PATH, "utf8");

  expect(source).toContain("name: planning-coordinator");
  expect(source).toContain("package: pi-workflow");
  expect(source).toContain("allowNestedSubagents: true");
  expect(source).toContain("maxSubagentDepth: 2");
  expect(source).toContain("defaultContext: fresh");
  expect(source).toContain("inheritSkills: false");
  expect(source).toContain("Do not implement source code.");
  expect(source).toContain("Do not launch an Implementation Coordinator.");
  expect(source).toContain("implementation-plan.md");
  expect(source).toContain("planning-handoff.json");
  expect(source).toContain("approvedPlanHash");

  const tools = source.match(/^tools: (.+)$/mu)?.[1] ?? "";
  expect(tools).not.toMatch(/\b(write|edit|bash)\b/u);
});

it("declares bounded capability contracts and explicit external Skill rules", () => {
  const source = readFileSync(AGENT_PATH, "utf8");

  expect(source).toContain("agent: scout");
  expect(source).toContain("context: fresh");
  expect(source).toContain("skill: codegraph");
  expect(source).toContain("output: scout-context.md");
  expect(source).toContain("output: targeted-rescout-context.md");
  expect(source).toContain("outputMode: file-only");
  expect(source).toContain("agent: pi-ketch.researcher");
  expect(source).toContain("output: researcher-report.md");
  expect(source).toContain("Never add a search-provider fallback");
  expect(source).toContain("agent: pi-workflow.grilling-coordinator");
  expect(source).toContain("skill: grilling");
  expect(source).toContain("domain-modeling");
  expect(source).toContain("`grill-with-doc`");
  expect(source).toContain("agent: oracle");
  expect(source).toContain("output: oracle-report.md");
  expect(source).toContain("maxSubagentDepth: 2");
  expect(source).toContain("Do not copy a fixed universal capability sequence");
  expect(source).not.toContain("grill-with-docs");
  expect(source).not.toContain("pi_workflow_human_decision");

  const tools = source.match(/^tools: (.+)$/mu)?.[1] ?? "";
  expect(tools).not.toMatch(/\b(write|edit|bash)\b/u);
});
