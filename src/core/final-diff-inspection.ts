import { evaluateTrustedGates, type TrustedGate } from "./gates.ts";
import { isValidArtifactRef, type ArtifactRef } from "./workflow.ts";
import { validateWorkerChangedPaths, type WorkerScope } from "./worker.ts";
import {
  hasOnlyKeys,
  invalidResult,
  isBoundedString,
  isRecord,
  isSafeRelativePath,
  validResult,
  type ValidationResult,
} from "./validation.ts";

export const FINAL_DIFF_INSPECTION_CONTRACT_VERSION = 1 as const;

const MAX_LIST_ITEM_BYTES = 4096;

export type FinalDiffInspectionStatus = "PASS" | "FAIL" | "MISSING" | "UNKNOWN";

export type FinalDiffCheckId =
  | "approved-requirements"
  | "unexpected-files"
  | "non-goals"
  | "accepted-findings"
  | "deferred-rejected-findings"
  | "required-gates"
  | "optional-gates"
  | "working-tree";

export interface FinalDiffCheck {
  readonly id: FinalDiffCheckId;
  readonly status: FinalDiffInspectionStatus;
  readonly reason: string;
  readonly evidenceRef?: ArtifactRef;
}

export interface WorkingTreeEvidence {
  readonly status: "known" | "unknown";
  readonly trackedPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
  readonly evidenceRef?: ArtifactRef;
}

export interface FinalDiffInspectionInput {
  readonly requirementsSatisfied: boolean;
  readonly changedPaths: readonly string[];
  readonly scope: WorkerScope;
  readonly nonGoalViolations: readonly string[];
  readonly acceptedFindingsResolved: boolean;
  readonly deferredFindingsDocumented: boolean;
  readonly rejectedFindingsDocumented: boolean;
  readonly gates: readonly TrustedGate[];
  readonly requiredGateKeys?: readonly string[];
  readonly workingTree: WorkingTreeEvidence;
}

export interface FinalDiffInspectionResult {
  readonly contractVersion: typeof FINAL_DIFF_INSPECTION_CONTRACT_VERSION;
  readonly status: FinalDiffInspectionStatus;
  readonly passed: boolean;
  readonly checks: FinalDiffCheck[];
  readonly blockers: Array<{
    readonly code: FinalDiffCheckId | "invalid-input";
    readonly reason: string;
    readonly evidenceRef?: ArtifactRef;
  }>;
}

const CHECK_IDS: readonly FinalDiffCheckId[] = [
  "approved-requirements",
  "unexpected-files",
  "non-goals",
  "accepted-findings",
  "deferred-rejected-findings",
  "required-gates",
  "optional-gates",
  "working-tree",
];

function isFinalDiffCheckId(value: unknown): value is FinalDiffCheckId {
  return typeof value === "string" && CHECK_IDS.some((id) => id === value);
}

function isFinalDiffInspectionStatus(
  value: unknown,
): value is FinalDiffInspectionStatus {
  return (
    value === "PASS" ||
    value === "FAIL" ||
    value === "MISSING" ||
    value === "UNKNOWN"
  );
}

function validateStringList(
  value: unknown,
  fieldName: string,
): ValidationResult<string[]> {
  if (!Array.isArray(value)) {
    return invalidResult(`${fieldName} must be an array`);
  }
  const list: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !isBoundedString(item, MAX_LIST_ITEM_BYTES, true) ||
      /[\0\r\n]/u.test(item) ||
      seen.has(item)
    ) {
      return invalidResult(
        `${fieldName} contains an invalid or duplicate item`,
      );
    }
    seen.add(item);
    list.push(item);
  }
  return validResult(list);
}

function validatePathList(
  value: unknown,
  fieldName: string,
): ValidationResult<string[]> {
  const list = validateStringList(value, fieldName);
  if (!list.valid) return list;
  if (!list.value.every((path) => isSafeRelativePath(path))) {
    return invalidResult(`${fieldName} contains an unsafe path`);
  }
  return list;
}

function validateScope(value: unknown): ValidationResult<WorkerScope> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["allowedPaths", "allowedAreas"])
  ) {
    return invalidResult("Final Diff Inspection scope is invalid");
  }
  const allowedPaths = validatePathList(value.allowedPaths, "allowedPaths");
  const allowedAreas = validatePathList(value.allowedAreas, "allowedAreas");
  if (!allowedPaths.valid || !allowedAreas.valid) {
    return invalidResult(
      ...(!allowedPaths.valid ? allowedPaths.errors : []),
      ...(!allowedAreas.valid ? allowedAreas.errors : []),
    );
  }
  return validResult({
    allowedPaths: allowedPaths.value,
    allowedAreas: allowedAreas.value,
  });
}

