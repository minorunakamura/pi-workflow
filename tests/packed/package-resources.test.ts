import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function packContents(): string[] {
  const destination = mkdtempSync(`${tmpdir()}/pi-workflow-pack-`);
  try {
    execFileSync("pnpm", ["pack", "--pack-destination", destination], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    const tarball = readdirSync(destination).find((file) =>
      file.endsWith(".tgz"),
    );
    if (!tarball) throw new Error("pnpm pack did not create an archive");
    return execFileSync("tar", ["-tzf", `${destination}/${tarball}`], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

describe("packed package contract", () => {
  it("contains the extension, Skills, and workflow scripts", () => {
    const contents = packContents();

    expect(contents).toEqual(
      expect.arrayContaining([
        "package/src/index.ts",
        "package/skills/pi-workflow/SKILL.md",
        "package/skills/pi-planning/SKILL.md",
        "package/agents/researcher.md",
        "package/workflow-scripts/discovery.js",
        "package/workflow-scripts/research.js",
        "package/workflow-scripts/planning.js",
        "package/src/core/planning/render-plan-runtime.js",
        "package/src/runtime/plan-artifact.js",
      ]),
    );
  });
});
