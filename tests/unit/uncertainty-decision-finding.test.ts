import { describe, expect, it } from "vitest";
import {
  DECISION_STATUSES,
  createDecision,
  transitionDecision,
} from "../../src/domain/decisions/decision.js";
import {
  FINDING_DISPOSITIONS_BY_STATE,
  changeFindingDisposition,
  createFinding,
  reopenFinding,
  transitionFinding,
} from "../../src/domain/findings/finding.js";
import {
  UNCERTAINTY_STATUSES,
  createUncertainty,
  transitionUncertainty,
} from "../../src/domain/uncertainty/uncertainty.js";
import type { DecisionId, FindingId, UncertaintyId } from "../../src/domain/primitives/ids.js";

type TestFindingState = "open" | "resolved";
type TestFindingDisposition = "pending" | "fix-required" | "accepted" | "fixed" | "dismissed";

const uncertaintyId = (value: string): UncertaintyId => value as UncertaintyId;
const decisionId = (value: string): DecisionId => value as DecisionId;
const findingId = (value: string): FindingId => value as FindingId;

function finding(
  overrides: { state?: TestFindingState; disposition?: TestFindingDisposition } = {},
) {
  return createFinding({
    id: findingId("F-001"),
    severity: "high",
    confidence: "high",
    ...(overrides.state === undefined ? {} : { state: overrides.state }),
    ...(overrides.disposition === undefined ? {} : { disposition: overrides.disposition }),
  });
}

describe("Uncertainty, Decision, and Finding lifecycle", () => {
  it("uses the canonical U/D statuses for lifecycle transitions", () => {
    const uncertainty = createUncertainty({ id: uncertaintyId("U-001"), category: "design" });
    for (const status of UNCERTAINTY_STATUSES) {
      expect(transitionUncertainty(uncertainty, status).status).toBe(status);
    }
    expect(() => transitionUncertainty(uncertainty, "invalid" as "open")).toThrow(
      /Uncertainty status/,
    );

    const decision = createDecision({ id: decisionId("D-001"), class: "D2" });
    for (const status of DECISION_STATUSES) {
      expect(transitionDecision(decision, status).status).toBe(status);
    }
    expect(() => transitionDecision(decision, "invalid" as "pending")).toThrow(/Decision status/);
  });

  it("rejects every illegal Finding state/disposition pair", () => {
    for (const [state, dispositions] of Object.entries(FINDING_DISPOSITIONS_BY_STATE)) {
      for (const disposition of dispositions) {
        expect(() => finding({ state: state as TestFindingState, disposition })).not.toThrow();
      }
    }

    expect(() =>
      createFinding({
        id: findingId("F-001"),
        state: "open",
        disposition: "fixed",
        severity: "high",
        confidence: "high",
      }),
    ).toThrow(/state\/disposition pair/);
    expect(() =>
      createFinding({
        id: findingId("F-001"),
        state: "resolved",
        disposition: "pending",
        severity: "high",
        confidence: "high",
      }),
    ).toThrow(/state\/disposition pair/);

    expect(() => transitionFinding(finding(), "resolved", "pending")).toThrow(
      /state\/disposition pair/,
    );
    expect(() =>
      changeFindingDisposition(finding({ state: "resolved", disposition: "fixed" }), "accepted"),
    ).toThrow(/state\/disposition pair/);
  });

  it("reopens a Finding with the same identity", () => {
    const resolved = finding({ state: "resolved", disposition: "fixed" });
    const reopened = reopenFinding(resolved);

    expect(reopened).toMatchObject({
      id: "F-001",
      state: "open",
      disposition: "pending",
    });
    expect(resolved).toMatchObject({ state: "resolved", disposition: "fixed" });
    expect(reopened.id).toBe(resolved.id);
  });
});
