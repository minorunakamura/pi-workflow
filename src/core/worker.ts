import {
  hasOnlyKeys,
  invalidResult,
  isBoundedString,
  isRecord,
  isSafeRelativePath,
  validResult,
  type ValidationResult,
} from "./validation.ts";
import {
  isValidArtifactRef,
  isValidWorkflowId,
  isWorkflowType,
  type ArtifactRef,
  type TestStrategy,
  type TddMode,
  type WorkflowId,
  type WorkflowType,
} from "./workflow.ts";

export const WORKER_CONTRACT_VERSION = 1 as const;
export const WORKER_AGENT = "worker" as const;
export const WORKER_OUTPUT_FILE = "worker-summary.md" as const;

export const WORKER_FORBIDDEN_OPERATIONS = [
  "merge",
  "push",
  "release",
  "deploy",
  "approval",
  "unapproved-architecture-change",
] as const;

const MAX_LIST_ITEMS = 32;
const MAX_LIST_ITEM_BYTES = 4096;
const MAX_WORKER_TASK_BYTES = 64 * 1024;

export interface WorkerScope {
  readonly allowedPaths: readonly string[];
  readonly allowedAreas: readonly string[];
}

export interface WorkerHandoff {
  readonly contractVersion: typeof WORKER_CONTRACT_VERSION;
  readonly workflow: {
    readonly workflowId: WorkflowId;
    readonly workflowType: WorkflowType;
    readonly cwd: string;
  };
  readonly requirements: readonly string[];
  readonly scope: WorkerScope;
  readonly nonGoals: readonly string[];
  readonly tddMode: TddMode;
  readonly testStrategy: TestStrategy;
  readonly testSeams: readonly string[];
  readonly verificationCommands: readonly string[];
  readonly trustedGateExpectations: readonly string[];
  readonly stopCondition: string;
}

export interface WorkerLaunchRequest {
  readonly agent: typeof WORKER_AGENT;
  readonly context: "fresh";
  readonly task: string;
  readonly skills?: readonly ["tdd"];
  readonly output: typeof WORKER_OUTPUT_FILE;
  readonly outputMode: "file-only";
  readonly worktree: false;
}

export type TddFailureKind =
  | "behavioral"
  | "syntax"
  | "missing-dependency"
  | "runner"
  | "infrastructure";

export interface WorkerTddEvidence {
  readonly red: {
    readonly status: "FAIL";
    readonly failureKind: "behavioral";
    readonly command: string;
    readonly evidence: string;
  };
  readonly green: {
    readonly status: "PASS";
    readonly command: string;
    readonly evidence: string;
  };
  readonly refactor: {
    readonly status: "performed" | "skipped";
    readonly reason?: string;
  };
}

export interface WorkerResult {
  readonly contractVersion: typeof WORKER_CONTRACT_VERSION;
  readonly status: "COMPLETED" | "FAILED" | "CANCELLED";
  readonly changedPaths: readonly string[];
  readonly tdd?: WorkerTddEvidence;
  readonly artifactRef?: ArtifactRef;
}

function isTddMode(value: unknown): value is TddMode {
  return (
    value === "required" || value === "optional" || value === "not-applicable"
  );
}

function isTestStrategyKind(value: unknown): value is TestStrategy["kind"] {
  return (
    value === "unit" ||
    value === "integration" ||
    value === "mixed" ||
    value === "none"
  );
}

function validateStringList(
  value: unknown,
  fieldName: string,
): ValidationResult<string[]> {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    return invalidResult(
      `${fieldName} must contain at most ${MAX_LIST_ITEMS} items`,
    );
  }
  const values: string[] = [];
  for (const [index, item] of value.entries()) {
    if (!isBoundedString(item, MAX_LIST_ITEM_BYTES, true)) {
      return invalidResult(`${fieldName}[${index}] is invalid`);
    }
    values.push(item);
  }
  return validResult(values);
}

