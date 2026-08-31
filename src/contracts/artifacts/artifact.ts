import {
  ContractValidationError,
  type JsonObject,
  type JsonValue,
  type RuntimeSchema,
  type SafeParseResult,
} from "../execution/agent-execution.js";
import type { ExecutionId, RunId, StepId } from "../../domain/primitives/ids.js";

export const ARTIFACT_STATUSES = ["complete", "partial"] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export type ArtifactFrontMatterV1 = JsonObject &
  Readonly<{
    schema_version: 1;
    run_id: RunId;
    step_id: StepId;
    execution_id: ExecutionId;
    execution_state_revision: number;
    agent: Readonly<{
      id: string;
      version: number;
    }>;
    artifact: Readonly<{
      type: string;
      status: ArtifactStatus;
    }>;
    created_at: string;
    skills: readonly JsonValue[];
  }>;

const CONTRACT = "ArtifactFrontMatterV1";

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(path: string, expected: string): never {
  throw new ContractValidationError(CONTRACT, { path, expected });
}

function stringValue(input: unknown, path: string): string {
  if (typeof input !== "string") {
    fail(path, "a string");
  }
  return input;
}

function nonEmptyString(input: unknown, path: string): string {
  const value = stringValue(input, path);
  if (value.trim().length === 0) {
    fail(path, "a non-empty string");
  }
  return value;
}

function safeIntegerAtLeast(input: unknown, path: string, minimum: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum) {
    fail(path, `a safe integer greater than or equal to ${minimum}`);
  }
  return input;
}

function jsonValue(input: unknown, path: string): JsonValue {
  if (input === null || typeof input === "string" || typeof input === "boolean") {
    return input;
  }
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }
  if (Array.isArray(input)) {
    input.forEach((entry, index) => jsonValue(entry, `${path}[${index}]`));
    return input as readonly JsonValue[];
  }
  if (isRecord(input)) {
    Object.entries(input).forEach(([key, entry]) => jsonValue(entry, `${path}.${key}`));
    return input as JsonObject;
  }
  return fail(path, "a JSON value");
}

function jsonObject(input: unknown, path: string): JsonObject {
  if (!isRecord(input)) {
    fail(path, "an object");
  }
  Object.entries(input).forEach(([key, value]) => jsonValue(value, `${path}.${key}`));
  return input as JsonObject;
}

function jsonArray(input: unknown, path: string): readonly JsonValue[] {
  if (!Array.isArray(input)) {
    fail(path, "an array");
  }
  return input.map((entry, index) => jsonValue(entry, `${path}[${index}]`));
}

function domainId(input: unknown, path: string, prefix: "run" | "step" | "exec"): string {
  const value = nonEmptyString(input, path);
  if (!new RegExp(`^${prefix}-\\d+$`).test(value)) {
    fail(path, `${prefix}-<number> identity`);
  }
  return value;
}

function enumValue(input: unknown, path: string): ArtifactStatus {
  const value = stringValue(input, path);
  if (!(ARTIFACT_STATUSES as readonly string[]).includes(value)) {
    fail(path, `one of ${ARTIFACT_STATUSES.join(", ")}`);
  }
  return value as ArtifactStatus;
}

export function parseArtifactFrontMatterV1(input: unknown): ArtifactFrontMatterV1 {
  const root = jsonObject(input, "");
  if (root.schema_version !== 1) {
    fail("schema_version", "schema version 1");
  }
  domainId(root.run_id, "run_id", "run");
  domainId(root.step_id, "step_id", "step");
  domainId(root.execution_id, "execution_id", "exec");
  safeIntegerAtLeast(root.execution_state_revision, "execution_state_revision", 0);

  const agent = jsonObject(root.agent, "agent");
  nonEmptyString(agent.id, "agent.id");
  safeIntegerAtLeast(agent.version, "agent.version", 1);

  const artifact = jsonObject(root.artifact, "artifact");
  nonEmptyString(artifact.type, "artifact.type");
  enumValue(artifact.status, "artifact.status");
  nonEmptyString(root.created_at, "created_at");
  jsonArray(root.skills, "skills");

  return input as ArtifactFrontMatterV1;
}

function createRuntimeSchema<T>(parser: (input: unknown) => T): RuntimeSchema<T> {
  return {
    parse: parser,
    safeParse(input: unknown): SafeParseResult<T> {
      try {
        return { success: true, data: parser(input) };
      } catch (error) {
        if (error instanceof ContractValidationError) {
          return { success: false, error };
        }
        throw error;
      }
    },
  };
}

export const ArtifactFrontMatterV1Schema = createRuntimeSchema(parseArtifactFrontMatterV1);
export const artifactFrontMatterV1Schema = ArtifactFrontMatterV1Schema;