function validateWorkingTreeEvidence(
  value: unknown,
): ValidationResult<WorkingTreeEvidence> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "status",
      "trackedPaths",
      "untrackedPaths",
      "evidenceRef",
    ])
  ) {
    return invalidResult("Working tree evidence has unknown or missing fields");
  }
  const trackedPaths = validatePathList(
    value.trackedPaths,
    "workingTree.trackedPaths",
  );
  const untrackedPaths = validatePathList(
    value.untrackedPaths,
    "workingTree.untrackedPaths",
  );
  if (!trackedPaths.valid || !untrackedPaths.valid) {
    return invalidResult(
      ...(!trackedPaths.valid ? trackedPaths.errors : []),
      ...(!untrackedPaths.valid ? untrackedPaths.errors : []),
    );
  }
  if (value.status !== "known" && value.status !== "unknown") {
    return invalidResult("Working tree evidence status is invalid");
  }
  let evidenceRef: ArtifactRef | undefined;
  if ("evidenceRef" in value) {
    if (!isValidArtifactRef(value.evidenceRef)) {
      return invalidResult("Working tree evidence reference is invalid");
    }
    evidenceRef = value.evidenceRef;
  }
  return validResult({
    status: value.status,
    trackedPaths: trackedPaths.value,
    untrackedPaths: untrackedPaths.value,
    ...(evidenceRef === undefined ? {} : { evidenceRef }),
  });
}

function validateRequiredGateKeys(
  value: unknown,
): ValidationResult<readonly string[] | undefined> {
  if (value === undefined) return validResult(undefined);
  const result = validateStringList(value, "requiredGateKeys");
  return result.valid ? validResult(result.value) : result;
}

export function validateFinalDiffInspectionInput(
  value: unknown,
): ValidationResult<FinalDiffInspectionInput> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "requirementsSatisfied",
      "changedPaths",
      "scope",
      "nonGoalViolations",
      "acceptedFindingsResolved",
      "deferredFindingsDocumented",
      "rejectedFindingsDocumented",
      "gates",
      "requiredGateKeys",
      "workingTree",
    ])
  ) {
    return invalidResult(
      "Final Diff Inspection input has unknown or missing fields",
    );
  }

  const changedPaths = validatePathList(value.changedPaths, "changedPaths");
  const scope = validateScope(value.scope);
  const nonGoalViolations = validateStringList(
    value.nonGoalViolations,
    "nonGoalViolations",
  );
  const requiredGateKeys = validateRequiredGateKeys(value.requiredGateKeys);
  const workingTree = validateWorkingTreeEvidence(value.workingTree);
  if (
    typeof value.requirementsSatisfied !== "boolean" ||
    typeof value.acceptedFindingsResolved !== "boolean" ||
    typeof value.deferredFindingsDocumented !== "boolean" ||
    typeof value.rejectedFindingsDocumented !== "boolean" ||
    !changedPaths.valid ||
    !scope.valid ||
    !nonGoalViolations.valid ||
    !Array.isArray(value.gates) ||
    !requiredGateKeys.valid ||
    !workingTree.valid
  ) {
    return invalidResult(
      "Final Diff Inspection input is invalid",
      ...(!changedPaths.valid ? changedPaths.errors : []),
      ...(!scope.valid ? scope.errors : []),
      ...(!nonGoalViolations.valid ? nonGoalViolations.errors : []),
      ...(!requiredGateKeys.valid ? requiredGateKeys.errors : []),
      ...(!workingTree.valid ? workingTree.errors : []),
    );
  }

  return validResult({
    requirementsSatisfied: value.requirementsSatisfied,
    changedPaths: changedPaths.value,
    scope: scope.value,
    nonGoalViolations: nonGoalViolations.value,
    acceptedFindingsResolved: value.acceptedFindingsResolved,
    deferredFindingsDocumented: value.deferredFindingsDocumented,
    rejectedFindingsDocumented: value.rejectedFindingsDocumented,
    gates: value.gates,
    ...(requiredGateKeys.value === undefined
      ? {}
      : { requiredGateKeys: requiredGateKeys.value }),
    workingTree: workingTree.value,
  });
}

function samePathSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((path) => rightSet.has(path));
}

function check(
  id: FinalDiffCheckId,
  status: FinalDiffInspectionStatus,
  reason: string,
  evidenceRef?: ArtifactRef,
): FinalDiffCheck {
  return {
    id,
    status,
    reason,
    ...(evidenceRef === undefined ? {} : { evidenceRef }),
  };
}

