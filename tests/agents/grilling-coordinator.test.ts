import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const AGENT_PATH = new URL(
  "../../agents/grilling-coordinator.md",
  import.meta.url,
);

it("uses one dedicated bounded Grilling route with explicit Skills", () => {
  const source = readFileSync(AGENT_PATH, "utf8");
  const tools = source.match(/^tools: (.+)$/mu)?.[1]?.split(", ") ?? [];

  expect(source).toContain("name: grilling-coordinator");
  expect(source).toContain("package: pi-workflow");
  expect(source).toContain("skills: grilling");
  expect(source).toContain("inheritSkills: false");
  expect(source).toContain("defaultContext: fresh");
  expect(source).toContain("output: grilling-report.md");
  expect(source).toContain("outputMode: file-only");
  expect(source).toContain("acceptanceRole: read-only");
  expect(source).toContain("allowNestedSubagents: true");
  expect(source).toContain("maxSubagentDepth: 2");
  expect(tools).not.toContain("write");
  expect(tools).not.toContain("edit");
  expect(tools).not.toContain("bash");
  expect(tools).not.toContain("contact_supervisor");
});

it("fails closed instead of using a Step 9 Human bridge", () => {
  const source = readFileSync(AGENT_PATH, "utf8");

  expect(source).toContain("return a structured Planning blocker");
  expect(source).toContain("Do not ask the Root Parent");
  expect(source).toContain("call a Human bridge tool");
  expect(source).not.toContain("pi_workflow_human_decision");
});
