import {
  isValidArtifactRef,
  validateFinalDiffInspectionResult,
  type ArtifactRef,
  type FinalDiffInspectionResult,
} from "../core/index.ts";
import {
  hasOnlyKeys,
  invalidResult,
  isRecord,
  validResult,
  type ValidationResult,
} from "../core/validation.ts";

export interface FinalDiffInspectionRun {
  readonly result: FinalDiffInspectionResult;
  readonly artifactRef: ArtifactRef;
}

/**
 * Accepts only the Coordinator's structured checklist and its managed output.
 * The Coordinator owns the inspection; this adapter does not edit source.
 */
export function validateFinalDiffInspectionRun(
  value: unknown,
): ValidationResult<FinalDiffInspectionRun> {
  if (!isRecord(value) || !hasOnlyKeys(value, ["result", "artifactRef"])) {
    return invalidResult(
      "Final Diff Inspection run has unknown or missing fields",
    );
  }
  const result = validateFinalDiffInspectionResult(value.result);
  if (!result.valid) return result;
  if (
    !isValidArtifactRef(value.artifactRef) ||
    value.artifactRef.mediaType !== "text/markdown"
  ) {
    return invalidResult(
      "Final Diff Inspection managed artifact reference is invalid",
    );
  }
  return validResult({
    result: result.value,
    artifactRef: value.artifactRef,
  });
}

export function acceptFinalDiffInspection(
  result: unknown,
  artifactRef: unknown,
): ValidationResult<FinalDiffInspectionRun> {
  return validateFinalDiffInspectionRun({ result, artifactRef });
}
