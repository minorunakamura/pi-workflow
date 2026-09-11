import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const coreRoot = `${repoRoot}/src/core`;

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = `${root}/${entry.name}`;
    return entry.isDirectory()
      ? sourceFiles(path)
      : path.endsWith(".ts")
        ? [path]
        : [];
  });
}

function sourceJavaScriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = `${root}/${entry.name}`;
    return entry.isDirectory()
      ? sourceJavaScriptFiles(path)
      : path.endsWith(".js") || path.endsWith(".mjs")
        ? [path]
        : [];
  });
}

describe("architecture contract", () => {
  it("keeps plain Node runtime assets outside src", () => {
    expect(sourceJavaScriptFiles(`${repoRoot}/src`)).toEqual([]);
  });

  it("keeps core independent from Pi and adapter layers", () => {
    const forbiddenImports = [
      "@earendil-works/pi-coding-agent",
      "../commands",
      "../../commands",
      "../tools",
      "../../tools",
      "../runtime",
      "../../runtime",
    ];

    for (const file of sourceFiles(coreRoot)) {
      const content = readFileSync(file, "utf8");
      for (const forbiddenImport of forbiddenImports) {
        expect(content, file).not.toContain(forbiddenImport);
      }
    }
  });

  it("keeps the extension entry point registration-only", () => {
    const entry = readFileSync(`${repoRoot}/src/index.ts`, "utf8");

    expect(entry).toContain("registerTools");
    expect(entry).toContain("registerWorkflowResourceLifecycle");
    expect(entry).not.toContain("subagent");
    expect(entry).not.toContain("mission");
    expect(entry).not.toContain("workflowScript");
  });

  it("uses only the public workflow resource boundary", () => {
    const runtime = readFileSync(
      `${repoRoot}/src/runtime/workflow-resources.ts`,
      "utf8",
    );

    expect(runtime).toContain('"pi-subagents/workflow-resources"');
    expect(runtime).not.toContain("pi-subagents/src/");
    expect(runtime).not.toContain("Symbol.for");
    expect(runtime).not.toContain("globalThis");
  });

  it("declares only the package-owned Research Agent", () => {
    expect(readdirSync(`${repoRoot}/agents`).toSorted()).toEqual([
      "researcher.md",
    ]);
  });
});
