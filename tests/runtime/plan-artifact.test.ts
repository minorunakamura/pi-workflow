import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PlanningDecisionV1 } from "../../src/core/planning/planning-decision";

const runtimePath = fileURLToPath(
  new URL("../../runtime/plan-artifact.mjs", import.meta.url),
);

const decision: PlanningDecisionV1 = {
  version: 1,
  requestSummary: "Add a search endpoint.",
  scope: {
    inScope: ["HTTP search endpoint"],
    outOfScope: ["UI changes"],
  },
  acceptanceCriteria: [{ id: "ac-search", text: "Returns matching records." }],
  constraints: ["Keep the public API backward compatible."],
  risks: ["Large result sets may be slow."],
  verification: [
    {
      id: "verify-search",
      description: "Search tests pass.",
      command: "echo `date`",
      timeoutMs: 120_000,
    },
  ],
  implementation: {
    mode: "single",
    workUnits: [
      {
        id: "search-api",
        title: "Implement the search endpoint",
        objective: "Expose search through the existing API.",
        dependsOn: [],
        writeScope: ["src/api/search.ts"],
        acceptanceCriteriaIds: ["ac-search"],
        focusedVerificationIds: ["verify-search"],
      },
    ],
    finalVerificationIds: ["verify-search"],
  },
  unresolvedDecisions: [],
};

function runRenderer(args: string[]) {
  return spawnSync(process.execPath, [runtimePath, ...args], {
    encoding: "utf8",
  });
}

describe("Plan Artifact runtime asset", () => {
  it("renders the same PlanningDecision deterministically and preserves backticks", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-workflow-plan-artifact-"));
    const inputPath = join(directory, "decision.json");
    try {
      writeFileSync(inputPath, JSON.stringify(decision));
      const first = runRenderer([inputPath]);
      const second = runRenderer([inputPath]);

      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(first.stdout).toBe(second.stdout);
      expect(first.stdout).toContain("- Command: `` echo `date` ``");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes non-empty output, creates its parent, and keeps stdout mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-workflow-plan-artifact-"));
    const inputPath = join(directory, "decision.json");
    const outputPath = join(directory, "nested", "plan.md");
    try {
      writeFileSync(inputPath, JSON.stringify(decision));
      const stdoutResult = runRenderer([inputPath]);
      const outputResult = runRenderer(["--output", outputPath, inputPath]);

      expect(stdoutResult.status).toBe(0);
      expect(outputResult.status).toBe(0);
      expect(outputResult.stdout).toBe("plan-artifact-written");
      expect(existsSync(outputPath)).toBe(true);
      expect(readFileSync(outputPath, "utf8")).toBe(stdoutResult.stdout);
      expect(readFileSync(outputPath, "utf8")).not.toHaveLength(0);
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails for missing input and invalid JSON", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-workflow-plan-artifact-"));
    const missingPath = join(directory, "missing.json");
    const invalidPath = join(directory, "invalid.json");
    try {
      const missing = runRenderer([missingPath]);
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain("PlanningDecisionV1");

      writeFileSync(invalidPath, "{");
      const invalid = runRenderer([invalidPath]);
      expect(invalid.status).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
