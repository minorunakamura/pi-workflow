export type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; errors: string[] };

export function validResult<T>(value: T): ValidationResult<T> {
  return { valid: true, value };
}

export function invalidResult(...errors: string[]): ValidationResult<never> {
  return {
    valid: false,
    errors: errors.length > 0 ? errors : ["invalid value"],
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function isBoundedString(
  value: unknown,
  maximumBytes: number,
  nonEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (!nonEmpty || value.trim().length > 0) &&
    utf8ByteLength(value) <= maximumBytes
  );
}

export function isNormalizedOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    !/[\r\n]/u.test(value) &&
    utf8ByteLength(value) <= 4096
  );
}

export function isSafeRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(value)
  ) {
    return false;
  }

  return value
    .split(/[\\/]/u)
    .every((segment) => segment !== ".." && segment !== ".");
}
