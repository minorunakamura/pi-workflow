import { expect, it } from "vitest";

import {
  evaluateFinalDiffInspection,
  type FinalDiffInspectionInput,
} from "../../src/core/index.ts";
import {
  acceptFinalDiffInspection,
  validateFinalDiffInspectionRun,
} from "../../src/runtime/final-diff-inspection.ts";

const artifactRef = {
  kind: "managed" as const,
  path: "/managed/final-diff-inspection.md",
  mediaType: "text/markdown" as const,
};

const input: FinalDiffInspectionInput = {
  requirementsSatisfied: true,
  changedPaths: ["src/feature.ts"],
  scope: { allowedPaths: ["src/feature.ts"], allowedAreas: [] },
  nonGoalViolations: [],
  acceptedFindingsResolved: true,
  deferredFindingsDocumented: true,
  rejectedFindingsDocumented: true,
  gates: [],
  workingTree: {
    status: "known",
    trackedPaths: ["src/feature.ts"],
    untrackedPaths: [],
    evidenceRef: {
      kind: "managed",
      path: "/managed/working-tree.txt",
      mediaType: "text/plain",
    },
  },
};

it("accepts only a structured Coordinator result with a managed inspection artifact", () => {
  const result = evaluateFinalDiffInspection(input);
  const accepted = acceptFinalDiffInspection(result, artifactRef);

  expect(accepted.valid).toBe(true);
  if (!accepted.valid) return;
  expect(accepted.value).toEqual({ result, artifactRef });
  expect(validateFinalDiffInspectionRun(accepted.value).valid).toBe(true);
});

it("rejects a missing or non-markdown inspection artifact", () => {
  const result = evaluateFinalDiffInspection(input);

  expect(
    validateFinalDiffInspectionRun({ result, artifactRef: undefined }).valid,
  ).toBe(false);
  expect(
    validateFinalDiffInspectionRun({
      result,
      artifactRef: { ...artifactRef, mediaType: "text/plain" },
    }).valid,
  ).toBe(false);
});

it("rejects an invalid checklist result instead of trusting Coordinator prose", () => {
  const result = evaluateFinalDiffInspection(input);

  expect(
    validateFinalDiffInspectionRun({
      result: { ...result, passed: true, status: "FAIL" },
      artifactRef,
    }).valid,
  ).toBe(false);
});
