import type { SkillReference } from "../contracts/execution/agent-execution.js";
import { AGENT_DEFINITIONS, type AgentDefinition, type AgentId } from "./definitions.js";

export type SkillDependency = string | SkillReference;

export type SkillResource = Readonly<{
  id: string;
  version: string;
  description: string;
  dependencies?: readonly SkillDependency[];
  capabilities?: readonly string[];
  preferredArtifacts?: readonly string[];
  requirements?: readonly string[];
  content?: string;
  loadContent?: () => string;
}>;

export type SkillMetadata = Readonly<{
  id: string;
  version: string;
  description: string;
  dependencies: readonly SkillDependency[];
  capabilities: readonly string[];
  preferredArtifacts: readonly string[];
  requirements: readonly string[];
}>;

export type ResolvedSkill = Readonly<SkillMetadata & { content: string }>;

type CatalogSkill = SkillMetadata & {
  key: string;
  loadContent: () => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Skill Catalog ${label} must not be empty`);
  }
  return value.trim();
}

function stringList(value: unknown, label: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Skill Catalog ${label} must be an array`);
  }
  return value.map((entry, index) => requiredText(entry, `${label}[${index}]`));
}

function dependency(value: unknown, label: string): SkillDependency {
  if (typeof value === "string") {
    return requiredText(value, label);
  }
  if (!isRecord(value)) {
    throw new Error(`Skill Catalog ${label} must be a Skill ID or reference`);
  }

  return {
    id: requiredText(value.id, `${label}.id`),
    version: requiredText(value.version, `${label}.version`),
  };
}

