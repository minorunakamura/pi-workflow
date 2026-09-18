import { randomUUID } from "node:crypto";

import {
  hasOnlyKeys,
  invalidResult,
  isBoundedString,
  isRecord,
  validResult,
  type ValidationResult,
} from "./validation.ts";
import { MAX_AUTOMATIC_FIX_WAVES, type FindingId } from "./workflow.ts";

export type Disposition = "BLOCKER" | "FIX_NOW" | "DEFERRED" | "REJECTED";

export interface FindingInput {
  source: string;
  location?: string;
  severity?: string;
  evidence: string;
  reason: string;
  recommendedAction?: string;
}

export interface Finding {
  id: FindingId;
  source: string;
  location?: string;
  severity?: string;
  evidence: string;
  reason: string;
  recommendedAction?: string;
}

export interface FindingDisposition {
  findingId: FindingId;
  disposition: Disposition;
  reason: string;
}

export interface DispositionedFinding {
  finding: Finding;
  disposition: FindingDisposition;
}

export interface FindingReadiness {
  findingId: FindingId;
  disposition: Disposition;
  resolved: boolean;
  reason: string;
}

export interface FixWave {
  waveNumber: 1;
  acceptedFindingIds: readonly FindingId[];
}

export type FixWaveCreationReason =
  | "NO_ACCEPTED_FINDINGS"
  | "MAX_FIX_WAVES_REACHED"
  | "INVALID_FINDING";

export type FixWaveCreationResult =
  | { created: true; wave: FixWave }
  | { created: false; reason: FixWaveCreationReason };

export interface FixWavePlan {
  wave: FixWave;
  acceptedFindings: readonly DispositionedFinding[];
}

export type FixWavePlanResult =
  | { created: true; plan: FixWavePlan }
  | { created: false; reason: FixWaveCreationReason };

export type FocusedReviewStatus = "RESOLVED" | "STILL_PRESENT";

export interface FocusedReviewResult {
  status: FocusedReviewStatus;
  fresh: boolean;
  readOnly: boolean;
}

export interface FocusedReviewEvaluation {
  required: boolean;
  passed: boolean;
  reason: string;
}

const FINDING_ID_PATTERN =
  /^F-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_FIX_WAVE_FINDINGS = 32;
const FINDING_KEYS = [
  "source",
  "location",
  "severity",
  "evidence",
  "reason",
  "recommendedAction",
] as const;

function isDisposition(value: unknown): value is Disposition {
  return (
    value === "BLOCKER" ||
    value === "FIX_NOW" ||
    value === "DEFERRED" ||
    value === "REJECTED"
  );
}

function isFocusedReviewStatus(value: unknown): value is FocusedReviewStatus {
  return value === "RESOLVED" || value === "STILL_PRESENT";
}

export function createFindingId(uuid = randomUUID()): FindingId {
  const normalized = uuid.trim();
  const value = `F-${normalized}`;
  if (!isValidFindingId(value)) {
    throw new TypeError("Finding ID requires a UUID");
  }
  return value;
}

export function isValidFindingId(value: unknown): value is FindingId {
  return typeof value === "string" && FINDING_ID_PATTERN.test(value);
}

function validateFindingInput(value: unknown): ValidationResult<FindingInput> {
  if (!isRecord(value) || !hasOnlyKeys(value, FINDING_KEYS)) {
    return invalidResult("Finding input has unknown or missing fields");
  }
  const source = value.source;
  const evidence = value.evidence;
  const reason = value.reason;
  if (
    !isBoundedString(source, 4096, true) ||
    !isBoundedString(evidence, 4096, true) ||
    !isBoundedString(reason, 4096, true)
  ) {
    return invalidResult("Finding input contains an invalid value");
  }
  const finding: FindingInput = { source, evidence, reason };
  if ("location" in value) {
    if (!isBoundedString(value.location, 4096, true)) {
      return invalidResult("Finding input contains an invalid value");
    }
    finding.location = value.location;
  }
  if ("severity" in value) {
    if (!isBoundedString(value.severity, 256, true)) {
      return invalidResult("Finding input contains an invalid value");
    }
    finding.severity = value.severity;
  }
  if ("recommendedAction" in value) {
    if (!isBoundedString(value.recommendedAction, 4096, true)) {
      return invalidResult("Finding input contains an invalid value");
    }
    finding.recommendedAction = value.recommendedAction;
  }
  return validResult(finding);
}

