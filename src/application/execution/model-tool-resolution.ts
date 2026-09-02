import type {
  AgentExecutionRequestV1,
  JsonValue,
} from "../../contracts/execution/agent-execution.js";
import { validateAgentExecutionRequest } from "../../agents/permission-policy.js";
import type { ModelCatalog, ModelReference } from "../../ports/model-catalog.js";
import type {
  ToolCatalog,
  ToolDefinition,
  ToolPermissionRequirement,
} from "../../ports/tool-catalog.js";

export type ResolvedModel = Readonly<{
  requested: JsonValue;
  actual: JsonValue;
  allowedFallback: readonly JsonValue[];
  fallbackUsed: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelReference(value: unknown, label: string): ModelReference {
  if (typeof value === "string") {
    const model = value.trim();
    if (model.length > 0) return model;
  } else if (isRecord(value)) {
    const provider = value.provider;
    const model = value.model;
    if (
      typeof provider === "string" &&
      provider.trim().length > 0 &&
      typeof model === "string" &&
      model.trim().length > 0
    ) {
      return { provider: provider.trim(), model: model.trim() };
    }
  }

  throw new Error(`${label} must be a model ID or { provider, model }`);
}

function modelKey(model: ModelReference): string {
  return typeof model === "string" ? model : `${model.provider}/${model.model}`;
}

function jsonModel(model: ModelReference): JsonValue {
  return typeof model === "string" ? model : { ...model };
}

function sameModel(left: ModelReference, right: ModelReference): boolean {
  return modelKey(left) === modelKey(right);
}

/** Applies runtime availability without inventing a provider/model fallback. */
export class ModelResolver {
  constructor(private readonly catalog: ModelCatalog) {}

  resolve(policy: AgentExecutionRequestV1["model"]): ResolvedModel {
    const requested = modelReference(policy.requested, "Requested model");
    const fallbacks = policy.allowedFallback.map((candidate, index) =>
      modelReference(candidate, `Allowed fallback model [${index}]`),
    );
    const seenModels = new Set([modelKey(requested)]);
    const uniqueFallbacks = fallbacks.filter((candidate) => {
      const key = modelKey(candidate);
      if (seenModels.has(key)) return false;
      seenModels.add(key);
      return true;
    });
    const candidates = [requested, ...uniqueFallbacks];
    const recordedActual =
      policy.actual === null ? undefined : modelReference(policy.actual, "Actual model");

    if (
      recordedActual !== undefined &&
      !candidates.some((candidate) => sameModel(candidate, recordedActual))
    ) {
      throw new Error("Actual model must be the requested model or a configured fallback");
    }

    const ordered =
      recordedActual === undefined
        ? candidates
        : [
            recordedActual,
            ...candidates.filter((candidate) => !sameModel(candidate, recordedActual)),
          ];
    const actual = ordered.find((candidate) => this.catalog.isAvailable(candidate));
    if (actual === undefined) {
      throw new Error("No requested or configured fallback model is available");
    }

    return {
      requested: jsonModel(requested),
      actual: jsonModel(actual),
      allowedFallback: uniqueFallbacks.map(jsonModel),
      fallbackUsed: !sameModel(actual, requested),
    };
  }
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => {
        const other = right[index];
        return other !== undefined && jsonEqual(value, other);
      })
    );
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key]!, right[key]!))
    );
  }
  return false;
}

function hasPermission(
  request: AgentExecutionRequestV1,
  requirement: ToolPermissionRequirement,
): boolean {
  const values = request.permissions[requirement.scope];
  return Array.isArray(values) && values.some((value) => jsonEqual(value, requirement.value));
}

function policyToolNames(policy: JsonValue, field: "allow" | "deny"): Set<string> | undefined {
  if (!isJsonObject(policy) || policy[field] === undefined) return undefined;
  const values = policy[field];
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error(`Tool policy ${field} must be an array of Tool names`);
  }
  return new Set(
    values.map((value) => {
      const name = value.trim();
      if (name.length === 0) throw new Error(`Tool policy ${field} contains an empty Tool name`);
      return name;
    }),
  );
}

function toolPolicy(request: AgentExecutionRequestV1): Readonly<{
  allow: Set<string> | undefined;
  deny: Set<string>;
}> {
  return {
    allow: policyToolNames(request.tools.policy, "allow"),
    deny: policyToolNames(request.tools.policy, "deny") ?? new Set(),
  };
}

const AUTHORITY_LEVELS: Readonly<Record<string, number>> = {
  "recommendation-only": 0,
  D0: 0,
  D1: 1,
  D2: 2,
  D3: 3,
};

