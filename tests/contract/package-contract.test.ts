import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(`${repoRoot}/package.json`, "utf8"),
) as Record<string, unknown>;
const piManifest = packageJson.pi as { extensions: string[]; skills: string[] };

const workflowScripts = [
  "discovery.js",
  "research.js",
  "planning.js",
  "implementation.js",
  "verification.js",
  "verification-fix.js",
  "review.js",
];

const skills = ["pi-workflow", "pi-planning", "pi-verification"];

describe("package contract", () => {
  it("declares the Pi package resources", () => {
    expect(packageJson.keywords).toContain("pi-package");
    expect(piManifest).toEqual({
      extensions: ["./src/index.ts"],
      skills: ["./skills"],
    });
  });

  it("does not bundle an external runtime", () => {
    expect(packageJson.dependencies ?? {}).not.toHaveProperty("pi-subagents");
    expect(packageJson.bundledDependencies ?? []).not.toContain("pi-subagents");
    expect(packageJson.dependencies ?? {}).not.toHaveProperty("plannotator");
    expect(packageJson.dependencies ?? {}).not.toHaveProperty("ponytail");
    expect(packageJson.dependencies ?? {}).not.toHaveProperty("pi-ketch");
    expect(packageJson.dependencies ?? {}).not.toHaveProperty(
      "pi-ask-user-question",
    );
    expect(existsSync(`${repoRoot}/agents`)).toBe(false);
  });

  it("contains exactly the Step 1 workflow resources", () => {
    expect(readdirSync(`${repoRoot}/workflow-scripts`).toSorted()).toEqual(
      workflowScripts.toSorted(),
    );

    for (const skill of skills) {
      const path = `${repoRoot}/skills/${skill}/SKILL.md`;
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, "utf8");
      expect(content).toMatch(/^---\nname: [a-z0-9-]+\ndescription: .+\n---\n/);
    }
  });
});