function validateTestStrategy(value: unknown): ValidationResult<TestStrategy> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["kind", "required", "summary"])
  ) {
    return invalidResult("Worker test strategy has unknown or missing fields");
  }
  if (
    !isTestStrategyKind(value.kind) ||
    typeof value.required !== "boolean" ||
    !isBoundedString(value.summary, MAX_LIST_ITEM_BYTES, true)
  ) {
    return invalidResult("Worker test strategy is invalid");
  }
  return validResult({
    kind: value.kind,
    required: value.required,
    summary: value.summary,
  });
}

function validateWorkflow(
  value: unknown,
): ValidationResult<WorkerHandoff["workflow"]> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["workflowId", "workflowType", "cwd"])
  ) {
    return invalidResult("Worker workflow has unknown or missing fields");
  }
  if (
    !isValidWorkflowId(value.workflowId) ||
    !isWorkflowType(value.workflowType) ||
    !isBoundedString(value.cwd, MAX_LIST_ITEM_BYTES, true) ||
    /[\0\r\n]/u.test(value.cwd)
  ) {
    return invalidResult("Worker workflow is invalid");
  }
  return validResult({
    workflowId: value.workflowId,
    workflowType: value.workflowType,
    cwd: value.cwd,
  });
}

function normalizeScopePath(value: string): string {
  return value.replace(/\\/gu, "/");
}

function validateScopePath(value: unknown): string | undefined {
  if (
    !isBoundedString(value, MAX_LIST_ITEM_BYTES, true) ||
    /[\0\r\n]/u.test(value) ||
    !isSafeRelativePath(value)
  ) {
    return undefined;
  }
  return normalizeScopePath(value);
}

function validateScope(value: unknown): ValidationResult<WorkerScope> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["allowedPaths", "allowedAreas"])
  ) {
    return invalidResult("Worker scope has unknown or missing fields");
  }
  if (
    !Array.isArray(value.allowedPaths) ||
    !Array.isArray(value.allowedAreas)
  ) {
    return invalidResult("Worker scope must contain path and area lists");
  }
  const allowedPaths: string[] = [];
  const allowedAreas: string[] = [];
  const seen = new Set<string>();
  for (const path of value.allowedPaths) {
    const normalized = validateScopePath(path);
    if (normalized === undefined || seen.has(`path:${normalized}`)) {
      return invalidResult("Worker scope contains an invalid path");
    }
    seen.add(`path:${normalized}`);
    allowedPaths.push(normalized);
  }
  for (const area of value.allowedAreas) {
    const normalized = validateScopePath(area);
    if (normalized === undefined || seen.has(`area:${normalized}`)) {
      return invalidResult("Worker scope contains an invalid area");
    }
    seen.add(`area:${normalized}`);
    allowedAreas.push(normalized);
  }
  if (
    allowedPaths.length > MAX_LIST_ITEMS ||
    allowedAreas.length > MAX_LIST_ITEMS ||
    allowedPaths.length + allowedAreas.length === 0
  ) {
    return invalidResult("Worker scope must be bounded and non-empty");
  }
  return validResult({ allowedPaths, allowedAreas });
}

