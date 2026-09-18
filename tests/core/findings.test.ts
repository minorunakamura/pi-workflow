import { expect, it } from "vitest";

import {
  createFindingId,
  normalizeFinding,
  validateDispositionedFinding,
  validateFindingDisposition,
} from "../../src/core/index.ts";

const FINDING_ID = createFindingId("00000000-0000-4000-8000-000000000031");

function unwrap<T>(result: { valid: true; value: T } | { valid: false }): T {
  if (!result.valid) throw new Error("Expected a valid result");
  return result.value;
}

it("keeps raw Reviewer prose at the artifact boundary", () => {
  const rawReport = {
    kind: "managed" as const,
    path: "review/reviewer-report.md",
    mediaType: "text/markdown" as const,
  };

  expect(
    normalizeFinding(
      {
        source: "reviewer",
        evidence: "The behavior is not covered by a regression test.",
        reason: "The approved behavior can regress.",
        rawReport,
      },
      FINDING_ID,
    ).valid,
  ).toBe(false);

  const finding = unwrap(
    normalizeFinding(
      {
        source: "reviewer",
        location: "src/example.ts:4",
        severity: "medium",
        evidence: "The behavior is not covered by a regression test.",
        reason: "The approved behavior can regress.",
        recommendedAction: "Add a regression test.",
      },
      FINDING_ID,
    ),
  );

  expect(finding).toEqual({
    id: FINDING_ID,
    source: "reviewer",
    location: "src/example.ts:4",
    severity: "medium",
    evidence: "The behavior is not covered by a regression test.",
    reason: "The approved behavior can regress.",
    recommendedAction: "Add a regression test.",
  });
  expect(finding).not.toHaveProperty("rawReport");
  expect(finding).not.toHaveProperty("rawReportRef");
});

it("normalizes only bounded Finding evidence", () => {
  expect(
    normalizeFinding(
      {
        source: "reviewer",
        evidence: "x".repeat(4097),
        reason: "A bounded reason.",
      },
      FINDING_ID,
    ).valid,
  ).toBe(false);

  const finding = unwrap(
    normalizeFinding(
      {
        source: "reviewer",
        evidence: "A bounded observation.",
        reason: "A bounded reason.",
      },
      FINDING_ID,
    ),
  );
  expect(finding.evidence).toBe("A bounded observation.");
  expect(finding.reason).toBe("A bounded reason.");
});

it("requires the Implementation Coordinator to assign one reasoned disposition", () => {
  const dispositions = ["BLOCKER", "FIX_NOW", "DEFERRED", "REJECTED"] as const;

  for (const disposition of dispositions) {
    const result = validateFindingDisposition({
      findingId: FINDING_ID,
      disposition,
      reason: `Coordinator reason for ${disposition}.`,
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.disposition).toBe(disposition);
  }

  expect(
    validateFindingDisposition({
      findingId: FINDING_ID,
      disposition: "BLOCKER",
      reason: "   ",
    }).valid,
  ).toBe(false);

  expect(
    validateDispositionedFinding({
      finding: {
        id: FINDING_ID,
        source: "reviewer",
        evidence: "bounded evidence",
        reason: "bounded reason",
        rawReport: "raw prose must not cross normalization",
      },
      disposition: {
        findingId: FINDING_ID,
        disposition: "REJECTED",
        reason: "The evidence does not support the finding.",
      },
    }).valid,
  ).toBe(false);
});
