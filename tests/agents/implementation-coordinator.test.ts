import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const AGENT_PATH = new URL(
  "../../agents/implementation-coordinator.md",
  import.meta.url,
);

it("declares a fresh, bounded Implementation Coordinator boundary", () => {
  const source = readFileSync(AGENT_PATH, "utf8");

  expect(source).toContain("name: implementation-coordinator");
  expect(source).toContain("package: pi-workflow");
  expect(source).toContain("defaultContext: fresh");
  expect(source).toContain("maxSubagentDepth: 2");
  expect(source).toContain("inheritProjectContext: false");
  expect(source).toContain("inheritGlobalContext: false");
  expect(source).toContain("inheritSkills: false");
  expect(source).toContain("Plan Artifact");
  expect(source).toContain("Planning Handoff");
  expect(source).toContain("Approval Identity");
  expect(source).toContain("Do not resume or fork the Planning Coordinator");
  expect(source).toContain("Do not edit source directly");

  const tools = source.match(/^tools: (.+)$/mu)?.[1] ?? "";
  expect(tools).not.toMatch(/\b(write|edit|bash)\b/u);
});
