import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(`${repoRoot}/package.json`, "utf8"),
) as Record<string, unknown>;
const lockfile = readFileSync(`${repoRoot}/pnpm-lock.yaml`, "utf8");
const piSubagentsPackage = JSON.parse(
  readFileSync(`${repoRoot}/node_modules/pi-subagents/package.json`, "utf8"),
) as { name: string; version: string; bin?: Record<string, string> };
const piManifest = packageJson.pi as {
  extensions: string[];
  skills: string[];
  subagents: { agents: string[] };
};

const workflowScripts = ["discovery.js", "research.js", "planning.js"];

const skills = ["pi-workflow", "pi-planning"];

describe("package contract", () => {
  it("requires pi-subagents 0.67.0 as a peer and development dependency", () => {
    expect(packageJson.peerDependencies).toMatchObject({
      "pi-subagents": "0.67.0",
    });
    expect(packageJson.devDependencies).toMatchObject({
      "pi-subagents": "0.67.0",
    });
    expect(packageJson.dependencies ?? {}).not.toHaveProperty("pi-subagents");
    expect(packageJson.bundledDependencies ?? []).not.toContain("pi-subagents");
  });

  it("keeps the pnpm lockfile on the exact package version", () => {
    expect(lockfile).toMatch(
      /pi-subagents:\n\s+specifier: 0\.67\.0\n\s+version: 0\.67\.0\(/,
    );
  });

  it("checks pi-subagents metadata without executing its package bin", () => {
    expect(piSubagentsPackage).toMatchObject({
      name: "pi-subagents",
      version: "0.67.0",
      bin: { "pi-subagents": "install.mjs" },
    });
  });

  it("declares the Pi package resources", () => {
    expect(packageJson.keywords).toContain("pi-package");
    expect(piManifest).toEqual({
      extensions: ["./src/index.ts"],
      skills: ["./skills"],
      subagents: { agents: ["./agents"] },
    });
  });

  it("does not bundle an external runtime", () => {
    expect(packageJson.dependencies ?? {}).not.toHaveProperty("pi-subagents");
    expect(packageJson.bundledDependencies ?? []).not.toContain("pi-subagents");
    expect(packageJson.dependencies ?? {}).not.toHaveProperty("plannotator");
    expect(packageJson.dependencies ?? {}).not.toHaveProperty("ponytail");
    expect(packageJson.dependencies).toMatchObject({
      "pi-ketch": expect.stringContaining("github.com/minorunakamura/pi-ketch"),
    });
    expect(packageJson.bundledDependencies ?? []).not.toContain("pi-ketch");
    expect(packageJson.dependencies ?? {}).not.toHaveProperty(
      "pi-ask-user-question",
    );
    expect(existsSync(`${repoRoot}/agents/researcher.md`)).toBe(true);
  });

  it("does not retain migration milestone validators", () => {
    expect(
      Object.keys(packageJson.scripts ?? {}).filter((script) =>
        /unit[56]|research:isolation/u.test(script),
      ),
    ).toEqual([]);

    const scriptsRoot = `${repoRoot}/scripts`;
    const scriptFiles = existsSync(scriptsRoot) ? readdirSync(scriptsRoot) : [];
    expect(
      scriptFiles.filter((file) =>
        /validate-(?:unit[56].*|research-isolation)\.mjs/u.test(file),
      ),
    ).toEqual([]);
  });

  it("contains exactly the Planning MVP workflow resources", () => {
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