function blockersFor(
  checks: readonly FinalDiffCheck[],
): FinalDiffInspectionResult["blockers"] {
  return checks
    .filter(({ status }) => status !== "PASS")
    .map(({ id, reason, evidenceRef }) => ({
      code: id,
      reason,
      ...(evidenceRef === undefined ? {} : { evidenceRef }),
    }));
}

function aggregateStatus(
  checks: readonly FinalDiffCheck[],
): FinalDiffInspectionStatus {
  if (checks.some(({ status }) => status === "FAIL")) return "FAIL";
  if (checks.some(({ status }) => status === "MISSING")) return "MISSING";
  if (checks.some(({ status }) => status === "UNKNOWN")) return "UNKNOWN";
  return "PASS";
}

function invalidInspection(
  errors: readonly string[],
): FinalDiffInspectionResult {
  const reason = errors.join("; ") || "Final Diff Inspection input is invalid";
  return {
    contractVersion: FINAL_DIFF_INSPECTION_CONTRACT_VERSION,
    status: "UNKNOWN",
    passed: false,
    checks: [],
    blockers: [{ code: "invalid-input", reason }],
  };
}

export function evaluateFinalDiffInspection(
  input: FinalDiffInspectionInput,
): FinalDiffInspectionResult {
  const validated = validateFinalDiffInspectionInput(input);
  if (!validated.valid) return invalidInspection(validated.errors);

  const value = validated.value;
  const workerPaths = validateWorkerChangedPaths(
    value.changedPaths,
    value.scope,
  );
  const treePaths = [
    ...value.workingTree.trackedPaths,
    ...value.workingTree.untrackedPaths,
  ];
  const treePathsValid = validateWorkerChangedPaths(treePaths, value.scope);
  const treeEvidenceMatches = samePathSet(treePaths, value.changedPaths);
  const gates = evaluateTrustedGates(value.gates, value.requiredGateKeys ?? []);

  const requirements = check(
    "approved-requirements",
    value.requirementsSatisfied ? "PASS" : "FAIL",
    value.requirementsSatisfied
      ? "approved requirements are implemented"
      : "approved requirements are not all implemented",
  );
  const unexpectedFiles = check(
    "unexpected-files",
    workerPaths.valid && treePathsValid.valid ? "PASS" : "FAIL",
    workerPaths.valid && treePathsValid.valid
      ? "all changed and untracked files are within the approved scope"
      : [
          ...(!workerPaths.valid ? workerPaths.errors : []),
          ...(!treePathsValid.valid ? treePathsValid.errors : []),
        ].join("; "),
  );
  const nonGoals = check(
    "non-goals",
    value.nonGoalViolations.length === 0 ? "PASS" : "FAIL",
    value.nonGoalViolations.length === 0
      ? "approved non-goals were respected"
      : `Non-goal violations were reported: ${value.nonGoalViolations.join(", ")}`,
  );
  const acceptedFindings = check(
    "accepted-findings",
    value.acceptedFindingsResolved ? "PASS" : "FAIL",
    value.acceptedFindingsResolved
      ? "accepted Findings are resolved"
      : "accepted Findings remain unresolved",
  );
  const deferredRejectedFindings = check(
    "deferred-rejected-findings",
    value.deferredFindingsDocumented && value.rejectedFindingsDocumented
      ? "PASS"
      : "FAIL",
    value.deferredFindingsDocumented && value.rejectedFindingsDocumented
      ? "DEFERRED and REJECTED Findings are documented"
      : "DEFERRED and REJECTED Findings are not fully documented",
  );
  const requiredGates = check(
    "required-gates",
    gates.passed
      ? "PASS"
      : gates.blockers.some(({ code }) => code === "REQUIRED_GATE_FAIL")
        ? "FAIL"
        : gates.blockers.some(({ code }) => code === "REQUIRED_GATE_UNKNOWN")
          ? "UNKNOWN"
          : "UNKNOWN",
    gates.passed
      ? "mandatory and required Gates are green"
      : gates.blockers.map(({ reason }) => reason).join("; "),
  );
  const optionalGateCount = value.gates.filter(
    (gate) => gate.requirement === "optional",
  ).length;
  const optionalGates = check(
    "optional-gates",
    gates.valid ? "PASS" : "UNKNOWN",
    gates.valid
      ? optionalGateCount === 0
        ? "no optional Gates were declared"
        : "optional Gate outcomes are recorded"
      : "Gate records are invalid",
  );
  const workingTree = check(
    "working-tree",
    value.workingTree.status !== "known"
      ? "UNKNOWN"
      : !treeEvidenceMatches
        ? "FAIL"
        : "PASS",
    value.workingTree.status !== "known"
      ? "working tree state is unknown"
      : !treeEvidenceMatches
        ? "working tree evidence does not match the inspected paths"
        : "working tree state is understood",
    value.workingTree.evidenceRef,
  );

  const checks = [
    requirements,
    unexpectedFiles,
    nonGoals,
    acceptedFindings,
    deferredRejectedFindings,
    requiredGates,
    optionalGates,
    workingTree,
  ];
  const status = aggregateStatus(checks);
  return {
    contractVersion: FINAL_DIFF_INSPECTION_CONTRACT_VERSION,
    status,
    passed: status === "PASS",
    checks,
    blockers: blockersFor(checks),
  };
}

