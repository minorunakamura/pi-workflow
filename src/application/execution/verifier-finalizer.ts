import { stringify as stringifyYaml } from "yaml";
import {
  ContractValidationError,
  StepResultV1Schema,
  type AgentExecutionRequestV1,
  type JsonObject,
  type JsonValue,
  type StepResultV1,
} from "../../contracts/execution/agent-execution.js";
import {
  ArtifactFrontMatterV1Schema,
  type ArtifactStatus,
} from "../../contracts/artifacts/artifact.js";
import type {
  ExecutionId,
  IdAllocator,
  RunId,
  StepId,
  VerificationRunId,
} from "../../domain/primitives/ids.js";
import { createIdAllocator } from "../../domain/primitives/ids.js";
import type { AgentRuntime } from "../../ports/agent-runtime.js";
import { validateAgentExecutionRequest } from "../../agents/permission-policy.js";
import { TelemetryAgentRuntime, type TelemetryLevel } from "../../telemetry/runtime-metrics.js";
import type { ArtifactRef, ArtifactStore } from "../../ports/artifact-store.js";
import type {
  RepositoryAdapter,
  RepositoryDiff,
  RepositorySnapshot,
} from "../../ports/repository.js";

export const VERIFICATION_CHECK_STATUSES = ["passed", "failed", "skipped", "unavailable"] as const;
export type VerificationCheckStatus = (typeof VERIFICATION_CHECK_STATUSES)[number];

export const VERIFICATION_CHECK_TYPES = [
  "test",
  "build",
  "lint",
  "typecheck",
  "format",
  "behavior",
  "regression",
  "inspection",
  "manual",
] as const;
export type VerificationCheckType = (typeof VERIFICATION_CHECK_TYPES)[number];

export const VERIFICATION_RESULTS = ["passed", "failed", "incomplete"] as const;
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

export const VERIFICATION_STRENGTHS = ["strong", "partial", "weak", "none"] as const;
export type VerificationStrength = (typeof VERIFICATION_STRENGTHS)[number];

export type VerificationCheck = JsonObject &
  Readonly<{
    check_index: number;
    status: VerificationCheckStatus;
    type: VerificationCheckType;
    required: boolean;
    evidence?: JsonValue;
  }>;

export type VerifierRepositoryObservation = Readonly<{
  mutated: boolean;
  changedFiles: readonly string[];
  headChanged: boolean;
  branchChanged: boolean;
  statusChanged: boolean;
  fingerprintChanged: boolean;
}>;

export type VerificationRun = Readonly<{
  id: VerificationRunId;
  runId: RunId;
  stepId: StepId;
  executionId: ExecutionId;
  status: ArtifactStatus;
  result: VerificationResult;
  strength: VerificationStrength;
  accepted: boolean;
  basis: JsonObject;
  checks: readonly VerificationCheck[];
  evidence: readonly JsonValue[];
  limitations: readonly JsonValue[];
  repository: VerifierRepositoryObservation;
}>;

export type VerifierFinalizerInput = Readonly<{
  request: AgentExecutionRequestV1;
  result: StepResultV1;
  before: RepositorySnapshot;
  after: RepositorySnapshot;
  diff?: RepositoryDiff;
  executionStateRevision: number;
  basis?: JsonObject;
  evidence?: readonly JsonValue[];
  limitations?: readonly JsonValue[];
  strength?: VerificationStrength;
}>;

export type VerifierFinalization = Readonly<{
  verificationRun: VerificationRun;
  artifact: ArtifactRef;
  contents: string;
  checks: readonly VerificationCheck[];
  diff: RepositoryDiff;
}>;

export type VerifierFinalizerOptions = Readonly<{
  artifactStore: ArtifactStore;
  repository?: RepositoryAdapter;
  idAllocator?: IdAllocator;
  now?: () => Date;
}>;

