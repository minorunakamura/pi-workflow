import { expect, it, vi } from "vitest";

import {
  evaluateFinalDiffInspection,
  validateFinalDiffInspectionResult,
  type FinalDiffInspectionInput,
} from "../../src/core/index.ts";
import {
  default as finalDiffInspectionChildExtension,
  evaluateFinalDiffInspectionWithEvidence,
  FINAL_DIFF_INSPECTION_GIT_OPERATIONS,
  inspectRepositoryDiff,
  registerFinalDiffInspectionChildTool,
  validateFinalDiffInspectionToolDetails,
  type FinalDiffInspectionContext,
} from "../../src/runtime/final-diff-inspection.ts";

const context: FinalDiffInspectionContext = {
  requirementsSatisfied: true,
  scope: { allowedPaths: ["src/feature.ts"], allowedAreas: [] },
  nonGoalViolations: [],
  acceptedFindingsResolved: true,
  deferredFindingsDocumented: true,
  rejectedFindingsDocumented: true,
  gates: [],
};

const input: FinalDiffInspectionInput = {
  ...context,
  changedPaths: ["src/feature.ts"],
  workingTree: {
    status: "known",
    trackedPaths: ["src/feature.ts"],
    untrackedPaths: [],
  },
};

function fakeExec(
  calls: Array<{ command: string; args: string[] }>,
  failedOperation?: string,
): Parameters<typeof inspectRepositoryDiff>[0] {
  return async (command, args) => {
    calls.push({ command, args: [...args] });
    const operation = args.join(" ");
    if (operation === failedOperation) {
      return { stdout: "", stderr: "git failed", code: 1, killed: false };
    }
    const stdout =
      operation === "status --short"
        ? " M src/feature.ts\n"
        : operation === "diff --name-only"
          ? "src/feature.ts\n"
          : operation === "diff --stat"
            ? " src/feature.ts | 1 +\n 1 file changed, 1 insertion(+)\n"
            : "";
    return { stdout, stderr: "", code: 0, killed: false };
  };
}

it("registers a commandless child-only tool and executes only the fixed Git operations", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const registered: Array<{ name: string; parameters: unknown }> = [];
  const exec = fakeExec(calls);
  registerFinalDiffInspectionChildTool({
    registerTool(tool) {
      registered.push({ name: tool.name, parameters: tool.parameters });
    },
    exec,
  });

  expect(registered).toHaveLength(1);
  expect(registered[0]?.name).toBe("pi_workflow_inspect_diff");
  expect(registered[0]?.parameters).not.toHaveProperty("properties.command");
  await inspectRepositoryDiff(exec, "/repo");
  expect(calls).toEqual(
    FINAL_DIFF_INSPECTION_GIT_OPERATIONS.map(({ args }) => ({
      command: "git",
      args: [...args],
    })),
  );
});

it("does not publish the tool in Root load and publishes it only in child runtime", () => {
  const registered: string[] = [];
  const pi = {
    registerTool(tool: { name: string }) {
      registered.push(tool.name);
    },
    exec: fakeExec([]),
  };

  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  finalDiffInspectionChildExtension(pi);
  expect(registered).toEqual([]);

  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  finalDiffInspectionChildExtension(pi);
  vi.unstubAllEnvs();
  expect(registered).toEqual(["pi_workflow_inspect_diff"]);
});

it("keeps command failure as unknown evidence and never passes the checklist", async () => {
  const details = await inspectRepositoryDiff(
    fakeExec([], "diff --check"),
    "/repo",
  );
  expect(details.evidence.status).toBe("unknown");

  const evaluated = evaluateFinalDiffInspectionWithEvidence(context, details);
  expect(evaluated.valid).toBe(true);
  if (!evaluated.valid) return;
  expect(evaluated.value.status).toBe("UNKNOWN");
  expect(evaluated.value.passed).toBe(false);
});

it("maps malformed evidence to an UNKNOWN structured result", () => {
  const evaluated = evaluateFinalDiffInspectionWithEvidence(context, {
    evidence: {
      status: "known",
      changedPaths: ["src/feature.ts"],
      trackedPaths: ["src/feature.ts"],
      untrackedPaths: [],
      stat: "",
      commands: [],
    },
  });

  expect(evaluated.valid).toBe(true);
  if (!evaluated.valid) return;
  expect(evaluated.value.status).toBe("UNKNOWN");
  expect(evaluated.value.passed).toBe(false);
});

it("connects valid tool evidence to the eight-item Final Diff Inspection result", async () => {
  const details = await inspectRepositoryDiff(fakeExec([]), "/repo");
  const evaluated = evaluateFinalDiffInspectionWithEvidence(context, details);

  expect(details).not.toHaveProperty("artifactRef");
  expect(JSON.stringify(details)).not.toContain("final-diff-inspection.md");
  expect(validateFinalDiffInspectionToolDetails(details).valid).toBe(true);
  expect(evaluated.valid).toBe(true);
  if (!evaluated.valid) return;
  expect(evaluated.value.status).toBe("PASS");
  expect(evaluated.value.passed).toBe(true);
  expect(validateFinalDiffInspectionResult(evaluated.value).valid).toBe(true);
  expect(evaluated.value.checks).toHaveLength(8);
  expect(evaluated.value.checks.at(-1)).not.toHaveProperty("evidenceRef");
});

it("allows a valid structured result without a physical inspection artifact", () => {
  const result = evaluateFinalDiffInspection(input);

  expect(result.status).toBe("PASS");
  expect(result).not.toHaveProperty("artifactRef");
  expect(validateFinalDiffInspectionResult(result).valid).toBe(true);
});
