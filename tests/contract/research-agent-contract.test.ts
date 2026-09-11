import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RESEARCH_SEARCH_BACKENDS } from "../../src/researcher-tools";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const agent = readFileSync(`${repoRoot}/agents/researcher.md`, "utf8");
const research = readFileSync(
  `${repoRoot}/workflow-scripts/research.js`,
  "utf8",
);
const restrictedSearch = readFileSync(
  `${repoRoot}/src/researcher-tools.ts`,
  "utf8",
);

const tools = [
  "pi_workflow_ketch_search",
  "ketch_code",
  "ketch_docs",
  "ketch_scrape",
] as const;

describe("package-owned Research Agent contract", () => {
  it("is discoverable as pi-workflow.researcher with a strict foreground policy", () => {
    expect(agent).toContain("name: researcher");
    expect(agent).toContain("package: pi-workflow");
    expect(agent).toContain("defaultContext: fresh");
    expect(agent).toContain("async: false");
    expect(agent).toContain("acceptanceRole: read-only");
    expect(agent).toContain(
      "extensions: ../node_modules/pi-ketch, ../../pi-ketch",
    );
    expect(agent).toContain(
      "subagentOnlyExtensions: ../src/researcher-tools.ts",
    );
    expect(agent).toContain(`tools: ${tools.join(", ")}`);
    expect(agent).not.toContain("tools: ketch_search");
    expect(agent).not.toContain("tools: read");
    expect(agent).not.toContain("tools: bash");
    expect(agent).not.toContain("tools: write");
    expect(agent).not.toContain("tools: edit");
    expect(agent).not.toContain("tools: subagent");
  });

  it("uses the public Search API without copying Ketch internals", () => {
    expect(restrictedSearch).toContain('from "pi-ketch/search"');
    for (const forbidden of [
      "pi-ketch/src/",
      "pi-ketch/src/runtime/",
      "pi-ketch/src/tools/",
      "runKetch",
      "child_process",
    ]) {
      expect(restrictedSearch).not.toContain(forbidden);
    }
  });

  it("uses the package-owned Agent and never the generic Ketch Agent", () => {
    expect(research).toContain('agent: "pi-workflow.researcher"');
    expect(research).not.toContain('agent: "pi-ketch.researcher"');
  });

  it("fixes the allowed Ketch single-provider values to the current CLI contract", () => {
    expect(RESEARCH_SEARCH_BACKENDS).toEqual([
      "brave",
      "ddg",
      "searxng",
      "exa",
      "firecrawl",
      "keenable",
    ]);
    expect(RESEARCH_SEARCH_BACKENDS).not.toContain("all");
    expect(RESEARCH_SEARCH_BACKENDS).not.toContain("random");
  });
});