export function normalizeFinding(
  value: unknown,
  findingId: FindingId = createFindingId(),
): ValidationResult<Finding> {
  const input = validateFindingInput(value);
  if (!input.valid || !isValidFindingId(findingId)) {
    return invalidResult(
      ...(!input.valid ? input.errors : []),
      "Finding ID is invalid",
    );
  }

  const finding: Finding = {
    id: findingId,
    source: input.value.source,
    evidence: input.value.evidence,
    reason: input.value.reason,
  };
  if (input.value.location !== undefined) {
    finding.location = input.value.location;
  }
  if (input.value.severity !== undefined) {
    finding.severity = input.value.severity;
  }
  if (input.value.recommendedAction !== undefined) {
    finding.recommendedAction = input.value.recommendedAction;
  }
  return validResult(finding);
}

export function validateFindingDisposition(
  value: unknown,
): ValidationResult<FindingDisposition> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["findingId", "disposition", "reason"])
  ) {
    return invalidResult("Finding disposition has unknown or missing fields");
  }
  const findingId = value.findingId;
  const disposition = value.disposition;
  const reason = value.reason;
  if (
    !isValidFindingId(findingId) ||
    !isDisposition(disposition) ||
    !isBoundedString(reason, 4096, true)
  ) {
    return invalidResult("Finding disposition requires a valid reason");
  }
  return validResult({ findingId, disposition, reason });
}

export function validateDispositionedFinding(
  value: unknown,
): ValidationResult<DispositionedFinding> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["finding", "disposition"]) ||
    !isRecord(value.finding) ||
    !isValidFindingId(value.finding.id)
  ) {
    return invalidResult("Dispositioned Finding has unknown or missing fields");
  }
  const findingValue = value.finding;
  const findingId = findingValue.id;
  if (!isValidFindingId(findingId)) {
    return invalidResult("Dispositioned Finding is invalid");
  }
  const { id: _id, ...findingInput } = findingValue;
  const finding = normalizeFinding(findingInput, findingId);
  const disposition = validateFindingDisposition(value.disposition);
  if (
    !finding.valid ||
    !disposition.valid ||
    finding.value.id !== disposition.value.findingId
  ) {
    return invalidResult("Dispositioned Finding is invalid");
  }
  return validResult({
    finding: finding.value,
    disposition: disposition.value,
  });
}

export function isAcceptedDisposition(disposition: Disposition): boolean {
  return disposition === "BLOCKER" || disposition === "FIX_NOW";
}

export function validateFixWave(value: unknown): ValidationResult<FixWave> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["waveNumber", "acceptedFindingIds"]) ||
    value.waveNumber !== 1 ||
    !Array.isArray(value.acceptedFindingIds) ||
    value.acceptedFindingIds.length === 0 ||
    value.acceptedFindingIds.length > MAX_FIX_WAVE_FINDINGS
  ) {
    return invalidResult("Fix Wave is invalid");
  }
  const ids: FindingId[] = [];
  const seen = new Set<FindingId>();
  for (const id of value.acceptedFindingIds) {
    if (!isValidFindingId(id) || seen.has(id)) {
      return invalidResult(
        "Fix Wave contains an invalid or duplicate Finding ID",
      );
    }
    seen.add(id);
    ids.push(id);
  }
  return validResult({ waveNumber: 1, acceptedFindingIds: ids });
}

export function validateFocusedReviewResult(
  value: unknown,
): ValidationResult<FocusedReviewResult> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["status", "fresh", "readOnly"])
  ) {
    return invalidResult("Focused Re-review result is invalid");
  }
  const status = value.status;
  const fresh = value.fresh;
  const readOnly = value.readOnly;
  if (
    !isFocusedReviewStatus(status) ||
    typeof fresh !== "boolean" ||
    typeof readOnly !== "boolean"
  ) {
    return invalidResult("Focused Re-review result is invalid");
  }
  return validResult({ status, fresh, readOnly });
}