export function validateFinalDiffInspectionResult(
  value: unknown,
): ValidationResult<FinalDiffInspectionResult> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "contractVersion",
      "status",
      "passed",
      "checks",
      "blockers",
    ]) ||
    value.contractVersion !== FINAL_DIFF_INSPECTION_CONTRACT_VERSION ||
    !isFinalDiffInspectionStatus(value.status) ||
    typeof value.passed !== "boolean" ||
    !Array.isArray(value.checks) ||
    !Array.isArray(value.blockers)
  ) {
    return invalidResult("Final Diff Inspection result has an invalid shape");
  }
  if (value.passed !== (value.status === "PASS")) {
    return invalidResult("Final Diff Inspection result status is inconsistent");
  }
  if (value.checks.length !== CHECK_IDS.length) {
    return invalidResult(
      "Final Diff Inspection result is missing checklist items",
    );
  }

  const checks: FinalDiffCheck[] = [];
  const seenChecks = new Set<FinalDiffCheckId>();
  for (const candidate of value.checks) {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, ["id", "status", "reason", "evidenceRef"]) ||
      !isFinalDiffCheckId(candidate.id) ||
      seenChecks.has(candidate.id) ||
      !isFinalDiffInspectionStatus(candidate.status) ||
      !isBoundedString(candidate.reason, MAX_LIST_ITEM_BYTES, true)
    ) {
      return invalidResult("Final Diff Inspection checklist item is invalid");
    }
    let evidenceRef: ArtifactRef | undefined;
    if ("evidenceRef" in candidate) {
      if (!isValidArtifactRef(candidate.evidenceRef)) {
        return invalidResult("Final Diff Inspection checklist item is invalid");
      }
      evidenceRef = candidate.evidenceRef;
    }
    seenChecks.add(candidate.id);
    checks.push({
      id: candidate.id,
      status: candidate.status,
      reason: candidate.reason,
      ...(evidenceRef === undefined ? {} : { evidenceRef }),
    });
  }
  if (seenChecks.size !== CHECK_IDS.length) {
    return invalidResult("Final Diff Inspection checklist is incomplete");
  }
  if (aggregateStatus(checks) !== value.status) {
    return invalidResult("Final Diff Inspection status is inconsistent");
  }

  const blockers: FinalDiffInspectionResult["blockers"] = [];
  for (const candidate of value.blockers) {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, ["code", "reason", "evidenceRef"]) ||
      (candidate.code !== "invalid-input" &&
        !isFinalDiffCheckId(candidate.code)) ||
      !isBoundedString(candidate.reason, MAX_LIST_ITEM_BYTES, true)
    ) {
      return invalidResult("Final Diff Inspection blocker is invalid");
    }
    let evidenceRef: ArtifactRef | undefined;
    if ("evidenceRef" in candidate) {
      if (!isValidArtifactRef(candidate.evidenceRef)) {
        return invalidResult("Final Diff Inspection blocker is invalid");
      }
      evidenceRef = candidate.evidenceRef;
    }
    blockers.push({
      code: candidate.code,
      reason: candidate.reason,
      ...(evidenceRef === undefined ? {} : { evidenceRef }),
    });
  }
  const expectedBlockerCount = checks.filter(
    ({ status }) => status !== "PASS",
  ).length;
  if (expectedBlockerCount !== blockers.length) {
    return invalidResult("Final Diff Inspection blockers are inconsistent");
  }

  return validResult({
    contractVersion: FINAL_DIFF_INSPECTION_CONTRACT_VERSION,
    status: value.status,
    passed: value.passed,
    checks,
    blockers,
  });
}
