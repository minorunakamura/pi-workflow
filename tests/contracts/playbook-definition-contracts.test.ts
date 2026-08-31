import { describe, expect, it } from "vitest";
import {
  GATE_POLICIES,
  PLAYBOOK_DEFINITIONS,
  PLAYBOOK_IDS,
} from "../../src/playbooks/definitions.js";

const definitionsById = new Map(
  PLAYBOOK_DEFINITIONS.map((definition) => [definition.id, definition]),
);

describe("playbook definitions", () => {
  it("defines exactly the six Phase 1 Playbooks", () => {
    expect(PLAYBOOK_DEFINITIONS).toHaveLength(6);
    expect(PLAYBOOK_DEFINITIONS.map(({ id }) => id)).toEqual([...PLAYBOOK_IDS]);
    expect(new Set(PLAYBOOK_DEFINITIONS.map(({ id }) => id)).size).toBe(6);
    expect(PLAYBOOK_DEFINITIONS.every(({ version }) => version === "1.0.0")).toBe(true);
  });

  it("preserves the Gate Matrix policy for every Playbook", () => {
    expect(PLAYBOOK_DEFINITIONS.map(({ id, gatePolicy }) => ({ id, ...gatePolicy }))).toEqual([
      { id: "feature", evidence: "conditional", verification: "required", review: "required" },
      { id: "bug", evidence: "required", verification: "required", review: "required" },
      { id: "hotfix", evidence: "required", verification: "required", review: "required" },
      { id: "chore", evidence: "conditional", verification: "required", review: "conditional" },
      { id: "refactor", evidence: "required", verification: "required", review: "required" },
      {
        id: "investigation",
        evidence: "required",
        verification: "not-applicable",
        review: "required",
      },
    ]);

    for (const definition of PLAYBOOK_DEFINITIONS) {
      expect(definition.gatePolicy).toBe(GATE_POLICIES[definition.id]);
    }
  });

  it("requires root-cause evidence for Bug and Hotfix", () => {
    expect(definitionsById.get("bug")?.requirements.must).toEqual(
      expect.arrayContaining([expect.stringMatching(/root-cause|causal evidence/i)]),
    );
    expect(definitionsById.get("hotfix")?.requirements.must).toEqual(
      expect.arrayContaining([expect.stringMatching(/root-cause evidence/i)]),
    );
  });

  it("requires invariant and behavior-preservation evidence for Refactor", () => {
    const requirements = definitionsById.get("refactor")?.requirements.must ?? [];

    expect(requirements).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/invariants.*behavior-preservation basis/i),
        expect.stringMatching(/behavior preservation.*build success/i),
      ]),
    );
  });

  it("keeps Investigation read-only without normal Worker or Verification", () => {
    const investigation = definitionsById.get("investigation");
    const agents =
      investigation?.baseGraph.flatMap((step) => ("agent" in step ? [step.agent] : [])) ?? [];

    expect(agents).not.toContain("worker");
    expect(agents).not.toContain("verifier");
    expect(investigation?.gatePolicy.verification).toBe("not-applicable");
    expect(investigation?.requirements.mustNot).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/normal Worker Step/i),
        expect.stringMatching(/normal Verification Run/i),
      ]),
    );
  });

  it("keeps mandatory and conditional base work explicit", () => {
    expect(definitionsById.get("feature")?.baseGraph.every(({ required }) => required)).toBe(true);
    expect(definitionsById.get("chore")?.baseGraph.at(-1)).toMatchObject({
      agent: "reviewer",
      required: false,
    });
    expect(definitionsById.get("chore")?.requirements.must).toEqual(
      expect.arrayContaining([expect.stringMatching(/Verifier is mandatory/i)]),
    );
    expect(definitionsById.get("feature")?.requirements.may).toEqual(
      expect.arrayContaining([expect.stringMatching(/Researcher\/Oracle/i)]),
    );
  });
});
