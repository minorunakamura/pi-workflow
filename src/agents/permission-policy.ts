import {
  AgentExecutionRequestV1Schema,
  type AgentExecutionRequestV1,
} from "../contracts/execution/agent-execution.js";
import { AGENT_DEFINITIONS, type AgentDefinition } from "./definitions.js";

export const AGENT_PERMISSION_ERROR_CODES = [
  "AGENT_REQUEST_INVALID",
  "MODE_DENIED",
  "AUTHORITY_DENIED",
  "WRITE_DENIED",
  "GIT_WRITE_DENIED",
  "NETWORK_DENIED",
  "SKILL_DENIED",
  "PATH_TRAVERSAL",
  "WRITE_SCOPE_INVALID",
] as const;
export type AgentPermissionErrorCode = (typeof AGENT_PERMISSION_ERROR_CODES)[number];

export class AgentPermissionError extends Error {
  constructor(
    readonly code: AgentPermissionErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "AgentPermissionError";
  }
}

const WRITE_OPERATION =
  /(?:^|[-_\s])(write|edit|delete|remove|add|commit|push|merge|rebase|reset|restore|clean|branch|checkout|switch|cherry-pick|revert|tag|stash)(?:$|[-_\s])/i;
const BROAD_SHELL_PERMISSION = /^(bash|sh|zsh|fish|shell|terminal|exec|execute|command)(?:\s|$)/i;
// ponytail: permission values are JsonValue today; typed Tool capabilities are the upgrade path beyond operation-name matching.
const NETWORK_CAPABILITY =
  /(?:^|[-_\s])(network|internet|external|http|https|web|fetch)(?:$|[-_\s])/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchingValue(
  value: unknown,
  matcher: RegExp,
  includeObjectKeys = true,
): string | undefined {
  if (typeof value === "string") {
    return matcher.test(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = matchingValue(entry, matcher, includeObjectKeys);
      if (match !== undefined) return match;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (includeObjectKeys && matcher.test(key)) return key;
      const match = matchingValue(entry, matcher, includeObjectKeys);
      if (match !== undefined) return match;
    }
  }
  return undefined;
}

function policyAllow(policy: unknown): readonly unknown[] {
  if (!isRecord(policy) || policy.allow === undefined) return [];
  if (!Array.isArray(policy.allow)) {
    throw new AgentPermissionError(
      "AGENT_REQUEST_INVALID",
      "tools.policy.allow must be an array of Tool names",
    );
  }
  return policy.allow;
}

function definitionFor(agentId: string): AgentDefinition {
  const definition = AGENT_DEFINITIONS.find(({ id }) => id === agentId);
  if (definition === undefined) {
    throw new AgentPermissionError("AGENT_REQUEST_INVALID", `Unknown Agent role: ${agentId}`);
  }
  return definition;
}

function assertMode(request: AgentExecutionRequestV1, definition: AgentDefinition): void {
  if (request.execution.mode !== definition.mode) {
    throw new AgentPermissionError(
      "MODE_DENIED",
      `Agent ${definition.id} requires ${definition.mode} execution mode`,
    );
  }
}

function assertAuthority(request: AgentExecutionRequestV1, definition: AgentDefinition): void {
  const authority = request.authority.maximumDLevel;
  const allowed =
    definition.maximumNormalAuthority === "D1"
      ? authority === "D0" || authority === "D1"
      : authority === definition.maximumNormalAuthority;
  if (!allowed) {
    throw new AgentPermissionError(
      "AUTHORITY_DENIED",
      `Agent ${definition.id} allows authority ${definition.maximumNormalAuthority}, not ${authority}`,
    );
  }
}

function assertSkills(request: AgentExecutionRequestV1, definition: AgentDefinition): void {
  const allowlist = new Set<string>(definition.skillAllowlist);
  for (const reference of [...request.skills.required, ...request.skills.optional]) {
    if (!allowlist.has(reference.id)) {
      throw new AgentPermissionError(
        "SKILL_DENIED",
        `Skill ${reference.id} is not allowlisted for Agent ${definition.id}`,
      );
    }
  }
}

