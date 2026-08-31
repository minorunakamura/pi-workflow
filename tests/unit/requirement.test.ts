import { describe, expect, it } from "vitest";
import {
  classifyRequirementImpact,
  createRequirement,
  reviseRequirement,
  validateRequirementCandidate,
} from "../../src/domain/requirements/requirement.js";

function requirement() {
  return createRequirement({
    goal: "deliver the requested behavior",
    acceptanceCriteria: [{ id: "AC-001", description: "the behavior is observable" }],
    constraints: [{ id: "C-001", description: "do not change the public API" }],
  });
}

describe("Requirement candidates and revisions", () => {
  it("validates the narrow candidate operation and effect vocabularies", () => {
    expect(validateRequirementCandidate({ operation: "add", effect: "preserving" })).toMatchObject({
      operation: "add",
      effect: "preserving",
    });
    expect(() =>
      validateRequirementCandidate({ operation: "replace", effect: "changing" }),
    ).toThrow(/Requirement candidate operation/);
    expect(() =>
      validateRequirementCandidate({ operation: "clarify", effect: "irrelevant" }),
    ).toThrow(/Requirement candidate effect/);
    expect(() =>
      validateRequirementCandidate({ operation: "clarify", effect: "changing", id: "AC-001" }),
    ).toThrow(/authoritative identity/);
  });

  it("preserves AC identity for clarification and supersedes deterministically on replacement", () => {
    const preserved = reviseRequirement(requirement(), {
      kind: "acceptanceCriteria",
      candidate: {
        operation: "clarify",
        effect: "preserving",
        targetId: "AC-001",
        description: "the behavior is observable and documented",
      },
    });

    expect(preserved.requirement.acceptanceCriteria[0]).toMatchObject({
      id: "AC-001",
      description: "the behavior is observable and documented",
    });
    expect(preserved.requirement.acceptanceCriteria[0]?.supersedes).toBeUndefined();
    expect(preserved.changes[0]).toMatchObject({
      resultingId: "AC-001",
      preservedIdentity: true,
    });

    const replaced = reviseRequirement(requirement(), {
      kind: "acceptanceCriteria",
      candidate: {
        operation: "clarify",
        effect: "changing",
        targetId: "AC-001",
        description: "a different behavior is required",
      },
    });

    expect(replaced.requirement.acceptanceCriteria[0]).toMatchObject({
      id: "AC-002",
      supersedes: "AC-001",
      description: "a different behavior is required",
    });
    expect(replaced.changes[0]).toMatchObject({
      resultingId: "AC-002",
      supersededId: "AC-001",
      preservedIdentity: false,
    });

    const added = reviseRequirement(replaced.requirement, {
      kind: "acceptanceCriteria",
      candidate: { operation: "add", effect: "narrowing", description: "a second behavior" },
    });
    expect(added.requirement.acceptanceCriteria.at(-1)?.id).toBe("AC-003");
    expect(added.requirement.revision).toBe(3);
  });

  it("classifies requirement effects into Plan impact and reclassification need", () => {
    expect(classifyRequirementImpact("preserving")).toEqual({
      planImpact: "current",
      requiresReclassification: false,
      requiresReplan: false,
    });
    expect(classifyRequirementImpact("narrowing")).toEqual({
      planImpact: "compatible",
      requiresReclassification: true,
      requiresReplan: false,
    });
    expect(classifyRequirementImpact({ operation: "add", effect: "broadening" })).toEqual({
      planImpact: "replan-required",
      requiresReclassification: true,
      requiresReplan: true,
    });
  });

  it("applies multiple candidates in order without reusing superseded identities", () => {
    const first = reviseRequirement(requirement(), [
      {
        kind: "constraints",
        candidate: {
          operation: "clarify",
          effect: "changing",
          targetId: "C-001",
          description: "the public API must remain compatible",
        },
      },
      {
        kind: "acceptanceCriteria",
        candidate: {
          operation: "add",
          effect: "broadening",
          description: "the edge case is covered",
        },
      },
    ]);
    const second = reviseRequirement(requirement(), [
      {
        kind: "constraints",
        candidate: {
          operation: "clarify",
          effect: "changing",
          targetId: "C-001",
          description: "the public API must remain compatible",
        },
      },
      {
        kind: "acceptanceCriteria",
        candidate: {
          operation: "add",
          effect: "broadening",
          description: "the edge case is covered",
        },
      },
    ]);

    expect(first).toEqual(second);
    expect(first.requirement.constraints[0]?.id).toBe("C-002");
    expect(first.requirement.acceptanceCriteria[1]?.id).toBe("AC-002");
    expect(first.impact).toMatchObject({
      planImpact: "replan-required",
      requiresReclassification: true,
      requiresReplan: true,
    });
  });
});