export type VerifierFinalizationErrorCode =
  | "VERIFIER_REQUEST_INVALID"
  | "RESULT_INVALID"
  | "CHECK_INVALID"
  | "BASIS_INVALID";

export class VerifierFinalizationError extends Error {
  constructor(
    readonly code: VerifierFinalizationErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "VerifierFinalizationError";
  }
}

const READ_ONLY_TOOL_PATTERN =
  /(?:^|[-_\s])(write|edit|delete|remove|commit|push|merge|rebase|reset|restore|clean|branch|checkout|switch|cherry-pick|revert|tag|stash)(?:$|[-_\s])/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => jsonValue(entry, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, entry]) => jsonValue(entry, `${path}.${key}`));
    return;
  }
  throw new VerifierFinalizationError("BASIS_INVALID", `${path} must be a JSON value`);
}

function jsonObject(value: unknown, path: string): JsonObject {
  if (!isRecord(value)) {
    throw new VerifierFinalizationError("BASIS_INVALID", `${path} must be an object`);
  }
  Object.entries(value).forEach(([key, entry]) => jsonValue(entry, `${path}.${key}`));
  return value as JsonObject;
}

function containsWritePermission(value: unknown): string | undefined {
  if (typeof value === "string") {
    return READ_ONLY_TOOL_PATTERN.test(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = containsWritePermission(entry);
      if (found !== undefined) return found;
    }
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      const found = containsWritePermission(entry);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Verifier requests are read-only and cannot grant source or Git writes. */
export function validateVerifierExecutionRequest(
  request: AgentExecutionRequestV1,
): AgentExecutionRequestV1 {
  let validated: AgentExecutionRequestV1;
  try {
    validated = validateAgentExecutionRequest(request);
  } catch (error) {
    throw new VerifierFinalizationError(
      "VERIFIER_REQUEST_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (validated.identity.agentId !== "verifier" || validated.execution.mode !== "verify-only") {
    throw new VerifierFinalizationError(
      "VERIFIER_REQUEST_INVALID",
      "Verifier execution requires agentId=verifier and execution.mode=verify-only",
    );
  }
  if (validated.authority.maximumDLevel !== "D0") {
    throw new VerifierFinalizationError(
      "VERIFIER_REQUEST_INVALID",
      "Verifier execution authority must be D0",
    );
  }
  const policyAllow = isRecord(validated.tools.policy) ? validated.tools.policy.allow : undefined;
  const sources: readonly [string, unknown][] = [
    ["permissions.filesystem", validated.permissions.filesystem],
    ["permissions.shell", validated.permissions.shell],
    ["permissions.git", validated.permissions.git],
    ["tools.resolved", validated.tools.resolved],
    ["tools.policy.allow", policyAllow],
  ];
  for (const [source, value] of sources) {
    const found = containsWritePermission(value);
    if (found !== undefined) {
      throw new VerifierFinalizationError(
        "VERIFIER_REQUEST_INVALID",
        `${source} grants a write operation: ${found}`,
      );
    }
  }
  return validated;
}

function validateRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new VerifierFinalizationError(
      "RESULT_INVALID",
      "executionStateRevision must be a non-negative safe integer",
    );
  }
  return value;
}

function verifierResult(value: unknown, request: AgentExecutionRequestV1): StepResultV1 {
  try {
    const result = StepResultV1Schema.parse(value);
    if (
      result.identity.runId !== request.identity.runId ||
      result.identity.stepId !== request.identity.stepId ||
      result.identity.executionId !== request.identity.executionId
    ) {
      throw new VerifierFinalizationError(
        "RESULT_INVALID",
        "Verifier result identity does not match the Execution Request",
      );
    }
    if (result.mode !== undefined && result.mode !== request.execution.mode) {
      throw new VerifierFinalizationError(
        "RESULT_INVALID",
        "Verifier result mode does not match verify-only execution",
      );
    }
    if (result.finding_candidates.length > 0 || result.finding_rechecks.length > 0) {
      throw new VerifierFinalizationError(
        "RESULT_INVALID",
        "Verifier must not create or recheck Findings",
      );
    }
    return result;
  } catch (error) {
    if (error instanceof VerifierFinalizationError) throw error;
    if (
      error instanceof ContractValidationError &&
      error.issues[0]?.path.startsWith("execution_checks[")
    ) {
      throw new VerifierFinalizationError("CHECK_INVALID", error.message);
    }
    throw new VerifierFinalizationError(
      "RESULT_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function checkStatus(value: unknown, index: number): VerificationCheckStatus {
  if (
    typeof value !== "string" ||
    !(VERIFICATION_CHECK_STATUSES as readonly string[]).includes(value)
  ) {
    throw new VerifierFinalizationError(
      "CHECK_INVALID",
      `execution_checks[${index}].status must be passed, failed, skipped, or unavailable`,
    );
  }
  return value as VerificationCheckStatus;
}

function checkType(value: unknown, index: number): VerificationCheckType {
  if (
    typeof value !== "string" ||
    !(VERIFICATION_CHECK_TYPES as readonly string[]).includes(value)
  ) {
    throw new VerifierFinalizationError(
      "CHECK_INVALID",
      `execution_checks[${index}].type is not a supported Verification Check type`,
    );
  }
  return value as VerificationCheckType;
}

function parseChecks(result: StepResultV1): readonly VerificationCheck[] {
  return result.execution_checks.map((candidate, index) => {
    const status = checkStatus(candidate.status, index);
    const type = checkType(candidate.type, index);
    if (typeof candidate.required !== "boolean") {
      throw new VerifierFinalizationError(
        "CHECK_INVALID",
        `execution_checks[${index}].required must be a boolean`,
      );
    }
    const evidence = Object.hasOwn(candidate, "evidence") ? candidate.evidence : undefined;
    if (evidence !== undefined) jsonValue(evidence, `execution_checks[${index}].evidence`);
    return {
      ...candidate,
      check_index: index + 1,
      status,
      type,
      required: candidate.required,
      ...(evidence === undefined ? {} : { evidence }),
    };
  });
}

function repositoryObservation(diff: RepositoryDiff): VerifierRepositoryObservation {
  return {
    mutated: diff.files.length > 0 || diff.headChanged || diff.branchChanged,
    changedFiles: diff.changedFiles,
    headChanged: diff.headChanged,
    branchChanged: diff.branchChanged,
    statusChanged: diff.statusChanged,
    fingerprintChanged: diff.fingerprintChanged,
  };
}

function aggregateResult(
  result: StepResultV1,
  checks: readonly VerificationCheck[],
  evidence: readonly JsonValue[],
): VerificationResult {
  if (checks.some(({ status }) => status === "failed")) return "failed";
  if (
    result.outcome !== "completed" ||
    checks.length === 0 ||
    evidence.length === 0 ||
    checks.some(
      ({ required, status }) => required && (status === "skipped" || status === "unavailable"),
    )
  ) {
    return "incomplete";
  }
  return "passed";
}

function strengthFor(
  checks: readonly VerificationCheck[],
  override: VerificationStrength | undefined,
): VerificationStrength {
  if (override !== undefined) {
    if (!(VERIFICATION_STRENGTHS as readonly string[]).includes(override)) {
      throw new VerifierFinalizationError(
        "RESULT_INVALID",
        `Unsupported Verification strength: ${override}`,
      );
    }
    return override;
  }
  if (checks.length === 0) return "none";
  if (checks.some(({ status }) => status === "skipped" || status === "unavailable")) {
    return "partial";
  }
  if (checks.every(({ type }) => type === "inspection" || type === "manual")) return "weak";
  return checks.every(({ evidence }) => evidence !== undefined) ? "strong" : "partial";
}

function evidenceFor(
  checks: readonly VerificationCheck[],
  supplied: readonly JsonValue[] | undefined,
): readonly JsonValue[] {
  if (supplied !== undefined) {
    supplied.forEach((entry, index) => jsonValue(entry, `evidence[${index}]`));
    return supplied;
  }
  return checks.flatMap(({ evidence }) => (evidence === undefined ? [] : [evidence]));
}

function limitationsFor(
  checks: readonly VerificationCheck[],
  supplied: readonly JsonValue[] | undefined,
): readonly JsonValue[] {
  if (supplied !== undefined) {
    supplied.forEach((entry, index) => jsonValue(entry, `limitations[${index}]`));
    return supplied;
  }
  return checks
    .filter(({ status }) => status === "skipped" || status === "unavailable")
    .map(({ check_index, status }) => ({ check_index, status }));
}

function snapshotSummary(snapshot: RepositorySnapshot): JsonObject {
  return {
    root: snapshot.root,
    head: snapshot.head,
    branch: snapshot.branch,
    status: snapshot.status,
    fingerprint: snapshot.fingerprint,
  };
}

function artifactContents(
  request: AgentExecutionRequestV1,
  verificationRun: VerificationRun,
  before: RepositorySnapshot,
  after: RepositorySnapshot,
  diff: RepositoryDiff,
  revision: number,
  createdAt: string,
): string {
  const frontMatter = ArtifactFrontMatterV1Schema.parse({
    schema_version: 1,
    run_id: request.identity.runId,
    step_id: request.identity.stepId,
    execution_id: request.identity.executionId,
    execution_state_revision: revision,
    agent: { id: request.identity.agentId, version: 1 },
    artifact: { type: "verification", status: verificationRun.status },
    created_at: createdAt,
    skills: [...request.skills.required, ...request.skills.optional],
    verification_run_id: verificationRun.id,
  });
  const payload: JsonObject = {
    verification_run_id: verificationRun.id,
    result: verificationRun.result,
    strength: verificationRun.strength,
    status: verificationRun.status,
    accepted: verificationRun.accepted,
    basis: verificationRun.basis,
    checks: verificationRun.checks,
    evidence: verificationRun.evidence,
    limitations: verificationRun.limitations,
    repository: {
      before: snapshotSummary(before),
      after: snapshotSummary(after),
      diff: {
        changed_files: diff.changedFiles,
        head_changed: diff.headChanged,
        branch_changed: diff.branchChanged,
        status_changed: diff.statusChanged,
        fingerprint_changed: diff.fingerprintChanged,
      },
    },
  };
  return [
    "---",
    stringifyYaml(frontMatter).trimEnd(),
    "---",
    "## Handoff Summary",
    "",
    `Verification result: ${verificationRun.result}`,
    `Strength: ${verificationRun.strength}; status: ${verificationRun.status}; accepted: ${String(verificationRun.accepted)}`,
    "",
    "## Verification Run",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    "",
  ].join("\n");
}

export class VerifierFinalizer {
  private readonly artifactStore: ArtifactStore;
  private readonly repository: RepositoryAdapter | undefined;
  private readonly idAllocator: IdAllocator;
  private readonly now: () => Date;

  constructor(options: VerifierFinalizerOptions) {
    this.artifactStore = options.artifactStore;
    this.repository = options.repository;
    this.idAllocator = options.idAllocator ?? createIdAllocator();
    this.now = options.now ?? (() => new Date());
  }

  async finalize(input: VerifierFinalizerInput): Promise<VerifierFinalization> {
    const request = validateVerifierExecutionRequest(input.request);
    const result = verifierResult(input.result, request);
    const revision = validateRevision(input.executionStateRevision);
    const diff =
      input.diff ??
      (this.repository === undefined
        ? (() => {
            throw new VerifierFinalizationError(
              "RESULT_INVALID",
              "Verification finalization requires a RepositoryDiff or RepositoryAdapter",
            );
          })()
        : await this.repository.diff(input.before, input.after));
    const checks = parseChecks(result);
    const repository = repositoryObservation(diff);
    const evidence = evidenceFor(checks, input.evidence);
    const verificationResult = repository.mutated
      ? ("incomplete" as const)
      : aggregateResult(result, checks, evidence);
    const status: ArtifactStatus =
      result.outcome === "completed" &&
      checks.length > 0 &&
      evidence.length > 0 &&
      !repository.mutated
        ? "complete"
        : "partial";
    const basis =
      input.basis === undefined
        ? { repository: snapshotSummary(input.before) }
        : jsonObject(input.basis, "basis");
    const limitations = limitationsFor(checks, input.limitations);
    const verificationRun: VerificationRun = {
      id: this.idAllocator.issueVerificationRunId(),
      runId: request.identity.runId,
      stepId: request.identity.stepId,
      executionId: request.identity.executionId,
      status,
      result: verificationResult,
      strength: strengthFor(checks, input.strength),
      accepted: verificationResult === "passed" && !repository.mutated,
      basis,
      checks,
      evidence,
      limitations,
      repository,
    };
    const createdAt = this.now();
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
      throw new VerifierFinalizationError("RESULT_INVALID", "now must return a valid Date");
    }
    const contents = artifactContents(
      request,
      verificationRun,
      input.before,
      input.after,
      diff,
      revision,
      createdAt.toISOString(),
    );
    const staged = await this.artifactStore.stage({
      runId: request.identity.runId,
      executionId: request.identity.executionId,
      contents,
    });
    const artifact = await this.artifactStore.finalize(
      staged,
      `verification/${verificationRun.id}.md`,
    );
    return { verificationRun, artifact, contents, checks, diff };
  }
}

export type VerifierExecutionDependencies = Readonly<{
  agentRuntime: AgentRuntime;
  telemetryLevel?: TelemetryLevel;
  repository: RepositoryAdapter;
  finalizer: Pick<VerifierFinalizer, "finalize">;
}>;

export type VerifierExecutionInput = Readonly<{
  request: AgentExecutionRequestV1;
  executionStateRevision: number;
  basis?: JsonObject;
  evidence?: readonly JsonValue[];
  limitations?: readonly JsonValue[];
  strength?: VerificationStrength;
}>;

export type VerifierExecutionResult = Readonly<{
  result: StepResultV1;
  before: RepositorySnapshot;
  after: RepositorySnapshot;
  diff: RepositoryDiff;
  finalization: VerifierFinalization;
}>;

/** Executes one read-only Verifier between repository snapshots. */
export class VerifierExecutor {
  private readonly agentRuntime: AgentRuntime;

  constructor(private readonly dependencies: VerifierExecutionDependencies) {
    this.agentRuntime = new TelemetryAgentRuntime(
      dependencies.agentRuntime,
      dependencies.telemetryLevel === undefined ? {} : { level: dependencies.telemetryLevel },
    );
  }

  async run(input: VerifierExecutionInput): Promise<VerifierExecutionResult> {
    const request = validateVerifierExecutionRequest(input.request);
    validateRevision(input.executionStateRevision);
    const before = await this.dependencies.repository.captureSnapshot();
    const rawResult = await this.agentRuntime.run(request);
    const after = await this.dependencies.repository.captureSnapshot();
    const diff = await this.dependencies.repository.diff(before, after);
    const result = verifierResult(rawResult, request);
    const finalization = await this.dependencies.finalizer.finalize({
      request,
      result,
      before,
      after,
      diff,
      executionStateRevision: input.executionStateRevision,
      ...(input.basis === undefined ? {} : { basis: input.basis }),
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      ...(input.limitations === undefined ? {} : { limitations: input.limitations }),
      ...(input.strength === undefined ? {} : { strength: input.strength }),
    });
    return { result, before, after, diff, finalization };
  }
}

export { VerifierFinalizer as VerificationRunFinalizer, VerifierExecutor as VerifierExecution };