export function validateWorkerHandoff(
  value: unknown,
): ValidationResult<WorkerHandoff> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "contractVersion",
      "workflow",
      "requirements",
      "scope",
      "nonGoals",
      "tddMode",
      "testStrategy",
      "testSeams",
      "verificationCommands",
      "trustedGateExpectations",
      "stopCondition",
    ])
  ) {
    return invalidResult("Worker handoff has unknown or missing fields");
  }

  const workflow = validateWorkflow(value.workflow);
  const requirements = validateStringList(value.requirements, "requirements");
  const scope = validateScope(value.scope);
  const nonGoals = validateStringList(value.nonGoals, "nonGoals");
  const testSeams = validateStringList(value.testSeams, "testSeams");
  const verificationCommands = validateStringList(
    value.verificationCommands,
    "verificationCommands",
  );
  const trustedGateExpectations = validateStringList(
    value.trustedGateExpectations,
    "trustedGateExpectations",
  );
  const testStrategy = validateTestStrategy(value.testStrategy);

  if (
    value.contractVersion !== WORKER_CONTRACT_VERSION ||
    !workflow.valid ||
    !requirements.valid ||
    !scope.valid ||
    !nonGoals.valid ||
    !isTddMode(value.tddMode) ||
    !testStrategy.valid ||
    !testSeams.valid ||
    !verificationCommands.valid ||
    !trustedGateExpectations.valid ||
    !isBoundedString(value.stopCondition, MAX_LIST_ITEM_BYTES, true)
  ) {
    return invalidResult(
      "Worker handoff is invalid",
      ...(!workflow.valid ? workflow.errors : []),
      ...(!requirements.valid ? requirements.errors : []),
      ...(!scope.valid ? scope.errors : []),
      ...(!nonGoals.valid ? nonGoals.errors : []),
      ...(!testStrategy.valid ? testStrategy.errors : []),
      ...(!testSeams.valid ? testSeams.errors : []),
      ...(!verificationCommands.valid ? verificationCommands.errors : []),
      ...(!trustedGateExpectations.valid ? trustedGateExpectations.errors : []),
    );
  }

  return validResult({
    contractVersion: WORKER_CONTRACT_VERSION,
    workflow: workflow.value,
    requirements: requirements.value,
    scope: scope.value,
    nonGoals: nonGoals.value,
    tddMode: value.tddMode,
    testStrategy: testStrategy.value,
    testSeams: testSeams.value,
    verificationCommands: verificationCommands.value,
    trustedGateExpectations: trustedGateExpectations.value,
    stopCondition: value.stopCondition,
  });
}

function isTddFailureKind(value: unknown): value is TddFailureKind {
  return (
    value === "behavioral" ||
    value === "syntax" ||
    value === "missing-dependency" ||
    value === "runner" ||
    value === "infrastructure"
  );
}

export function validateWorkerTddEvidence(
  value: unknown,
): ValidationResult<WorkerTddEvidence> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["red", "green", "refactor"]) ||
    !isRecord(value.red) ||
    !isRecord(value.green) ||
    !isRecord(value.refactor)
  ) {
    return invalidResult("Worker TDD evidence has an invalid shape");
  }
  if (
    !hasOnlyKeys(value.red, ["status", "failureKind", "command", "evidence"]) ||
    !hasOnlyKeys(value.green, ["status", "command", "evidence"]) ||
    !hasOnlyKeys(value.refactor, ["status", "reason"])
  ) {
    return invalidResult("Worker TDD evidence has unknown fields");
  }
  if (
    value.red.status !== "FAIL" ||
    !isTddFailureKind(value.red.failureKind) ||
    value.red.failureKind !== "behavioral" ||
    !isBoundedString(value.red.command, MAX_LIST_ITEM_BYTES, true) ||
    !isBoundedString(value.red.evidence, MAX_LIST_ITEM_BYTES, true) ||
    value.green.status !== "PASS" ||
    !isBoundedString(value.green.command, MAX_LIST_ITEM_BYTES, true) ||
    !isBoundedString(value.green.evidence, MAX_LIST_ITEM_BYTES, true) ||
    (value.refactor.status !== "performed" &&
      value.refactor.status !== "skipped")
  ) {
    return invalidResult("Worker TDD evidence is not a valid RED/GREEN cycle");
  }
  let refactor: WorkerTddEvidence["refactor"];
  if (value.refactor.status === "skipped") {
    const reason = value.refactor.reason;
    if (!isBoundedString(reason, MAX_LIST_ITEM_BYTES, true)) {
      return invalidResult("Skipped refactor requires a reason");
    }
    refactor = { status: "skipped", reason };
  } else {
    refactor = { status: "performed" };
  }
  return validResult({
    red: {
      status: "FAIL",
      failureKind: "behavioral",
      command: value.red.command,
      evidence: value.red.evidence,
    },
    green: {
      status: "PASS",
      command: value.green.command,
      evidence: value.green.evidence,
    },
    refactor,
  });
}