function dependencyList(value: unknown, label: string): readonly SkillDependency[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Skill Catalog ${label} must be an array`);
  }
  return value.map((entry, index) => dependency(entry, `${label}[${index}]`));
}

function skillKey(id: string, version: string): string {
  return `${id}\u0000${version}`;
}

function normalizeResource(resource: SkillResource): CatalogSkill {
  const id = requiredText(resource.id, "Skill ID");
  const version = requiredText(resource.version, `Skill ${id} version`);
  const content = resource.content;
  const loadContent = resource.loadContent;

  if (content !== undefined && typeof content !== "string") {
    throw new Error(`Skill Catalog content must be a string: ${id}@${version}`);
  }
  if (loadContent !== undefined && typeof loadContent !== "function") {
    throw new Error(`Skill Catalog content loader must be a function: ${id}@${version}`);
  }
  const contentLoader = content !== undefined ? () => content : loadContent;
  if (contentLoader === undefined) {
    throw new Error(`Skill Catalog content is unavailable: ${id}@${version}`);
  }

  return {
    id,
    version,
    description: requiredText(resource.description, `Skill ${id} description`),
    dependencies: dependencyList(resource.dependencies, `Skill ${id} dependencies`),
    capabilities: stringList(resource.capabilities, `Skill ${id} capabilities`),
    preferredArtifacts: stringList(resource.preferredArtifacts, `Skill ${id} preferredArtifacts`),
    requirements: stringList(resource.requirements, `Skill ${id} requirements`),
    key: skillKey(id, version),
    loadContent: contentLoader,
  };
}

function metadata(skill: CatalogSkill): SkillMetadata {
  return {
    id: skill.id,
    version: skill.version,
    description: skill.description,
    dependencies: skill.dependencies,
    capabilities: skill.capabilities,
    preferredArtifacts: skill.preferredArtifacts,
    requirements: skill.requirements,
  };
}

export class SkillCatalog {
  private readonly skills: readonly CatalogSkill[];
  private readonly skillsByKey: ReadonlyMap<string, CatalogSkill>;
  private readonly skillsById: ReadonlyMap<string, readonly CatalogSkill[]>;
  private readonly agentsById: ReadonlyMap<string, AgentDefinition>;

  constructor(
    resources: readonly SkillResource[],
    agentDefinitions: readonly AgentDefinition[] = AGENT_DEFINITIONS,
  ) {
    const skills = resources.map(normalizeResource);
    const skillsByKey = new Map<string, CatalogSkill>();
    const skillsById = new Map<string, CatalogSkill[]>();

    for (const skill of skills) {
      if (skillsByKey.has(skill.key)) {
        throw new Error(`Skill Catalog duplicate Skill: ${skill.id}@${skill.version}`);
      }
      skillsByKey.set(skill.key, skill);
      const versions = skillsById.get(skill.id) ?? [];
      versions.push(skill);
      skillsById.set(skill.id, versions);
    }

    const agentsById = new Map<string, AgentDefinition>();
    for (const definition of agentDefinitions) {
      if (agentsById.has(definition.id)) {
        throw new Error(`Skill Catalog duplicate Agent: ${definition.id}`);
      }
      agentsById.set(definition.id, definition);
    }

    this.skills = skills;
    this.skillsByKey = skillsByKey;
    this.skillsById = skillsById;
    this.agentsById = agentsById;

    this.validateDependencies();
    this.validateAllowlists();
  }

  list(): readonly SkillMetadata[] {
    return this.skills.map(metadata);
  }

  resolve(agentId: AgentId, selected: readonly SkillReference[]): readonly ResolvedSkill[] {
    const definition = this.agentsById.get(agentId);
    if (definition === undefined) {
      throw new Error(`Skill Catalog unknown Agent: ${agentId}`);
    }
    if (!Array.isArray(selected)) {
      throw new Error("Skill Catalog selected Skills must be an array");
    }

    const allowlist = new Set<string>(definition.skillAllowlist);
    const resolved = new Set<string>();
    const resolving = new Set<string>();
    const result: ResolvedSkill[] = [];

    const resolveSkill = (skill: CatalogSkill): void => {
      if (!allowlist.has(skill.id)) {
        throw new Error(
          `Skill Catalog Skill is not allowlisted for ${agentId}: ${skill.id}@${skill.version}`,
        );
      }
      if (resolved.has(skill.key)) {
        return;
      }
      if (resolving.has(skill.key)) {
        throw new Error(`Skill Catalog dependency cycle at ${skill.id}@${skill.version}`);
      }

      resolving.add(skill.key);
      for (const required of skill.dependencies) {
        const dependencySkill = this.resolveDependency(skill, required);
        resolveSkill(dependencySkill);
      }

      const content = skill.loadContent();
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error(`Skill Catalog content is empty: ${skill.id}@${skill.version}`);
      }
      result.push({ ...metadata(skill), content });
      resolving.delete(skill.key);
      resolved.add(skill.key);
    };

    for (const reference of selected) {
      if (!isRecord(reference)) {
        throw new Error("Skill Catalog selected Skill must be a reference");
      }
      const id = requiredText(reference.id, "selected Skill ID");
      const version = requiredText(reference.version, "selected Skill version");
      const skill = this.skillsByKey.get(skillKey(id, version));
      if (skill === undefined) {
        throw new Error(`Skill Catalog missing Skill: ${id}@${version}`);
      }
      resolveSkill(skill);
    }

    return result;
  }

  resolveForAgent(agentId: AgentId, selected: readonly SkillReference[]): readonly ResolvedSkill[] {
    return this.resolve(agentId, selected);
  }

  private resolveDependency(skill: CatalogSkill, required: SkillDependency): CatalogSkill {
    const id = typeof required === "string" ? required : required.id;
    const version = typeof required === "string" ? undefined : required.version;
    const candidates = this.skillsById.get(id) ?? [];

    if (version !== undefined) {
      const resolved = this.skillsByKey.get(skillKey(id, version));
      if (resolved === undefined) {
        throw new Error(
          `Skill Catalog missing dependency for ${skill.id}@${skill.version}: ${id}@${version}`,
        );
      }
      return resolved;
    }

    if (candidates.length === 0) {
      throw new Error(`Skill Catalog missing dependency for ${skill.id}@${skill.version}: ${id}`);
    }
    if (candidates.length > 1) {
      throw new Error(`Skill Catalog ambiguous dependency for ${skill.id}@${skill.version}: ${id}`);
    }
    const [resolved] = candidates;
    if (resolved === undefined) {
      throw new Error(`Skill Catalog missing dependency for ${skill.id}@${skill.version}: ${id}`);
    }
    return resolved;
  }

  private validateDependencies(): void {
    const visited = new Set<string>();
    const resolving = new Set<string>();

    const visit = (skill: CatalogSkill): void => {
      if (visited.has(skill.key)) {
        return;
      }
      if (resolving.has(skill.key)) {
        throw new Error(`Skill Catalog dependency cycle at ${skill.id}@${skill.version}`);
      }

      resolving.add(skill.key);
      for (const required of skill.dependencies) {
        visit(this.resolveDependency(skill, required));
      }
      resolving.delete(skill.key);
      visited.add(skill.key);
    };

    for (const skill of this.skills) {
      visit(skill);
    }
  }

  private validateAllowlists(): void {
    for (const definition of this.agentsById.values()) {
      const seen = new Set<string>();
      for (const skillId of definition.skillAllowlist) {
        if (seen.has(skillId)) {
          throw new Error(
            `Skill Catalog duplicate allowlisted Skill: ${definition.id} -> ${skillId}`,
          );
        }
        seen.add(skillId);
        if (!this.skillsById.has(skillId)) {
          throw new Error(
            `Skill Catalog allowlist references missing Skill: ${definition.id} -> ${skillId}`,
          );
        }
      }
    }
  }
}
