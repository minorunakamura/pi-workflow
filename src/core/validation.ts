import Schema from "typebox/schema";
import type { Static, TSchema } from "typebox";

export const MAX_RESOURCE_ARGS_BYTES = 16 * 1024;
export const MAX_MISSION_STATE_BYTES = 256 * 1024;
export const MAX_REFERENCE_BYTES = 2_048;
export const MAX_REGULAR_TEXT_BYTES = 1_024;
export const MAX_COMMAND_ENTRY_BYTES = 2_048;
export const MAX_IDENTIFIER_BYTES = 64;
export const MAX_REQUEST_BYTES = 8_192;
export const MAX_HUMAN_INPUT_ENTRIES = 8;
export const MAX_HUMAN_INPUT_VALUE_BYTES = 2_048;
export const MAX_PLAN_REVIEW_ROUNDS = 3;
export const MAX_JSON_DEPTH = 8;

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T; errors: [] }
  | { ok: false; errors: ValidationIssue[] };

export function schemaIssues(
  schema: TSchema,
  value: unknown,
): ValidationIssue[] {
  const [, errors] = Schema.Errors(schema, value);
  return errors.map((error) => ({
    path: error.instancePath,
    message: error.message,
  }));
}

export function validateSchema<const S extends TSchema>(
  schema: S,
  value: unknown,
  semantic?: (value: Static<S>) => ValidationIssue[],
): ValidationResult<Static<S>> {
  if (!Schema.Check(schema, value))
    return { ok: false, errors: schemaIssues(schema, value) };

  const semanticErrors = semantic?.(value) ?? [];
  return semanticErrors.length > 0
    ? { ok: false, errors: semanticErrors }
    : { ok: true, value, errors: [] };
}

export function isJsonValue(
  value: unknown,
  seen = new Set<unknown>(),
): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;

  seen.add(value);
  if (Array.isArray(value)) {
    const valid = value.every((item) => isJsonValue(item, seen));
    seen.delete(value);
    return valid;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    return false;
  }

  const valid = Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function utf8ByteIssues(
  path: string,
  value: string,
  maximum: number,
  label: string,
): ValidationIssue[] {
  return utf8ByteLength(value) <= maximum
    ? []
    : [{ path, message: `${label} exceeds ${maximum} UTF-8 bytes` }];
}

export function jsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new Error("value is not JSON serializable");
  return new TextEncoder().encode(serialized).byteLength;
}

function exceedsJsonDepth(
  value: unknown,
  depth: number,
  maxDepth: number,
  seen = new Set<unknown>(),
): boolean {
  if (value === null || typeof value !== "object") return false;
  if (depth > maxDepth) return true;
  if (seen.has(value)) return false;

  seen.add(value);
  const values = Array.isArray(value) ? value : Object.values(value);
  const exceeds = values.some((item) =>
    exceedsJsonDepth(item, depth + 1, maxDepth, seen),
  );
  seen.delete(value);
  return exceeds;
}

export function jsonBoundIssues(
  value: unknown,
  options: { maxBytes?: number; maxDepth?: number } = {},
): ValidationIssue[] {
  if (!isJsonValue(value)) {
    return [{ path: "/", message: "value must contain JSON values only" }];
  }

  const maxDepth = options.maxDepth ?? MAX_JSON_DEPTH;
  if (exceedsJsonDepth(value, 0, maxDepth)) {
    return [{ path: "/", message: `value exceeds JSON depth ${maxDepth}` }];
  }

  const bytes = jsonByteLength(value);
  if (options.maxBytes !== undefined && bytes > options.maxBytes) {
    return [
      {
        path: "/",
        message: `serialized JSON exceeds ${options.maxBytes} bytes`,
      },
    ];
  }

  return [];
}

export function formatValidationIssues(
  errors: readonly ValidationIssue[],
): string {
  return errors.map((error) => `${error.path}: ${error.message}`).join("; ");
}

export function duplicateIdIssues(
  items: Array<{ id: string }>,
  path: string,
  message: string,
): ValidationIssue[] {
  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];

  items.forEach((item, index) => {
    if (seen.has(item.id)) {
      issues.push({ path: `${path}/${index}/id`, message });
    } else {
      seen.add(item.id);
    }
  });

  return issues;
}
