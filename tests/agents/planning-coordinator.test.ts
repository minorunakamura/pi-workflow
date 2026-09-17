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
