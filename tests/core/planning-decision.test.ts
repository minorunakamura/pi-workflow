import { describe, expect, it } from "vitest";
import {
  validatePlanningDecision,
  validatePlanningDecisionForApproval,
  type PlanningDecisionV1,
} from "../../src/core/planning/planning-decision";

const validDecision: PlanningDecisionV1 = {
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
      command: "pnpm test -- search",
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

describe("validatePlanningDecision", () => {
  it("accepts a dependency-free WorkUnit with dependsOn: []", () => {
    const result = validatePlanningDecision(validDecision);

    expect(result).toEqual({ ok: true, value: validDecision, errors: [] });
  });

  it("accepts a dependency that references a defined WorkUnit ID", () => {
    const dependent = structuredClone(validDecision);
    dependent.implementation.workUnits.push({
      ...structuredClone(validDecision.implementation.workUnits[0]),
      id: "search-index",
      title: "Add the search index",
      objective: "Make search lookups fast.",
      dependsOn: ["search-api"],
    });

    expect(validatePlanningDecision(dependent)).toEqual({
      ok: true,
      value: dependent,
      errors: [],
    });
  });

  it.each(["なし", "none", "N/A"])(
    "rejects explanatory dependency text: %s",
    (dependency) => {
      const invalid = structuredClone(validDecision);
      invalid.implementation.workUnits[0].dependsOn = [dependency];

      const result = validatePlanningDecision(invalid);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContainEqual({
          path: "/implementation/workUnits/0/dependsOn/0",
          message:
            "work unit search-api references unknown dependency " + dependency,
        });
      }
    },
  );

  it("rejects an unknown WorkUnit dependency ID", () => {
    const invalid = structuredClone(validDecision);
    invalid.implementation.workUnits[0].dependsOn = ["missing-work-unit"];

    const result = validatePlanningDecision(invalid);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        path: "/implementation/workUnits/0/dependsOn/0",
        message:
          "work unit search-api references unknown dependency missing-work-unit",
      });
    }
  });

  it("rejects duplicate ids and unknown references", () => {
    const invalid = structuredClone(validDecision);
    invalid.acceptanceCriteria.push({ id: "ac-search", text: "Duplicate." });
    invalid.implementation.workUnits[0].acceptanceCriteriaIds = ["missing"];
    invalid.implementation.finalVerificationIds = ["missing"];

    const result = validatePlanningDecision(invalid);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.message)).toEqual(
        expect.arrayContaining([
          "acceptanceCriteria ids must be unique",
          "work unit search-api references unknown acceptance criterion missing",
          "final verification references unknown verification missing",
        ]),
      );
    }
  });

  it("rejects an empty write scope", () => {
    const invalid = structuredClone(validDecision);
    invalid.implementation.workUnits[0].writeScope = [];

    const result = validatePlanningDecision(invalid);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        path: "/implementation/workUnits/0/writeScope",
        message: "writeScope must contain at least one path",
      });
    }
  });

  it("keeps unresolved decisions valid but blocks approval readiness", () => {
    const unresolved = structuredClone(validDecision);
    unresolved.unresolvedDecisions = [
      {
        id: "decision-1",
        question: "Which index should be used?",
        reason: "The repository evidence is inconclusive.",
      },
    ];

    expect(validatePlanningDecision(unresolved).ok).toBe(true);
    const approval = validatePlanningDecisionForApproval(unresolved);

    expect(approval).toEqual({
      ok: false,
      errors: [
        {
          path: "/unresolvedDecisions",
          message: "unresolved decisions must be resolved before plan review",
        },
      ],
    });
  });

  it("rejects dependencies in lane mode because all units are parallel lanes", () => {
    const invalid = structuredClone(validDecision);
    invalid.implementation.mode = "lanes";
    invalid.implementation.workUnits[0].dependsOn = ["other-unit"];

    const result = validatePlanningDecision(invalid);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        path: "/implementation/workUnits",
        message: "lane mode work units must not depend on another work unit",
      });
    }
  });
});
