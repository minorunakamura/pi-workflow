import { Type } from "typebox";
import {
  jsonByteLength,
  MAX_REFERENCE_BYTES,
  schemaIssues,
  type ValidationResult,
} from "../validation";

export { MAX_REFERENCE_BYTES } from "../validation";

/** An opaque native Artifact/run/patch/handoff/evidence reference. */
export type ReferenceValue = string;

/** The body held by a file-backed Artifact; it never belongs in Mission state. */
export type ArtifactBody = string;

export interface Artifact {
  readonly body: ArtifactBody;
}

export const ReferenceValueSchema = Type.String({
  minLength: 1,
  maxLength: MAX_REFERENCE_BYTES,
});

export function validateReferenceValue(
  value: unknown,
): ValidationResult<ReferenceValue> {
  const errors = schemaIssues(ReferenceValueSchema, value);
  if (errors.length > 0) return { ok: false, errors };

  if (typeof value !== "string") {
    return {
      ok: false,
      errors: [{ path: "/", message: "ReferenceValue must be a JSON string" }],
    };
  }

  const bytes = jsonByteLength(value);
  if (bytes > MAX_REFERENCE_BYTES) {
    return {
      ok: false,
      errors: [
        {
          path: "/",
          message: `ReferenceValue exceeds ${MAX_REFERENCE_BYTES} serialized UTF-8 bytes`,
        },
      ],
    };
  }

  return { ok: true, value, errors: [] };
}

export const validateReference = validateReferenceValue;
export const ReferenceSchema = ReferenceValueSchema;