function assertAuthority(request: AgentExecutionRequestV1, tool: ToolDefinition): void {
  if (tool.minimumAuthority === undefined) return;

  const available = AUTHORITY_LEVELS[request.authority.maximumDLevel];
  const required = AUTHORITY_LEVELS[tool.minimumAuthority];
  if (available === undefined || required === undefined) {
    throw new Error(`Unsupported authority level while resolving Tool ${tool.name}`);
  }
  if (required > available) {
    throw new Error(
      `Tool ${tool.name} requires ${tool.minimumAuthority} authority, but the request allows ${request.authority.maximumDLevel}`,
    );
  }
}

function assertTool(
  request: AgentExecutionRequestV1,
  capability: string,
  tool: ToolDefinition,
): void {
  if (typeof tool.name !== "string" || tool.name.trim().length === 0) {
    throw new Error(`Tool Catalog returned an invalid Tool for capability ${capability}`);
  }
  if (
    !Array.isArray(tool.capabilities) ||
    !tool.capabilities.includes(capability) ||
    tool.capabilities.some((granted) => typeof granted !== "string" || granted.trim().length === 0)
  ) {
    throw new Error(`Tool Catalog returned an invalid capability mapping for ${capability}`);
  }
  if (tool.requiredPermissions !== undefined && !Array.isArray(tool.requiredPermissions)) {
    throw new Error(`Tool Catalog returned invalid permissions for ${tool.name}`);
  }
  if (
    tool.allowedModes !== undefined &&
    (!Array.isArray(tool.allowedModes) || !tool.allowedModes.includes(request.execution.mode))
  ) {
    throw new Error(`Tool ${tool.name} is not allowed in ${request.execution.mode} mode`);
  }

  for (const requirement of tool.requiredPermissions ?? []) {
    if (!hasPermission(request, requirement)) {
      throw new Error(`Tool ${tool.name} requires denied permission ${requirement.scope}`);
    }
  }
  assertAuthority(request, tool);
}

/** Converts explicitly selected capabilities to concrete Tools within request ceilings. */
export class ToolResolver {
  constructor(private readonly catalog: ToolCatalog) {}

  resolve(request: AgentExecutionRequestV1, capabilities: readonly string[]): readonly string[] {
    if (!Array.isArray(capabilities)) {
      throw new Error("Tool capabilities must be an array");
    }

    const requested = new Set<string>();
    for (const capability of capabilities) {
      if (typeof capability !== "string" || capability.trim().length === 0) {
        throw new Error("Tool capability must be a non-empty string");
      }
      requested.add(capability.trim());
    }

    const policy = toolPolicy(request);
    const resolved: string[] = [];
    const resolvedNames = new Set<string>();
    for (const capability of requested) {
      const tool = this.catalog.resolve(capability);
      if (tool === undefined) {
        throw new Error(`No concrete Tool is configured for capability ${capability}`);
      }
      assertTool(request, capability, tool);
      const name = tool.name.trim();
      if (policy.allow !== undefined && !policy.allow.has(name)) {
        throw new Error(`Tool ${name} is not allowed by the request Tool policy`);
      }
      if (policy.deny.has(name)) {
        throw new Error(`Tool ${name} is denied by the request Tool policy`);
      }
      const unrequested = tool.capabilities.filter((granted) => !requested.has(granted));
      if (unrequested.length > 0) {
        throw new Error(
          `Tool ${name} would grant unrequested capabilities: ${unrequested.join(", ")}`,
        );
      }
      if (resolvedNames.has(name)) continue;
      resolvedNames.add(name);
      resolved.push(name);
    }

    return resolved;
  }
}

export type ExecutionResolutionOptions = Readonly<{
  modelCatalog: ModelCatalog;
  toolCatalog: ToolCatalog;
}>;

/** Resolves both policy dimensions while carrying authority and permission ceilings unchanged. */
export class ExecutionResolver {
  private readonly modelResolver: ModelResolver;
  private readonly toolResolver: ToolResolver;

  constructor(options: ExecutionResolutionOptions) {
    this.modelResolver = new ModelResolver(options.modelCatalog);
    this.toolResolver = new ToolResolver(options.toolCatalog);
  }

  resolve(
    request: AgentExecutionRequestV1,
    capabilities: readonly string[],
  ): AgentExecutionRequestV1 {
    const validated = validateAgentExecutionRequest(request);
    const model = this.modelResolver.resolve(validated.model);
    const tools = this.toolResolver.resolve(validated, capabilities);

    return {
      ...validated,
      tools: {
        ...validated.tools,
        resolved: tools,
      },
      model: {
        ...validated.model,
        requested: model.requested,
        actual: model.actual,
        allowedFallback: model.allowedFallback,
      },
    };
  }
}
