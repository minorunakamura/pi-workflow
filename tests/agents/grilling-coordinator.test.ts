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

it("uses the child-only Human Decision bridge without a Parent fallback", () => {
  const source = readFileSync(AGENT_PATH, "utf8");

  expect(source).toContain("pi_workflow_human_decision");
  expect(source).toContain("Do not ask the Root Parent");
  expect(source).toContain("use a direct TUI");
  expect(source).toContain("invent a default answer");
  expect(source).toContain(
    "Treat every result other than `answered` as a structured Planning blocker",
  );
  expect(source).toContain(
    "subagentOnlyExtensions: ../src/runtime/human-decision-bridge.ts",
  );
});
