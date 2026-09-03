import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  parseFrontmatter,
  stripFrontmatter,
  type ResourceLoader,
  type Skill as PiSkill,
} from "@earendil-works/pi-coding-agent";
import { AGENT_DEFINITIONS, type AgentDefinition } from "../../agents/definitions.js";
import {
  SkillCatalog,
  type SkillDependency,
  type SkillResource,
} from "../../agents/skill-catalog.js";

function normalizedVersion(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return undefined;
}

function providerPackageVersion(filePath: string): string | undefined {
  let directory = dirname(filePath);
  while (true) {
    const packageJsonPath = join(directory, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const manifest: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        return isRecord(manifest) ? normalizedVersion(manifest.version) : undefined;
      } catch {
        return undefined;
      }
    }

    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function version(value: unknown, skillName: string, filePath: string): string {
  const frontmatterVersion = normalizedVersion(value);
  if (frontmatterVersion !== undefined) return frontmatterVersion;
  if (value === undefined) {
    const packageVersion = providerPackageVersion(filePath);
    if (packageVersion !== undefined) return packageVersion;
  }
  throw new Error(
    `Pi package Skill must declare a version in frontmatter or its provider package.json: ${skillName}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataValue(
  frontmatter: Record<string, unknown>,
  key: string,
  alternateKey?: string,
): readonly unknown[] | undefined {
  const value = frontmatter[key] ?? (alternateKey ? frontmatter[alternateKey] : undefined);
  return value === undefined ? undefined : (value as readonly unknown[]);
}

function toResource(skill: PiSkill): SkillResource {
  const source = readFileSync(skill.filePath, "utf8");
  const { frontmatter } = parseFrontmatter(source);
  const capabilities = metadataValue(frontmatter, "capabilities");
  const preferredArtifacts = metadataValue(
    frontmatter,
    "preferred_artifacts",
    "preferredArtifacts",
  );
  const requirements = metadataValue(frontmatter, "requirements");

  return {
    id: skill.name,
    version: version(frontmatter.version, skill.name, skill.filePath),
    description: skill.description,
    ...(frontmatter.dependencies === undefined
      ? {}
      : { dependencies: frontmatter.dependencies as readonly SkillDependency[] }),
    ...(capabilities === undefined ? {} : { capabilities: capabilities as readonly string[] }),
    ...(preferredArtifacts === undefined
      ? {}
      : { preferredArtifacts: preferredArtifacts as readonly string[] }),
    ...(requirements === undefined ? {} : { requirements: requirements as readonly string[] }),
    loadContent: () => stripFrontmatter(readFileSync(skill.filePath, "utf8")),
  };
}

export function createPiPackageSkillCatalog(
  resourceLoader: Pick<ResourceLoader, "getSkills">,
  agentDefinitions: readonly AgentDefinition[] = AGENT_DEFINITIONS,
): SkillCatalog {
  const { skills, diagnostics } = resourceLoader.getSkills();
  const errors = diagnostics.filter(({ type }) => type === "error");
  if (errors.length > 0) {
    throw new Error(
      `Pi package Skill discovery failed: ${errors.map(({ message }) => message).join("; ")}`,
    );
  }

  return new SkillCatalog(
    skills.filter((skill) => skill.sourceInfo.origin === "package").map(toResource),
    agentDefinitions,
  );
}
