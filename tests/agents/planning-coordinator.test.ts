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

it("declares the Planning capability launch contracts and Human bridge", () => {
  const source = readFileSync(AGENT_PATH, "utf8");

  expect(source).toContain("existing `agent: scout`");
  expect(source).toContain(
    "`context: fresh`, `skill: codegraph`, `output: scout-context.md`, and `outputMode: file-only`",
  );
  expect(source).toContain(
    "Targeted Re-scout uses the same `agent: scout`, `context: fresh`, `skill: codegraph`, `output: targeted-rescout-context.md`, and `outputMode: file-only`",
  );
  expect(source).toContain("agent: pi-ketch.researcher");
  expect(source).toContain(
    "`context: fresh`, `output: researcher-report.md`, and `outputMode: file-only`",
  );
  expect(source).toContain("Never add a search-provider fallback");
  expect(source).toContain("agent: pi-workflow.grilling-coordinator");
  expect(source).toContain("skill: grilling");
  expect(source).toContain("domain-modeling");
  expect(source).toContain("`grill-with-doc`");
  expect(source).toContain("existing `agent: oracle`");
  expect(source).toContain(
    "`context: fresh`, `output: oracle-report.md`, and `outputMode: file-only`",
  );
  expect(source).toContain(
    "If any Planning path selects Human Decision, call `pi_workflow_human_decision`",
  );
  expect(source).toContain("Do not ask the Root Parent");
  expect(source).toContain("direct TUI");
  expect(source).toContain("invent a default answer");
  expect(source).toContain(
    "Treat every result other than `answered` as a fail-closed Planning blocker",
  );
  expect(source).toContain("source writes");
  expect(source).toContain("CodeGraph `init`, `index`, `sync`, or `upgrade`");
  expect(source).toContain("Do not copy a fixed universal capability sequence");
  expect(source).not.toContain("package-owned `agent: scout`");
  expect(source).not.toContain("grill-with-docs");
  expect(source).toContain("pi_workflow_human_decision");
  expect(source).toContain("- ../src/runtime/human-decision-bridge.ts");
  expect(source).toContain("- ../src/runtime/plan-handoff.ts");
  expect(source).toContain("pi_workflow_write_handoff");

  const tools = source.match(/^tools: (.+)$/mu)?.[1] ?? "";
  expect(tools).not.toMatch(/\b(write|edit|bash)\b/u);
});
