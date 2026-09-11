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
  it("accepts only bounded Planning MVP state", () => {
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

    for (const key of [
      "missionStatus",
      "implementation",
      "verificationRef",
      "verificationStatus",
      "verificationFixRuns",
      "reviewRef",
      "reviewDecision",
      "codeApproval",
      "verificationRound",
      "reviewFixWave",
    ]) {
      expect(validateMissionState({ version: 1, [key]: "future" }).ok).toBe(
        false,
      );
    }
    expect(
      validateMissionState({ version: 1, report: "full discovery report" }),
    ).toMatchObject({ ok: false });
  });

  it("enforces nested ReferenceValue bounds and the aggregate limit", () => {
    const oversized = "r".repeat(MAX_REFERENCE_BYTES);
    expect(
      validateMissionState({ version: 1, planRef: oversized }),
    ).toMatchObject({
      ok: false,
    });
    expect(MAX_MISSION_STATE_BYTES).toBe(262_144);
  });
});

describe("named resource args contract", () => {
  it.each(Object.entries(resourceArgs) as [ResourceArgsPhase, unknown][])(
    "accepts minimal %s args",
    (phase, args) => {
      expect(validateResourceArgs(phase, args)).toMatchObject({ ok: true });
    },
  );

  it.each(Object.keys(resourceArgs) as ResourceArgsPhase[])(
    "rejects caller-owned fields for %s",
    (phase) => {
      const args = { ...(resourceArgs[phase] as object), workflowScript: "x" };
      expect(validateResourceArgs(phase, args)).toMatchObject({ ok: false });
    },
  );

  it("rejects missing required fields and removed phase names", () => {
    expect(
      validateResourceArgs("discovery", { requestType: "feature" }).ok,
    ).toBe(false);
    expect(validateResourceArgs("planning", {}).ok).toBe(false);
    expect(validateResourceArgs("implementation", { mode: "single" }).ok).toBe(
      false,
    );
    expect(validateResourceArgs("verification", { round: 0 }).ok).toBe(false);
  });

  it("enforces bounded Human input, request bytes, and review transitions", () => {
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
        operation: "prepare-review",
        round: 1,
        planRef: "plan-1",
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateResourceArgs("planning", {
        operation: "record-review",
        round: 1,
        planRef: "plan-1",
        reviewId: "review-1",
        status: "pending",
      }).ok,
    ).toBe(false);
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