export function validateWorkerChangedPaths(
  changedPaths: unknown,
  scope: WorkerScope,
): ValidationResult<string[]> {
  if (!Array.isArray(changedPaths)) {
    return invalidResult("Worker changed paths must be an array");
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const path of changedPaths) {
    const normalized = validateScopePath(path);
    if (normalized === undefined || seen.has(normalized)) {
      return invalidResult("Worker changed paths contain an invalid path");
    }
    if (!isWithinWorkerScope(normalized, scope)) {
      return invalidResult(
        `Worker changed path is outside approved scope: ${path}`,
      );
    }
    seen.add(normalized);
    paths.push(normalized);
  }
  return validResult(paths);
}

export function isWithinWorkerScope(
  changedPath: string,
  scope: WorkerScope,
): boolean {
  const normalized = normalizeScopePath(changedPath);
  if (scope.allowedPaths.includes(normalized)) return true;
  return scope.allowedAreas.some(
    (area) => normalized === area || normalized.startsWith(`${area}/`),
  );
}

export function validateWorkerResult(
  value: unknown,
  handoff: WorkerHandoff,
): ValidationResult<WorkerResult> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "contractVersion",
      "status",
      "changedPaths",
      "tdd",
      "artifactRef",
    ])
  ) {
    return invalidResult("Worker result has unknown or missing fields");
  }
  if (
    value.contractVersion !== WORKER_CONTRACT_VERSION ||
    (value.status !== "COMPLETED" &&
      value.status !== "FAILED" &&
      value.status !== "CANCELLED")
  ) {
    return invalidResult("Worker result is invalid");
  }
  const changedPaths = validateWorkerChangedPaths(
    value.changedPaths,
    handoff.scope,
  );
  if (!changedPaths.valid) return changedPaths;

  let tdd: WorkerTddEvidence | undefined;
  if ("tdd" in value) {
    const evidence = validateWorkerTddEvidence(value.tdd);
    if (!evidence.valid) return evidence;
    tdd = evidence.value;
  }
  if (
    value.status === "COMPLETED" &&
    handoff.tddMode === "required" &&
    tdd === undefined
  ) {
    return invalidResult(
      "Completed Worker result is missing required TDD evidence",
    );
  }
  let artifactRef: ArtifactRef | undefined;
  if ("artifactRef" in value) {
    if (!isValidArtifactRef(value.artifactRef)) {
      return invalidResult("Worker result artifact reference is invalid");
    }
    artifactRef = value.artifactRef;
  }

  return validResult({
    contractVersion: WORKER_CONTRACT_VERSION,
    status: value.status,
    changedPaths: changedPaths.value,
    ...(tdd === undefined ? {} : { tdd }),
    ...(artifactRef === undefined ? {} : { artifactRef }),
  });
}

export function createWorkerLaunchRequest(
  value: unknown,
): ValidationResult<WorkerLaunchRequest> {
  const handoff = validateWorkerHandoff(value);
  if (!handoff.valid) return handoff;

  const task = JSON.stringify({
    ...handoff.value,
    authority: {
      sourceWrite: "approved-scope-only",
      prohibitedOperations: [...WORKER_FORBIDDEN_OPERATIONS],
    },
  });
  if (!isBoundedString(task, MAX_WORKER_TASK_BYTES, true)) {
    return invalidResult("Worker task is too large");
  }

  return validResult({
    agent: WORKER_AGENT,
    context: "fresh",
    task,
    ...(handoff.value.tddMode === "required"
      ? { skills: ["tdd"] as const }
      : {}),
    output: WORKER_OUTPUT_FILE,
    outputMode: "file-only",
    worktree: false,
  });
}
