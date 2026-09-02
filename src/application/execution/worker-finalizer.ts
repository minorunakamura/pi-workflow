import { stringify as stringifyYaml } from "yaml";
import {
  StepResultV1Schema,
  type AgentExecutionRequestV1,
  type AgentOutcome,
  type JsonObject,
  type JsonValue,
  type StepResultV1,
} from "../../contracts/execution/agent-execution.js";
import {
  ArtifactFrontMatterV1Schema,
  type ArtifactStatus,
} from "../../contracts/artifacts/artifact.js";
import type {
  ChangeSetId,
  ExecutionId,
  IdAllocator,
  RunId,
  StepId,
} from "../../domain/primitives/ids.js";
import { createIdAllocator } from "../../domain/primitives/ids.js";
import type { AgentRuntime } from "../../ports/agent-runtime.js";
import {
  AgentPermissionError,
  validateAgentExecutionRequest,
} from "../../agents/permission-policy.js";
import { TelemetryAgentRuntime, type TelemetryLevel } from "../../telemetry/runtime-metrics.js";
import type { ArtifactRef, ArtifactStore } from "../../ports/artifact-store.js";
import type {
  RepositoryAdapter,
  RepositoryDiff,
  RepositoryFileDiff,
  RepositoryScope,
  RepositorySnapshot,
  RepositoryStatusEntry,
} from "../../ports/repository.js";
import {
  InterruptedExecutionRecovery,
  type InterruptedExecutionRecoveryResult,
} from "../recovery/interrupted-execution-recovery.js";

export type WriteScope = RepositoryScope;

export const CHANGE_SET_ATTRIBUTIONS = [
  "pre-existing",
  "workflow-attributed",
  "uncertain",
] as const;
export type ChangeSetAttribution = (typeof CHANGE_SET_ATTRIBUTIONS)[number];

export type ChangeSetFile = RepositoryFileDiff & Readonly<{ attribution: ChangeSetAttribution }>;

export type WorkerMutationObservation = Readonly<{
  changed: boolean;
  files: readonly ChangeSetFile[];
  changedFiles: readonly string[];
  workflowAttributedFiles: readonly string[];
  preExistingFiles: readonly string[];
  preExistingChangedFiles: readonly string[];
  preservedPreExistingFiles: readonly string[];
  uncertainFiles: readonly string[];
  outOfScopeFiles: readonly string[];
  writeScope: readonly string[];
  attributionUncertain: boolean;
  preExistingChangeLost: boolean;
  gitWriteDetected: boolean;
}>;

export type WorkerFinalizationViolationCode =
  | "WRITE_SCOPE_VIOLATION"
  | "PREEXISTING_CHANGE_LOST"
  | "GIT_WRITE_DENIED";

export type WorkerFinalizationViolation = Readonly<{
  code: WorkerFinalizationViolationCode;
  paths: readonly string[];
  message: string;
}>;

export type ChangeSet = Readonly<{
  id: ChangeSetId;
  runId: RunId;
  stepId: StepId;
  executionId: ExecutionId;
  status: ArtifactStatus;
  changed: boolean;
  accepted: boolean;
  outcome: AgentOutcome | null;
  summary: string;
  observation: WorkerMutationObservation;
  violations: readonly WorkerFinalizationViolation[];
  intent: Readonly<{
    artifacts: readonly JsonValue[];
    planDeviations: readonly JsonObject[];
    executionChecks: readonly JsonObject[];
    observations: readonly JsonObject[];
  }>;
}>;

export type WorkerFinalizerInput = Readonly<{
  request: AgentExecutionRequestV1;
  result: StepResultV1 | null;
  before: RepositorySnapshot;
  after: RepositorySnapshot;
  diff?: RepositoryDiff;
  writeScope?: WriteScope;
  executionStateRevision: number;
}>;

export type WorkerFinalization = Readonly<{
  changeSet: ChangeSet;
  artifact: ArtifactRef;
  contents: string;
  observation: WorkerMutationObservation;
  diff: RepositoryDiff;
}>;