export function canCreateFixWave(
  completedWaveCount: number,
  acceptedFindingCount: number,
): boolean {
  return (
    Number.isInteger(completedWaveCount) &&
    completedWaveCount >= 0 &&
    completedWaveCount < MAX_AUTOMATIC_FIX_WAVES &&
    Number.isInteger(acceptedFindingCount) &&
    acceptedFindingCount > 0 &&
    acceptedFindingCount <= MAX_FIX_WAVE_FINDINGS
  );
}

export function buildFixWave(
  findings: readonly DispositionedFinding[],
  completedWaveCount = 0,
): FixWaveCreationResult {
  if (
    !Array.isArray(findings) ||
    !Number.isInteger(completedWaveCount) ||
    completedWaveCount < 0
  ) {
    return { created: false, reason: "INVALID_FINDING" };
  }

  const acceptedFindingIds: FindingId[] = [];
  const seen = new Set<FindingId>();
  const allFindingIds = new Set<FindingId>();
  for (const value of findings) {
    const validated = validateDispositionedFinding(value);
    if (!validated.valid) {
      return { created: false, reason: "INVALID_FINDING" };
    }
    const id = validated.value.finding.id;
    if (allFindingIds.has(id)) {
      return { created: false, reason: "INVALID_FINDING" };
    }
    allFindingIds.add(id);
    if (isAcceptedDisposition(validated.value.disposition.disposition)) {
      if (seen.has(id)) {
        return { created: false, reason: "INVALID_FINDING" };
      }
      seen.add(id);
      acceptedFindingIds.push(id);
    }
  }

  if (acceptedFindingIds.length === 0) {
    return { created: false, reason: "NO_ACCEPTED_FINDINGS" };
  }
  if (!canCreateFixWave(completedWaveCount, acceptedFindingIds.length)) {
    return { created: false, reason: "MAX_FIX_WAVES_REACHED" };
  }
  return {
    created: true,
    wave: { waveNumber: 1, acceptedFindingIds },
  };
}

export function buildFixWavePlan(
  findings: readonly DispositionedFinding[],
  completedWaveCount = 0,
): FixWavePlanResult {
  const waveResult = buildFixWave(findings, completedWaveCount);
  if (!waveResult.created) return waveResult;

  const acceptedFindings: DispositionedFinding[] = [];
  const acceptedIds = new Set(waveResult.wave.acceptedFindingIds);
  for (const value of findings) {
    const validated = validateDispositionedFinding(value);
    if (!validated.valid) {
      return { created: false, reason: "INVALID_FINDING" };
    }
    if (acceptedIds.has(validated.value.finding.id)) {
      acceptedFindings.push(validated.value);
    }
  }
  return {
    created: true,
    plan: { wave: waveResult.wave, acceptedFindings },
  };
}

export function evaluateFocusedReview(
  fixWave: FixWave | null | undefined,
  result: FocusedReviewResult | null | undefined,
): FocusedReviewEvaluation {
  if (fixWave === null || fixWave === undefined) {
    return { required: false, passed: true, reason: "not-applicable" };
  }
  if (!validateFixWave(fixWave).valid) {
    return { required: true, passed: false, reason: "Fix Wave is invalid" };
  }
  if (result === undefined || result === null) {
    return {
      required: true,
      passed: false,
      reason: "fresh focused re-review is missing",
    };
  }
  const review = validateFocusedReviewResult(result);
  if (!review.valid) {
    return {
      required: true,
      passed: false,
      reason: "Focused Re-review is invalid",
    };
  }
  if (!review.value.fresh || !review.value.readOnly) {
    return {
      required: true,
      passed: false,
      reason: "focused re-review must be fresh and read-only",
    };
  }
  if (review.value.status !== "RESOLVED") {
    return {
      required: true,
      passed: false,
      reason: "focused re-review still has a finding",
    };
  }
  return { required: true, passed: true, reason: "resolved" };
}
