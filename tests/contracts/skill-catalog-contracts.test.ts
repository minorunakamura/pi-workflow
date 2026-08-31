import { resolve } from "node:path";
import { createSyntheticSourceInfo, type Skill as PiSkill } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { CORE_SKILL_IDS, type AgentDefinition } from "../../src/agents/definitions.js";
import { SkillCatalog, type SkillResource } from "../../src/agents/skill-catalog.js";
import { createPiPackageSkillCatalog } from "../../src/adapters/pi/skill-catalog.js";

const projectRoot = resolve(import.meta.dirname, "../..");

function coreResources(loads = new Map<string, number>()): SkillResource[] {
  return CORE_SKILL_IDS.map((id) => ({
    id,
    version: "1.0.0",
    description: `${id} description`,
    loadContent: () => {
      loads.set(id, (loads.get(id) ?? 0) + 1);
      return `# ${id}`;
    },
  }));
}

const scoutDefinition: AgentDefinition = {
  id: "scout",
  version: "1.0.0",
  role: "test scout",
  mode: "read-only",
  maximumNormalAuthority: "D0",
  skillAllowlist: ["how", "why"],
  requirements: { must: [], mustNot: [], may: [] },
};

function packageSkill(id: string): PiSkill {
  const filePath = resolve(projectRoot, "skills", id, "SKILL.md");
  return {
    name: id,
    description: `${id} description`,
    filePath,
    baseDir: resolve(projectRoot, "skills", id),
    sourceInfo: createSyntheticSourceInfo(filePath, {
      source: "pi-workflow",
      origin: "package",
    }),
    disableModelInvocation: false,
  };
}

describe("Skill Catalog contract", () => {
  it("discovers and versions all nine Core Skills without loading content", () => {
    const loads = new Map<string, number>();
    const catalog = new SkillCatalog(coreResources(loads));

    expect(catalog.list().map(({ id }) => id)).toEqual([...CORE_SKILL_IDS]);
    expect(catalog.list().every(({ version }) => version === "1.0.0")).toBe(true);
    expect([...loads.values()]).toEqual([]);
  });

  it("validates missing dependencies, dependency cycles, and allowlists", () => {
    expect(
      () =>
        new SkillCatalog(
          [
            {
              id: "how",
              version: "1.0.0",
              description: "how",
              dependencies: ["why"],
              content: "how",
            },
          ],
          [scoutDefinition],
        ),
    ).toThrow("missing dependency");

    expect(
      () =>
        new SkillCatalog(
          [
            {
              id: "how",
              version: "1.0.0",
              description: "how",
              dependencies: ["why"],
              content: "how",
            },
            {
              id: "why",
              version: "1.0.0",
              description: "why",
              dependencies: ["how"],
              content: "why",
            },
          ],
          [scoutDefinition],
        ),
    ).toThrow("dependency cycle");

    expect(
      () =>
        new SkillCatalog(coreResources().slice(0, 2), [
          { ...scoutDefinition, skillAllowlist: ["how", "reflect"] },
        ]),
    ).toThrow("allowlist references missing Skill");
  });

  it("loads only selected allowlisted Skills and their dependencies", () => {
    const loads = new Map<string, number>();
    const catalog = new SkillCatalog(
      [
        {
          id: "how",
          version: "1.0.0",
          description: "how",
          dependencies: ["why"],
          loadContent: () => {
            loads.set("how", (loads.get("how") ?? 0) + 1);
            return "how content";
          },
        },
        {
          id: "why",
          version: "1.0.0",
          description: "why",
          loadContent: () => {
            loads.set("why", (loads.get("why") ?? 0) + 1);
            return "why content";
          },
        },
        {
          id: "reflect",
          version: "1.0.0",
          description: "reflect",
          content: "reflect content",
        },
      ],
      [scoutDefinition],
    );

    expect(catalog.list()).toHaveLength(3);
    expect([...loads.values()]).toEqual([]);

    expect(catalog.resolve("scout", [{ id: "how", version: "1.0.0" }]).map(({ id }) => id)).toEqual(
      ["why", "how"],
    );
    expect(loads).toEqual(
      new Map([
        ["how", 1],
        ["why", 1],
      ]),
    );
    expect(() => catalog.resolve("scout", [{ id: "reflect", version: "1.0.0" }])).toThrow(
      "not allowlisted",
    );
  });

  it("resolves only Pi Package Skill resources", () => {
    const packageSkills = CORE_SKILL_IDS.map(packageSkill);
    const firstPackageSkill = packageSkills[0];
    if (firstPackageSkill === undefined) {
      throw new Error("Core Skill fixture is empty");
    }
    const projectSkill: PiSkill = {
      ...firstPackageSkill,
      sourceInfo: createSyntheticSourceInfo(firstPackageSkill.filePath, {
        source: "project",
        origin: "top-level",
      }),
    };
    const catalog = createPiPackageSkillCatalog({
      getSkills: () => ({
        skills: [...packageSkills, projectSkill],
        diagnostics: [],
      }),
    });

    expect(catalog.list().map(({ id }) => id)).toEqual([...CORE_SKILL_IDS]);
    expect(catalog.list().map(({ version }) => version)).toEqual(CORE_SKILL_IDS.map(() => "1.0.0"));
    expect(catalog.resolve("scout", [{ id: "how", version: "1.0.0" }])[0]?.content).toContain(
      "# how",
    );
  });
});