function assertNoSourceWrite(request: AgentExecutionRequestV1, definition: AgentDefinition): void {
  const policy = policyAllow(request.tools.policy);
  const sources: readonly [string, unknown][] = [
    ["permissions.filesystem", request.permissions.filesystem],
    ["permissions.shell", request.permissions.shell],
    ["permissions.git", request.permissions.git],
    ["tools.resolved", request.tools.resolved],
    ["tools.policy.allow", policy],
  ];

  for (const [source, value] of sources) {
    const write = matchingValue(value, WRITE_OPERATION);
    const broadShell = matchingValue(value, BROAD_SHELL_PERMISSION);
    const found = write ?? broadShell;
    if (found !== undefined) {
      throw new AgentPermissionError(
        "WRITE_DENIED",
        `${source} grants a source write operation to Agent ${definition.id}: ${found}`,
      );
    }
  }
}

function assertWorkerGitWriteDenied(request: AgentExecutionRequestV1): void {
  const policy = policyAllow(request.tools.policy);
  const sources: readonly [string, unknown][] = [
    ["permissions.git", request.permissions.git],
    ["permissions.shell", request.permissions.shell],
    ["tools.resolved", request.tools.resolved],
    ["tools.policy.allow", policy],
  ];

  for (const [source, value] of sources) {
    const write = matchingValue(value, WRITE_OPERATION);
    if (write !== undefined) {
      throw new AgentPermissionError(
        "GIT_WRITE_DENIED",
        `${source} contains the Git write operation ${write}`,
      );
    }
  }
}

function assertNetwork(request: AgentExecutionRequestV1, definition: AgentDefinition): void {
  const policy = policyAllow(request.tools.policy);
  const sources: readonly [string, unknown][] = [
    ["tools.resolved", request.tools.resolved],
    ["tools.policy.allow", policy],
  ];
  const networkSource = sources
    .map(([source, value]) => [source, matchingValue(value, NETWORK_CAPABILITY)] as const)
    .find(([, network]) => network !== undefined);

  if (definition.id === "researcher") {
    if (networkSource !== undefined && request.permissions.network.length === 0) {
      throw new AgentPermissionError(
        "NETWORK_DENIED",
        `${networkSource[0]} requires an explicit Researcher network permission`,
      );
    }
    return;
  }
  if (request.permissions.network.length > 0) {
    throw new AgentPermissionError(
      "NETWORK_DENIED",
      `Network permission is not available to Agent ${definition.id}`,
    );
  }
  if (networkSource !== undefined) {
    throw new AgentPermissionError(
      "NETWORK_DENIED",
      `${networkSource[0]} grants network access to Agent ${definition.id}: ${networkSource[1]}`,
    );
  }
}

function assertSafeWorkerTarget(value: unknown, index: number): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\u0000") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new AgentPermissionError(
      "WRITE_SCOPE_INVALID",
      `Worker repositoryTargets[${index}] is not a safe repository-relative path: ${String(value)}`,
    );
  }

  const normalized = value.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (normalized === "." || (normalized.length === 0 && /^(?:\.?\/)+$/.test(value))) return;
  if (
    normalized.length === 0 ||
    normalized
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new AgentPermissionError(
      "WRITE_SCOPE_INVALID",
      `Worker repositoryTargets[${index}] is not a safe repository-relative path: ${value}`,
    );
  }
}

function assertRepositoryTargets(request: AgentExecutionRequestV1): void {
  for (const [index, target] of request.permissions.repositoryTargets.entries()) {
    if (
      typeof target !== "string" ||
      target.length === 0 ||
      target.includes("\u0000") ||
      target.includes("\\") ||
      target.split("/").some((segment) => segment === "..")
    ) {
      throw new AgentPermissionError(
        "PATH_TRAVERSAL",
        `repositoryTargets[${index}] contains an unsafe repository path: ${JSON.stringify(target) ?? typeof target}`,
      );
    }
  }
}

function assertWorkerScope(request: AgentExecutionRequestV1): void {
  request.permissions.repositoryTargets.forEach(assertSafeWorkerTarget);
}

/** Validates the immutable Agent permission ceiling before an execution is dispatched. */
export function validateAgentExecutionRequest(input: unknown): AgentExecutionRequestV1 {
  let request: AgentExecutionRequestV1;
  try {
    request = AgentExecutionRequestV1Schema.parse(input);
  } catch (error) {
    throw new AgentPermissionError(
      "AGENT_REQUEST_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }

  const definition = definitionFor(request.identity.agentId);
  assertMode(request, definition);
  assertAuthority(request, definition);
  assertSkills(request, definition);
  assertRepositoryTargets(request);
  assertNetwork(request, definition);

  if (definition.id === "worker") {
    assertWorkerGitWriteDenied(request);
    assertWorkerScope(request);
  } else {
    assertNoSourceWrite(request, definition);
  }

  return request;
}
