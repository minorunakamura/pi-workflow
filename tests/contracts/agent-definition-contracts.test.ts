import { describe, expect, it } from "vitest";
import { AGENT_DEFINITIONS, AGENT_IDS, SKILL_ALLOWLISTS } from "../../src/agents/definitions.js";

const definitionsById = new Map(AGENT_DEFINITIONS.map((definition) => [definition.id, definition]));

describe("agent definitions", () => {
  it("defines exactly the seven formal Agents and no Judge", () => {
    expect(AGENT_DEFINITIONS).toHaveLength(7);
    expect(AGENT_DEFINITIONS.map(({ id }) => id)).toEqual([...AGENT_IDS]);
    expect(new Set(AGENT_DEFINITIONS.map(({ id }) => id)).size).toBe(7);
    expect(AGENT_DEFINITIONS.map(({ id }) => id)).not.toContain("judge");
    expect(AGENT_DEFINITIONS.every(({ version }) => version === "1.0.0")).toBe(true);
  });

  it("preserves the specified mode and authority for every Agent", () => {
    expect(
      AGENT_DEFINITIONS.map((definition) => ({
        id: definition.id,
        mode: definition.mode,
        maximumNormalAuthority: definition.maximumNormalAuthority,
        ...("authorityScope" in definition ? { authorityScope: definition.authorityScope } : {}),
      })),
    ).toEqual([
      { id: "scout", mode: "read-only", maximumNormalAuthority: "D0" },
      { id: "researcher", mode: "read-only", maximumNormalAuthority: "D0" },
      { id: "planner", mode: "read-only", maximumNormalAuthority: "D1" },
      {
        id: "oracle",
        mode: "read-only",
        maximumNormalAuthority: "recommendation-only",
        authorityScope: "D2/D3 remain external authority",
      },
      {
        id: "worker",
        mode: "write",
        maximumNormalAuthority: "D1",
        authorityScope: "within approved Plan/Write Scope",
      },
      { id: "verifier", mode: "verify-only", maximumNormalAuthority: "D0" },
      { id: "reviewer", mode: "read-only", maximumNormalAuthority: "D0" },
    ]);
  });

  it("preserves the exact Phase 1 Skill allowlists", () => {
    expect(SKILL_ALLOWLISTS).toEqual({
      scout: ["how", "why", "blast-radius", "interrogate", "figure-it-out", "reflect"],
      researcher: ["interrogate", "figure-it-out", "reflect"],
      planner: ["architect", "tdd", "interrogate", "figure-it-out", "reflect"],
      oracle: ["architect", "interrogate", "figure-it-out", "reflect"],
      worker: ["tdd", "figure-it-out", "show-me-your-work", "reflect"],
      verifier: ["figure-it-out", "show-me-your-work", "reflect"],
      reviewer: ["blast-radius", "interrogate", "show-me-your-work", "reflect"],
    });

    for (const definition of AGENT_DEFINITIONS) {
      expect(definition.skillAllowlist).toBe(SKILL_ALLOWLISTS[definition.id]);
    }

    expect(SKILL_ALLOWLISTS.reviewer).not.toContain("figure-it-out");
  });

  it("keeps forbidden behavior and Scout primary Skills explicit", () => {
    expect(definitionsById.get("scout")).toMatchObject({
      primarySkills: ["how", "why", "blast-radius"],
      requirements: {
        mustNot: [
          "Produce the final implementation design, final Plan, or source change.",
          "Mutate repository source.",
        ],
      },
    });
    expect(definitionsById.get("worker")?.requirements.mustNot).toEqual([
      "Perform Git write operations such as commit, push, merge, rebase, reset, restore, clean, or branch mutation under normal Phase 1 policy.",
      "Make material off-plan D2/D3 choices autonomously.",
      "Treat Worker checks as Formal Verification.",
    ]);
    expect(definitionsById.get("reviewer")?.requirements.mustNot).toContain(
      "Use figure-it-out in the Phase 1 allowlist; review should surface uncertainty rather than silently solve around it.",
    );
  });
});
