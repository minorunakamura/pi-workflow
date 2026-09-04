import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFrontmatter, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { CORE_SKILL_IDS, SKILL_ALLOWLISTS } from "../../src/agents/definitions.js";

const projectRoot = resolve(import.meta.dirname, "../..");
const placeholderPatterns = [
  /will be added/i,
  /will be implemented/i,
  /\bTODO\b/i,
  /\bplaceholder\b/i,
  /not implemented/i,
  /\bTBD\b/i,
  /implementation[\s-]*deferred/i,
];
const requiredSections = [
  /purpose|responsibility/i,
  /when to use|applicability/i,
  /inputs? and evidence/i,
  /^procedure$/i,
  /expected output(?: and)? evidence/i,
  /constraints/i,
  /stopping|escalation/i,
];

type SkillIssue =
  | "missing file"
  | "invalid metadata.name"
  | "invalid metadata.version"
  | "invalid metadata.description"
  | "invalid metadata.dependencies"
  | "invalid metadata.capabilities"
  | "invalid metadata.preferred_artifacts"
  | "invalid metadata.requirements"
  | "placeholder content"
  | `missing section: ${string}`
  | "insufficient procedure steps";

function skillIssues(id: string, source: string): readonly SkillIssue[] {
  const issues: SkillIssue[] = [];
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatter(source).frontmatter;
  } catch {
    return ["invalid metadata.name", "invalid metadata.version", "invalid metadata.description"];
  }

  if (frontmatter.name !== id) issues.push("invalid metadata.name");
  if (
    !(
      (typeof frontmatter.version === "string" && frontmatter.version.trim().length > 0) ||
      (typeof frontmatter.version === "number" && Number.isSafeInteger(frontmatter.version))
    )
  ) {
    issues.push("invalid metadata.version");
  }
  if (typeof frontmatter.description !== "string" || frontmatter.description.trim().length === 0) {
    issues.push("invalid metadata.description");
  }
  for (const field of [
    "dependencies",
    "capabilities",
    "preferred_artifacts",
    "requirements",
  ] as const) {
    if (!Array.isArray(frontmatter[field])) {
      issues.push(`invalid metadata.${field}`);
    }
  }

  if (placeholderPatterns.some((pattern) => pattern.test(source))) {
    issues.push("placeholder content");
  }

  const body = stripFrontmatter(source);
  const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1]?.trim() ?? "");
  for (const section of requiredSections) {
    if (!headings.some((heading) => section.test(heading))) {
      issues.push(`missing section: ${section.source}`);
    }
  }

  const procedureHeading = body.search(/^##\s+Procedure\s*$/im);
  const procedure =
    procedureHeading < 0
      ? ""
      : (body
          .slice(procedureHeading)
          .replace(/^##\s+Procedure\s*\n?/i, "")
          .split(/^##\s+/m)[0] ?? "");
  const steps = procedure.match(/^\s*\d+\.\s+\S+/gm) ?? [];
  if (steps.length < 3) issues.push("insufficient procedure steps");

  return issues;
}

describe("Phase 1 Core Skill implementation contract", () => {
  it("requires all nine Skills to have valid metadata and executable procedures", () => {
    for (const id of CORE_SKILL_IDS) {
      const path = resolve(projectRoot, "skills", id, "SKILL.md");
      expect(existsSync(path), `${id} must exist`).toBe(true);
      const source = readFileSync(path, "utf8");
      expect(skillIssues(id, source), id).toEqual([]);
    }
  });

  it("detects missing structure and implementation-deferred content", () => {
    const source = `---
name: sample
version: 1.0.0
description: sample
---
# sample
This placeholder will be implemented later.
`;

    expect(skillIssues("sample", source)).toEqual(
      expect.arrayContaining([
        "placeholder content",
        "missing section: ^procedure$",
        "insufficient procedure steps",
      ]),
    );
  });

  it("projects materiality and stopping boundaries into uncertainty-producing Skills", () => {
    const expectedMarkers = {
      how: "Treat a missing convention, caller, CI, or external contract as an observation/evidence boundary",
      why: "Do not turn absent history, convention, caller, CI, or external evidence into a blocking Uncertainty by itself",
      "blast-radius": "absence-of-evidence observation",
      interrogate: "Do not generate a question merely for completeness.",
      "figure-it-out":
        "Do not treat absent evidence, an unobserved caller, or a hypothetical external risk",
    } as const;

    for (const [id, marker] of Object.entries(expectedMarkers)) {
      const source = readFileSync(resolve(projectRoot, "skills", id, "SKILL.md"), "utf8");
      expect(source, id).toContain(marker);
    }
  });

  it("preserves the Phase 1 allowlist boundary, including Reviewer without figure-it-out", () => {
    expect(SKILL_ALLOWLISTS).toEqual({
      scout: ["how", "why", "blast-radius", "interrogate", "figure-it-out", "reflect"],
      researcher: ["interrogate", "figure-it-out", "reflect"],
      planner: ["architect", "tdd", "interrogate", "figure-it-out", "reflect"],
      oracle: ["architect", "interrogate", "figure-it-out", "reflect"],
      worker: ["tdd", "figure-it-out", "show-me-your-work", "reflect"],
      verifier: ["figure-it-out", "show-me-your-work", "reflect"],
      reviewer: ["blast-radius", "interrogate", "show-me-your-work", "reflect"],
    });
  });
});
