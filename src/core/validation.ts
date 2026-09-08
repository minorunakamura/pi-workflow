import Schema from "typebox/schema";
import type { Static, TSchema } from "typebox";

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

export function jsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new Error("value is not JSON serializable");
  return new TextEncoder().encode(serialized).byteLength;
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
