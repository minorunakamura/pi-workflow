import { describe, expect, it } from "vitest";
import {
  BOUNDED_COMPACT_OUTPUT_POLICY,
  buildForegroundWorkflowInvocation,
  FOREGROUND_POLICY,
  LARGE_ARTIFACT_OUTPUT_POLICY,
  validateStructuredOutputPolicy,
} from "../../src/core/phases/definitions";
import {
  validateResourceArgs,
  type ResourceArgsPhase,
} from "../../src/core/phases/args";
import {
  MAX_MISSION_STATE_BYTES,
  validateMissionState,
} from "../../src/core/state/contracts";
import {
  MAX_REFERENCE_BYTES,
  validateReferenceValue,
} from "../../src/core/state/references";

const resourceArgs: Record<ResourceArgsPhase, unknown> = {
  discovery: { requestType: "feature", request: "Inspect the repository." },
  research: {},
  planning: { round: 1 },
  implementation: { mode: "single" },
  verification: { round: 0 },
  "verification-fix": { round: 1 },
  review: { wave: 0 },
};

describe("ReferenceValue contract", () => {
  it("accepts the serialized UTF-8 boundary and rejects overflow", () => {
    const exact = "r".repeat(MAX_REFERENCE_BYTES - 2);

    expect(validateReferenceValue(exact)).toMatchObject({ ok: true });
    expect(validateReferenceValue(`${exact}x`)).toMatchObject({ ok: false });
  });

  it("checks multibyte serialized UTF-8 bytes rather than character count", () => {
    const exact = "あ".repeat(682);

    expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(
      MAX_REFERENCE_BYTES,
    );
    expect(validateReferenceValue(exact)).toMatchObject({ ok: true });
    expect(validateReferenceValue(`${exact}a`)).toMatchObject({ ok: false });
  });

  it("rejects empty values and object-shaped values", () => {
    expect(validateReferenceValue("")).toMatchObject({ ok: false });
    expect(validateReferenceValue({ path: "artifact.md" })).toMatchObject({
      ok: false,
    });
  });
});

describe("Mission state contract", () => {
  it("accepts bounded state and rejects large or unknown data", () => {
    expect(
      validateMissionState({
        version: 1,
        requestType: "feature",
        request: "Inspect the repository.",
        phase: "discovery",
        discoveryRef: "run:discovery",
        discoveryMeta: {
          version: 1,
          status: "ready",
          externalResearchRequired: false,
          humanClarificationRequired: false,
          uncertainties: [],
          researchQuestions: [],
        },
      }),
    ).toMatchObject({ ok: true });

    expect(
      validateMissionState({
        version: 1,
        report: "full discovery report",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateMissionState({
        version: 1,
        artifactBody: "full Artifact body",
        planRef: { body: "not a ReferenceValue" },
      }),
    ).toMatchObject({ ok: false });

    expect(
      validateMissionState({
        version: 1,
        discoveryMeta: {
          version: 1,
          status: "ready",
          externalResearchRequired: false,
          humanClarificationRequired: false,
          uncertainties: [],
          researchQuestions: [],
          report: "not allowed",
        },
      }),
    ).toMatchObject({ ok: false });
  });

  it("enforces nested ReferenceValue bounds", () => {
    const oversized = "r".repeat(MAX_REFERENCE_BYTES);
    const result = validateMissionState({ version: 1, planRef: oversized });

    expect(result.ok).toBe(false);
  });

  it("uses the serialized aggregate state limit", () => {
    expect(MAX_MISSION_STATE_BYTES).toBe(262_144);
  });
});

describe("resource args contract", () => {
  it.each(Object.entries(resourceArgs) as [ResourceArgsPhase, unknown][])(
    "accepts minimal %s args but does not execute the phase",
    (phase, args) => {
      expect(validateResourceArgs(phase, args)).toMatchObject({ ok: true });
    },
  );

  it.each(Object.keys(resourceArgs) as ResourceArgsPhase[])(
    "rejects caller-owned fields for %s",
    (phase) => {
      const args = { ...(resourceArgs[phase] as object), workflowScript: "x" };
      const result = validateResourceArgs(phase, args);

      expect(result.ok).toBe(false);
    },
  );

  it("rejects missing required fields for every resource", () => {
    const invalid: Record<ResourceArgsPhase, unknown> = {
      discovery: { requestType: "feature" },
      research: {},
      planning: {},
      implementation: {},
      verification: {},
      "verification-fix": {},
      review: {},
    };

    expect(validateResourceArgs("discovery", invalid.discovery).ok).toBe(false);
    expect(validateResourceArgs("planning", invalid.planning).ok).toBe(false);
    expect(
      validateResourceArgs("implementation", invalid.implementation).ok,
    ).toBe(false);
    expect(validateResourceArgs("verification", invalid.verification).ok).toBe(
      false,
    );
    expect(
      validateResourceArgs("verification-fix", invalid["verification-fix"]).ok,
    ).toBe(false);
    expect(validateResourceArgs("review", invalid.review).ok).toBe(false);
  });

  it("enforces bounded human input and request bytes", () => {
    expect(
      validateResourceArgs("discovery", {
        requestType: "feature",
        request: "あ".repeat(2_731),
      }),
    ).toMatchObject({ ok: false });

    expect(
      validateResourceArgs("planning", {
        round: 1,
        humanInputs: [{ id: "decision", value: "あ".repeat(683) }],
      }),
    ).toMatchObject({ ok: false });

    expect(
      validateResourceArgs("planning", {
        round: 1,
        feedbackRef: "r".repeat(MAX_REFERENCE_BYTES - 1),
      }),
    ).toMatchObject({ ok: false });
  });

  it("enforces review-fix cross-field policy", () => {
    expect(
      validateResourceArgs("implementation", {
        mode: "review-fix",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateResourceArgs("implementation", {
        mode: "single",
        reviewFixWave: 1,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("S2 structured-output policy", () => {
  it("denies schemas for large Artifact data", () => {
    expect(
      validateStructuredOutputPolicy("large-artifact", true),
    ).toMatchObject({ ok: false });
    expect(LARGE_ARTIFACT_OUTPUT_POLICY.outputSchema).toBe("forbidden");
  });

  it("allows bounded compact schemas while accepting S2 visibility", () => {
    expect(
      validateStructuredOutputPolicy("bounded-compact", true),
    ).toMatchObject({ ok: true });
    expect(BOUNDED_COMPACT_OUTPUT_POLICY.mainDetails).toBe(
      "structured-output-visible",
    );
  });
});

describe("foreground policy", () => {
  it("builds an invocation with explicit async:false", () => {
    expect(
      buildForegroundWorkflowInvocation({
        workflow: "pi-workflow.discovery",
        args: {},
        missionId: "mission-1",
      }),
    ).toEqual({
      workflow: "pi-workflow.discovery",
      args: {},
      missionId: "mission-1",
      async: false,
    });
  });

  it("requires false for every normal execution boundary", () => {
    expect(FOREGROUND_POLICY).toEqual({
      main: { async: false },
      runsRun: { async: false },
      runsAll: { async: false },
      runsLanes: { async: false },
    });
  });
});
