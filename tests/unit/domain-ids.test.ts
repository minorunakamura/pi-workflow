import { describe, expect, it } from "vitest";
import {
  createIdAllocator,
  createPlanUnitReference,
  createVerificationCheckReference,
  type PlanUnitId,
  type VerificationCheckId,
} from "../../src/domain/primitives/ids.js";

const acceptPlanUnitId = (_id: PlanUnitId): void => {};
const acceptVerificationCheckId = (_id: VerificationCheckId): void => {};

describe("domain IDs", () => {
  it("issues the documented ID families with distinct types", () => {
    const ids = createIdAllocator();

    expect([
      ids.issueRunId(),
      ids.issueStepId(),
      ids.issueExecutionId(),
      ids.issueUncertaintyId(),
      ids.issueDecisionId(),
      ids.issueGateId(),
      ids.issueFindingId(),
      ids.issuePlanUnitId(1),
      ids.issueVerificationCheckId(1),
      ids.issuePlanDeviationId(),
      ids.issueChangeSetId(),
      ids.issueVerificationRunId(),
      ids.issueReviewRunId(),
    ]).toEqual([
      "run-001",
      "step-001",
      "exec-001",
      "U-001",
      "D-001",
      "G-001",
      "F-001",
      "P-001",
      "V-001",
      "PD-001",
      "CS-001",
      "VR-001",
      "RR-001",
    ]);

    const planUnitId = ids.issuePlanUnitId(1);
    const verificationCheckId = ids.issueVerificationCheckId(1);

    acceptPlanUnitId(planUnitId);
    acceptVerificationCheckId(verificationCheckId);
    // @ts-expect-error Plan Unit and Verification Check IDs must not be interchangeable.
    acceptVerificationCheckId(planUnitId);
  });

  it("does not reuse an issued sequence number and scopes P/V sequences by Plan version", () => {
    const ids = createIdAllocator();
    const first = ids.issueChangeSetId();
    ids.issueChangeSetId();
    const third = ids.issueChangeSetId();

    expect(first).toBe("CS-001");
    expect(third).toBe("CS-003");
    expect(ids.issuePlanUnitId(1)).toBe("P-001");
    expect(ids.issuePlanUnitId(1)).toBe("P-002");
    expect(ids.issuePlanUnitId(2)).toBe("P-001");
    expect(ids.issueVerificationCheckId(2)).toBe("V-001");
  });

  it("requires Plan version context on P/V references", () => {
    const ids = createIdAllocator();
    const planUnit = ids.issuePlanUnitReference(3);
    const verificationCheck = ids.issueVerificationCheckReference(3);

    expect(planUnit).toEqual({ id: "P-001", planVersion: 3 });
    expect(verificationCheck).toEqual({ id: "V-001", planVersion: 3 });
    expect(createPlanUnitReference(ids.issuePlanUnitId(3), 3)).toEqual({
      id: "P-002",
      planVersion: 3,
    });
    expect(createVerificationCheckReference(ids.issueVerificationCheckId(3), 3)).toEqual({
      id: "V-002",
      planVersion: 3,
    });
  });

  it("rejects invalid Plan versions", () => {
    const ids = createIdAllocator();

    expect(() => ids.issuePlanUnitId(0)).toThrow(RangeError);
    expect(() => ids.issueVerificationCheckReference(Number.NaN)).toThrow(RangeError);
  });
});
