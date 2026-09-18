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
  expect(source).toContain("current builtin `worker`");
  expect(source).toContain("`agent: worker`");
  expect(source).toContain("`context: fresh`");
  expect(source).toContain("`outputMode: file-only`");
  expect(source).toContain("`worktree: false`");
  expect(source).toContain('skill: ["tdd"]');
  expect(source).toContain("valid RED/GREEN record");
  expect(source).toContain("outside the approved scope");
  expect(source).toContain("Verification");
  expect(source).toContain("Trusted Gate expectations");
  expect(source).toContain("repository drift");
  expect(source).toContain("never downgrade it to optional");
  expect(source).toContain("actual change makes it mechanically required");
  expect(source).toContain(
    "never expand an aggregate command such as `pnpm check`",
  );
  expect(source).toContain('agent: "scout"');
  expect(source).toContain("gate: gate.command");
  expect(source).toContain("timeoutMs: 1200000");
  expect(source).toContain("saved log/evidence path");
  expect(source).toContain(
    "Model prose, Worker claims, missing evidence, timeout, or unknown status is not PASS",
  );
  expect(source).toContain("current builtin `reviewer`");
  expect(source).toContain("agent: reviewer");
  expect(source).toContain("context: fresh");
  expect(source).toContain("output: reviewer-report.md");
  expect(source).toContain("outputMode: file-only");
  expect(source).toContain("artifacts: true");
  expect(source).toContain("never resume or fork the Worker");
  expect(source).toContain("raw Reviewer prose only in its managed artifact");
  expect(source).toContain("minimal bounded Finding");
  expect(source).toContain("BLOCKER");
  expect(source).toContain("FIX_NOW");
  expect(source).toContain("DEFERRED");
  expect(source).toContain("REJECTED");
  expect(source).toContain("non-empty reason");
  expect(source).toContain("Reviewer recommendations are input, not commands");
  expect(source).toContain("combine all `BLOCKER` and `FIX_NOW` findings");
  expect(source).toContain("at most once");
  expect(source).toContain("fresh read-only Focused Re-review");
  expect(source).toContain("RESOLVED");
  expect(source).toContain("STILL_PRESENT");
  expect(source).toContain("Never start Fix Wave #2 or an automatic retry");
  expect(source).toContain("preserving its status/evidence");
  expect(source).not.toContain(
    "normalized bounded location/evidence/reason/recommended action",
  );
  expect(source).toContain("do not perform Final Diff Inspection");
  expect(source).not.toContain('skill: ["ponytail"]');
  expect(source).toContain("Do not merge, push, release, or deploy");

  const tools = source.match(/^tools: (.+)$/mu)?.[1] ?? "";
  expect(tools).not.toMatch(/\b(write|edit|bash)\b/u);
});

it("declares the canonical managed Reviewer input contract", () => {
  const source = readFileSync(AGENT_PATH, "utf8");
  const start = source.indexOf("After the approved implementation");
  const end = source.indexOf("Keep the raw Reviewer prose only");
  const reviewerContract = source.slice(start, end);

  expect(reviewerContract).toContain("workflow identity");
  expect(reviewerContract).toContain("Plan Artifact ref");
  expect(reviewerContract).toContain("Planning Handoff ref");
  expect(reviewerContract).toContain("Worker output/diff artifact refs");
  expect(reviewerContract).toContain("current cwd");
  expect(reviewerContract).toContain("non-goals");
  expect(reviewerContract).toContain("bounded review scope");
  expect(reviewerContract).toContain("only as managed artifact references");
  expect(reviewerContract).toContain(
    "do not copy raw Worker reports or the full diff",
  );
});
