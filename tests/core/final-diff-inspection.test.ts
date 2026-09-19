import { expect, it } from "vitest";

import {
  evaluateFinalDiffInspection,
  validateFinalDiffInspectionResult,
  type FinalDiffInspectionInput,
} from "../../src/core/index.ts";

const evidenceRef = {
  kind: "managed" as const,
  path: "/managed/final-diff/working-tree.txt",
  mediaType: "text/plain" as const,
};

function input(): FinalDiffInspectionInput {
  return {
    requirementsSatisfied: true,
    changedPaths: ["src/feature.ts"],
    scope: { allowedPaths: ["src/feature.ts"], allowedAreas: [] },
    nonGoalViolations: [],
    acceptedFindingsResolved: true,
    deferredFindingsDocumented: true,
    rejectedFindingsDocumented: true,
    gates: [
      {
        name: "package-check",
        command: "pnpm check",
        requirement: "required",
        status: "PASS",
        source: "package-script",
        evidence: {
          kind: "managed",
          path: "/managed/gates/package-check.log",
          mediaType: "text/plain",
        },
      },
      {
        name: "docs-check",
        command: "pnpm docs",
        requirement: "optional",
        status: "SKIPPED",
        source: "package-script",
        reason: "No documentation files changed.",
      },
    ],
    workingTree: {
      status: "known",
      trackedPaths: ["src/feature.ts"],
      untrackedPaths: [],
      evidenceRef,
    },
  };
}

it("passes the complete read-only final checklist and validates its result", () => {
  const result = evaluateFinalDiffInspection(input());

  expect(result).toMatchObject({
    contractVersion: 1,
    status: "PASS",
    passed: true,
    blockers: [],
  });
  expect(result.checks.map(({ id }) => id)).toEqual([
    "approved-requirements",
    "unexpected-files",
    "non-goals",
    "accepted-findings",
    "deferred-rejected-findings",
    "required-gates",
    "optional-gates",
    "working-tree",
  ]);
  expect(validateFinalDiffInspectionResult(result).valid).toBe(true);
});

it("fails closed for unexpected files, scope escape, and non-goal violations", () => {
  const result = evaluateFinalDiffInspection({
    ...input(),
    changedPaths: ["src/feature.ts", "docs/unexpected.md"],
    workingTree: {
      ...input().workingTree,
      trackedPaths: ["src/feature.ts"],
      untrackedPaths: ["docs/unexpected.md"],
    },
    nonGoalViolations: ["The public API was changed."],
  });

  expect(result.status).toBe("FAIL");
  expect(result.passed).toBe(false);
  expect(result.blockers.map(({ code }) => code)).toEqual([
    "unexpected-files",
    "non-goals",
  ]);
});

it("does not treat unknown working-tree evidence as PASS", () => {
  const result = evaluateFinalDiffInspection({
    ...input(),
    workingTree: {
      status: "unknown",
      trackedPaths: ["src/feature.ts"],
      untrackedPaths: [],
    },
  });

  expect(result.status).toBe("UNKNOWN");
  expect(result.passed).toBe(false);
  expect(result.blockers).toEqual([
    expect.objectContaining({ code: "working-tree" }),
  ]);
});

it("blocks required Gate failures while allowing an explicitly recorded optional skip", () => {
  const result = evaluateFinalDiffInspection({
    ...input(),
    gates: [
      {
        ...input().gates[0]!,
        status: "FAIL",
        evidence: {
          kind: "managed",
          path: "/managed/gates/package-check.log",
          mediaType: "text/plain",
        },
        reason: "The required command failed.",
      },
      input().gates[1]!,
    ],
  });

  expect(result.status).toBe("FAIL");
  expect(result.blockers.map(({ code }) => code)).toContain("required-gates");
  expect(result.checks).toContainEqual(
    expect.objectContaining({ id: "optional-gates", status: "PASS" }),
  );
});