export type WorkerFinalizerOptions = Readonly<{
  artifactStore: ArtifactStore;
  repository?: RepositoryAdapter;
  idAllocator?: IdAllocator;
  now?: () => Date;
}>;

export type WorkerFinalizationErrorCode =
  | "WORKER_REQUEST_INVALID"
  | "GIT_WRITE_DENIED"
  | "WRITE_SCOPE_INVALID"
  | "RESULT_INVALID";

export class WorkerFinalizationError extends Error {
  constructor(
    readonly code: WorkerFinalizationErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "WorkerFinalizationError";
  }
}

export class WorkerExecutionInterruptedError extends Error {
  readonly code = "WORKER_EXECUTION_INTERRUPTED";

  constructor(
    readonly recovery: InterruptedExecutionRecoveryResult,
    cause: unknown,
  ) {
    super(
      `Worker execution was interrupted for ${recovery.request.identity.runId}/${
        recovery.request.identity.stepId
      }/${recovery.request.identity.executionId}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "WorkerExecutionInterruptedError";
  }
}

const GIT_WRITE_OPERATION =
  /(?:^|[-_\s])(write|add|commit|push|merge|rebase|reset|restore|clean|branch|checkout|switch|cherry-pick|revert|tag|stash)(?:$|[-_\s])/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gitWriteToken(value: unknown): string | undefined {
  if (typeof value === "string") return GIT_WRITE_OPERATION.test(value) ? value : undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const token = gitWriteToken(entry);
      if (token !== undefined) return token;
    }
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      const token = gitWriteToken(entry);
      if (token !== undefined) return token;
    }
  }
  return undefined;
}

/** Rejects explicit Git write grants before a Worker is dispatched. */
export function assertWorkerGitWriteDenied(request: AgentExecutionRequestV1): void {
  const policyAllow = isRecord(request.tools.policy) ? request.tools.policy.allow : undefined;
  const sources: readonly [string, unknown][] = [
    ["permissions.git", request.permissions.git],
    ["permissions.shell", request.permissions.shell],
    ["tools.resolved", request.tools.resolved],
    ["tools.policy.allow", policyAllow],
  ];
  for (const [source, value] of sources) {
    const token = gitWriteToken(value);
    if (token !== undefined) {
      throw new WorkerFinalizationError(
        "GIT_WRITE_DENIED",
        `${source} contains the Git write operation ${token}`,
      );
    }
  }
}

function validRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkerFinalizationError(
      "RESULT_INVALID",
      "executionStateRevision must be a non-negative safe integer",
    );
  }
  return value;
}

function normalizedScopePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\u0000") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new WorkerFinalizationError(
      "WRITE_SCOPE_INVALID",
      `Write Scope contains an unsafe repository path: ${String(value)}`,
    );
  }

  const normalized = value.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (normalized === ".") return ".";
  if (normalized.length === 0 && /^(?:\.?\/)+$/.test(value)) return ".";
  if (
    normalized.length === 0 ||
    normalized
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new WorkerFinalizationError(
      "WRITE_SCOPE_INVALID",
      `Write Scope contains an unsafe repository path: ${value}`,
    );
  }
  return normalized;
}

export function writeScopePaths(scope: WriteScope | undefined): readonly string[] {
  if (scope === undefined) return [];
  let paths: readonly unknown[];
  if (Array.isArray(scope)) {
    paths = scope;
  } else if (!("paths" in scope) || scope.paths === undefined) {
    paths = [];
  } else if (Array.isArray(scope.paths)) {
    paths = scope.paths;
  } else {
    throw new WorkerFinalizationError("WRITE_SCOPE_INVALID", "Write Scope paths must be an array");
  }
  const normalized = [...new Set(paths.map(normalizedScopePath))];
  normalized.sort();
  return normalized;
}

function pathInWriteScope(path: string, scope: readonly string[]): boolean {
  return scope.some(
    (allowed) => allowed === "." || path === allowed || path.startsWith(`${allowed}/`),
  );
}

function requestWriteScope(request: AgentExecutionRequestV1): readonly string[] {
  return writeScopePaths(
    request.permissions.repositoryTargets.map((target) => {
      if (typeof target !== "string") {
        throw new WorkerFinalizationError(
          "WRITE_SCOPE_INVALID",
          "Worker repositoryTargets must contain repository paths",
        );
      }
      return target;
    }),
  );
}

function effectiveWriteScope(
  writeScope: WriteScope | undefined,
  request: AgentExecutionRequestV1,
): readonly string[] {
  const permissionScope = requestWriteScope(request);
  const scope = writeScopePaths(writeScope ?? permissionScope);
  if (writeScope !== undefined) {
    const expanded = scope.filter((path) => !pathInWriteScope(path, permissionScope));
    if (expanded.length > 0) {
      throw new WorkerFinalizationError(
        "WRITE_SCOPE_INVALID",
        `Write Scope exceeds repositoryTargets: ${expanded.join(", ")}`,
      );
    }
  }
  return scope;
}

/** Validates the Worker role, authority, permissions, and Write Scope boundary. */
export function validateWorkerExecutionRequest(
  request: AgentExecutionRequestV1,
): AgentExecutionRequestV1 {
  let validated: AgentExecutionRequestV1;
  try {
    validated = validateAgentExecutionRequest(request);
  } catch (error) {
    if (error instanceof AgentPermissionError && error.code === "GIT_WRITE_DENIED") {
      throw new WorkerFinalizationError("GIT_WRITE_DENIED", error.message);
    }
    if (
      error instanceof AgentPermissionError &&
      (error.code === "PATH_TRAVERSAL" || error.code === "WRITE_SCOPE_INVALID")
    ) {
      throw new WorkerFinalizationError("WRITE_SCOPE_INVALID", error.message);
    }
    throw new WorkerFinalizationError(
      "WORKER_REQUEST_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (validated.identity.agentId !== "worker" || validated.execution.mode !== "write") {
    throw new WorkerFinalizationError(
      "WORKER_REQUEST_INVALID",
      "Worker execution requires agentId=worker and execution.mode=write",
    );
  }
  if (!(validated.authority.maximumDLevel === "D0" || validated.authority.maximumDLevel === "D1")) {
    throw new WorkerFinalizationError(
      "WORKER_REQUEST_INVALID",
      "Worker execution authority must be D0 or D1",
    );
  }
  assertWorkerGitWriteDenied(validated);
  requestWriteScope(validated);
  return validated;
}

function statusSignature(entry: RepositoryStatusEntry | undefined): string {
  return entry === undefined
    ? ""
    : `${entry.index}${entry.worktree}\u0000${entry.originalPath ?? ""}`;
}

function statusMap(snapshot: RepositorySnapshot): ReadonlyMap<string, RepositoryStatusEntry> {
  return new Map(snapshot.status.entries.map((entry) => [entry.path, entry]));
}

function preExistingPaths(snapshot: RepositorySnapshot): readonly string[] {
  const paths = new Set<string>();
  for (const entry of snapshot.status.entries) {
    paths.add(entry.path);
    if (entry.originalPath !== undefined) paths.add(entry.originalPath);
  }
  const sorted = [...paths];
  sorted.sort();
  return sorted;
}

function fingerprint(snapshot: RepositorySnapshot, path: string): string | null | undefined {
  return Object.hasOwn(snapshot.fingerprints, path) ? snapshot.fingerprints[path] : undefined;
}

function samePathState(
  before: RepositorySnapshot,
  after: RepositorySnapshot,
  beforeStatuses: ReadonlyMap<string, RepositoryStatusEntry>,
  afterStatuses: ReadonlyMap<string, RepositoryStatusEntry>,
  path: string,
): boolean {
  return (
    fingerprint(before, path) === fingerprint(after, path) &&
    statusSignature(beforeStatuses.get(path)) === statusSignature(afterStatuses.get(path))
  );
}

function indexStatus(entry: RepositoryStatusEntry | undefined): string {
  return entry?.index ?? " ";
}

function stagedIndexStatus(value: string): boolean {
  return value !== " " && value !== "?";
}

function gitWriteDetected(diff: RepositoryDiff): boolean {
  return (
    diff.headChanged ||
    diff.branchChanged ||
    diff.files.some(({ beforeStatus, afterStatus }) => {
      const before = indexStatus(beforeStatus);
      const after = indexStatus(afterStatus);
      return before !== after && (stagedIndexStatus(before) || stagedIndexStatus(after));
    })
  );
}

export function observeWorkerMutation(
  before: RepositorySnapshot,
  after: RepositorySnapshot,
  diff: RepositoryDiff,
  writeScope: WriteScope | undefined,
): WorkerMutationObservation {
  const scope = writeScopePaths(writeScope);
  const preExisting = preExistingPaths(before);
  const preExistingSet = new Set(preExisting);
  const beforeStatuses = statusMap(before);
  const afterStatuses = statusMap(after);
  const files = diff.files.map((file) => ({
    ...file,
    attribution: preExistingSet.has(file.path)
      ? ("uncertain" as const)
      : ("workflow-attributed" as const),
  }));
  const preExistingChanged = preExisting.filter(
    (path) => !samePathState(before, after, beforeStatuses, afterStatuses, path),
  );
  const preservedPreExisting = preExisting.filter((path) =>
    samePathState(before, after, beforeStatuses, afterStatuses, path),
  );
  const uncertain = files
    .filter(({ attribution }) => attribution === "uncertain")
    .map(({ path }) => path);
  const outOfScope = diff.files
    .filter(({ path }) => !pathInWriteScope(path, scope))
    .map(({ path }) => path);

  return {
    changed: diff.files.length > 0 || diff.headChanged || diff.branchChanged,
    files,
    changedFiles: diff.changedFiles,
    workflowAttributedFiles: files
      .filter(({ attribution }) => attribution === "workflow-attributed")
      .map(({ path }) => path),
    preExistingFiles: preExisting,
    preExistingChangedFiles: preExistingChanged,
    preservedPreExistingFiles: preservedPreExisting,
    uncertainFiles: uncertain,
    outOfScopeFiles: outOfScope,
    writeScope: scope,
    attributionUncertain: uncertain.length > 0,
    preExistingChangeLost: preExistingChanged.length > 0,
    gitWriteDetected: gitWriteDetected(diff),
  };
}

function agentVersionNumber(version: string): number {
  const match = /^(\d+)(?:\.\d+){0,2}(?:[-+].*)?$/.exec(version.trim());
  const value = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WorkerFinalizationError(
      "WORKER_REQUEST_INVALID",
      `Worker Agent version must start with a positive numeric version: ${version}`,
    );
  }
  return value;
}

function workerResult(value: unknown, request: AgentExecutionRequestV1): StepResultV1 {
  try {
    const result = StepResultV1Schema.parse(value);
    if (
      result.identity.runId !== request.identity.runId ||
      result.identity.stepId !== request.identity.stepId ||
      result.identity.executionId !== request.identity.executionId
    ) {
      throw new WorkerFinalizationError(
        "RESULT_INVALID",
        "Worker result identity does not match the Execution Request",
      );
    }
    if (result.mode !== undefined && result.mode !== request.execution.mode) {
      throw new WorkerFinalizationError(
        "RESULT_INVALID",
        "Worker result mode cannot widen the Execution permissions",
      );
    }
    return result;
  } catch (error) {
    if (error instanceof WorkerFinalizationError) throw error;
    throw new WorkerFinalizationError(
      "RESULT_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function resultObjects(
  result: StepResultV1 | null,
  field: "plan_deviations" | "execution_checks" | "observations",
): readonly JsonObject[] {
  return result?.[field] ?? [];
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

function violation(
  code: WorkerFinalizationViolationCode,
  paths: readonly string[],
  message: string,
): WorkerFinalizationViolation {
  return { code, paths, message };
}

function violations(
  observation: WorkerMutationObservation,
): readonly WorkerFinalizationViolation[] {
  const result: WorkerFinalizationViolation[] = [];
  if (observation.outOfScopeFiles.length > 0) {
    result.push(
      violation(
        "WRITE_SCOPE_VIOLATION",
        observation.outOfScopeFiles,
        "Worker changed files outside the approved Write Scope",
      ),
    );
  }
  if (observation.preExistingChangeLost) {
    result.push(
      violation(
        "PREEXISTING_CHANGE_LOST",
        observation.preExistingChangedFiles,
        "Worker changed or removed pre-existing repository changes",
      ),
    );
  }
  if (observation.gitWriteDetected) {
    result.push(
      violation(
        "GIT_WRITE_DENIED",
        [],
        "Worker changed Git control-plane state; Git write operations are denied",
      ),
    );
  }
  return result;
}

function artifactContents(
  request: AgentExecutionRequestV1,
  result: StepResultV1 | null,
  changeSet: ChangeSet,
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
    agent: {
      id: request.identity.agentId,
      version: agentVersionNumber(request.identity.agentVersion),
    },
    artifact: { type: "implementation", status: changeSet.status },
    created_at: createdAt,
    skills: [...request.skills.required, ...request.skills.optional],
    change_set_id: changeSet.id,
  });
  const payload: JsonObject = {
    change_set_id: changeSet.id,
    basis: {
      objective: request.objective,
      retry_attempt: request.retry.attempt,
      run_id: request.identity.runId,
      step_id: request.identity.stepId,
      execution_id: request.identity.executionId,
    },
    status: changeSet.status,
    changed: changeSet.changed,
    accepted: changeSet.accepted,
    outcome: result?.outcome ?? null,
    summary: changeSet.summary,
    intent: changeSet.intent,
    write_scope: changeSet.observation.writeScope,
    files: changeSet.observation.files,
    attribution: {
      workflow_attributed: changeSet.observation.workflowAttributedFiles,
      pre_existing: changeSet.observation.preExistingFiles,
      pre_existing_changed: changeSet.observation.preExistingChangedFiles,
      preserved_pre_existing: changeSet.observation.preservedPreExistingFiles,
      uncertain: changeSet.observation.uncertainFiles,
    },
    violations: changeSet.violations,
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
    `Worker outcome: ${changeSet.outcome ?? "no-result"}`,
    `Status: ${changeSet.status}; changed: ${String(changeSet.changed)}; accepted: ${String(changeSet.accepted)}`,
    changeSet.summary,
    "",
    "## Runtime Observation",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    "",
  ].join("\n");
}

export class WorkerFinalizer {
  private readonly artifactStore: ArtifactStore;
  private readonly repository: RepositoryAdapter | undefined;
  private readonly idAllocator: IdAllocator;
  private readonly now: () => Date;

  constructor(options: WorkerFinalizerOptions) {
    this.artifactStore = options.artifactStore;
    this.repository = options.repository;
    this.idAllocator = options.idAllocator ?? createIdAllocator();
    this.now = options.now ?? (() => new Date());
  }

  async finalize(input: WorkerFinalizerInput): Promise<WorkerFinalization> {
    const request = validateWorkerExecutionRequest(input.request);
    const result = input.result === null ? null : workerResult(input.result, request);
    const revision = validRevision(input.executionStateRevision);
    const diff =
      input.diff ??
      (this.repository === undefined
        ? (() => {
            throw new WorkerFinalizationError(
              "RESULT_INVALID",
              "Worker finalization requires a RepositoryDiff or RepositoryAdapter",
            );
          })()
        : await this.repository.diff(input.before, input.after));
    const scope = effectiveWriteScope(input.writeScope, request);
    const observation = observeWorkerMutation(input.before, input.after, diff, scope);
    const finalizationViolations = violations(observation);
    const accepted =
      result?.outcome === "completed" &&
      finalizationViolations.length === 0 &&
      !observation.attributionUncertain;
    const changeSet: ChangeSet = {
      id: this.idAllocator.issueChangeSetId(),
      runId: request.identity.runId,
      stepId: request.identity.stepId,
      executionId: request.identity.executionId,
      status: accepted ? "complete" : "partial",
      changed: observation.changed,
      accepted,
      outcome: result?.outcome ?? null,
      summary: result?.summary ?? "Worker execution produced no result",
      observation,
      violations: finalizationViolations,
      intent: {
        artifacts: result?.artifacts ?? [],
        planDeviations: resultObjects(result, "plan_deviations"),
        executionChecks: resultObjects(result, "execution_checks"),
        observations: resultObjects(result, "observations"),
      },
    };
    const createdAt = this.now();
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
      throw new WorkerFinalizationError("RESULT_INVALID", "now must return a valid Date");
    }
    const contents = artifactContents(
      request,
      result,
      changeSet,
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
      `implementation/change-set-${changeSet.id}.md`,
    );
    return { changeSet, artifact, contents, observation, diff };
  }
}

export type WorkerExecutionDependencies = Readonly<{
  agentRuntime: AgentRuntime;
  telemetryLevel?: TelemetryLevel;
  repository: RepositoryAdapter;
  finalizer: Pick<WorkerFinalizer, "finalize">;
}>;

export type WorkerExecutionInput = Readonly<{
  request: AgentExecutionRequestV1;
  writeScope?: WriteScope;
  executionStateRevision: number;
  signal?: AbortSignal;
}>;

export type WorkerExecutionResult = Readonly<{
  result: StepResultV1;
  before: RepositorySnapshot;
  after: RepositorySnapshot;
  diff: RepositoryDiff;
  finalization: WorkerFinalization;
}>;

/** Executes one Worker between full repository snapshots and finalizes its Change Set. */
export class WorkerExecutor {
  private readonly agentRuntime: AgentRuntime;
  private readonly interruptedExecutionRecovery: InterruptedExecutionRecovery;

  constructor(private readonly dependencies: WorkerExecutionDependencies) {
    this.agentRuntime = new TelemetryAgentRuntime(
      dependencies.agentRuntime,
      dependencies.telemetryLevel === undefined ? {} : { level: dependencies.telemetryLevel },
    );
    this.interruptedExecutionRecovery = new InterruptedExecutionRecovery({
      repository: dependencies.repository,
      workerFinalizer: dependencies.finalizer,
    });
  }

  async run(input: WorkerExecutionInput): Promise<WorkerExecutionResult> {
    const request = validateWorkerExecutionRequest(input.request);
    const scope = effectiveWriteScope(input.writeScope, request);
    validRevision(input.executionStateRevision);
    const before = await this.dependencies.repository.captureSnapshot();
    let rawResult: unknown;
    try {
      rawResult = await this.agentRuntime.run(request, input.signal);
    } catch (error) {
      const recovery = await this.interruptedExecutionRecovery.recover({
        request,
        before,
        executionStateRevision: input.executionStateRevision,
        writeScope: scope,
      });
      throw new WorkerExecutionInterruptedError(recovery, error);
    }
    const result = workerResult(rawResult, request);
    const after = await this.dependencies.repository.captureSnapshot();
    const diff = await this.dependencies.repository.diff(before, after);
    const finalization = await this.dependencies.finalizer.finalize({
      request,
      result,
      before,
      after,
      diff,
      writeScope: scope,
      executionStateRevision: input.executionStateRevision,
    });
    return { result, before, after, diff, finalization };
  }
}

export { WorkerFinalizer as ChangeSetFinalizer, WorkerExecutor as WorkerExecution };
