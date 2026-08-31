import type {
  AgentExecutionMode,
  AgentExecutionRequestV1,
  JsonValue,
} from "../contracts/execution/agent-execution.js";

export const TOOL_CAPABILITIES = [
  "repository-read",
  "repository-write",
  "git-read",
  "shell",
  "verification",
  "network",
  "external",
  "runtime",
] as const;

export type ToolPermissionScope = keyof AgentExecutionRequestV1["permissions"];

export type ToolPermissionRequirement = Readonly<{
  scope: ToolPermissionScope;
  value: JsonValue;
}>;

export type ToolDefinition = Readonly<{
  name: string;
  capabilities: readonly string[];
  requiredPermissions?: readonly ToolPermissionRequirement[];
  allowedModes?: readonly AgentExecutionMode[];
  minimumAuthority?: string;
}>;

/** Resolves an approved capability to one concrete Tool definition. */
export interface ToolCatalog {
  resolve(capability: string): ToolDefinition | undefined;
}
