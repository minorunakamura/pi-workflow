import { stringify as stringifyYaml } from "yaml";
import {
  AgentExecutionRequestV1Schema,
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
import {
  FINDING_CONFIDENCES,
  FINDING_DISPOSITIONS,
  FINDING_STATES,
  FINDING_SEVERITIES,
  createFinding,
  reopenFinding,
  transitionFinding,
  type Finding,
  type FindingConfidence,
  type FindingDisposition,
  type FindingSeverity,
  type FindingState,
} from "../../domain/findings/finding.js";
import type {
  FindingId,
  ExecutionId,
  IdAllocator,
  ReviewRunId,
  RunId,
  StepId,
} from "../../domain/primitives/ids.js";
import { createIdAllocator } from "../../domain/primitives/ids.js";
import type { NormalizedCandidate } from "../normalization/result-normalizer.js";
import type { AgentRuntime } from "../../ports/agent-runtime.js";
import type { ArtifactRef, ArtifactStore } from "../../ports/artifact-store.js";
import type {
  RepositoryAdapter,
  RepositoryDiff,
  RepositorySnapshot,
} from "../../ports/repository.js";
import type { WorkflowState } from "../../ports/run-reader.js";

export const REVIEW_KINDS = ["change", "investigation"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_RESULTS = ["clean", "findings", "incomplete"] as const;
export type ReviewResult = (typeof REVIEW_RESULTS)[number];

export type ReviewerRepositoryObservation = Readonly<{
  mutated: boolean;
  changedFiles: readonly string[];
  headChanged: boolean;
  branchChanged: boolean;
  statusChanged: boolean;
  fingerprintChanged: boolean;
}>;

export type NormalizedReviewerRecheck = Readonly<{
  id: FindingId;
  state: FindingState;
  disposition: FindingDisposition;
}> &
  JsonObject;

export type ReviewRun = Readonly<{
  id: ReviewRunId;
  runId: RunId;
  stepId: StepId;
  executionId: ExecutionId;
  status: ArtifactStatus;
  result: ReviewResult;
  kind: ReviewKind;
  basis: JsonObject;
  findings: readonly NormalizedCandidate<FindingId>[];
  rechecks: readonly NormalizedReviewerRecheck[];
  repository: ReviewerRepositoryObservation;
}>;

export type ReviewerFinalizerInput = Readonly<{
  request: AgentExecutionRequestV1;
  result: StepResultV1;
  before: RepositorySnapshot;
  after: RepositorySnapshot;
  diff?: RepositoryDiff;
  executionStateRevision: number;
  kind?: ReviewKind;
  basis?: JsonObject;
  findings?: readonly Finding[];
  state?: WorkflowState;
}>;

export type ReviewerFinalization = Readonly<{
  reviewRun: ReviewRun;
  artifact: ArtifactRef;
  contents: string;
  findings: readonly NormalizedCandidate<FindingId>[];
  rechecks: readonly NormalizedReviewerRecheck[];
  diff: RepositoryDiff;
}>;

export type ReviewerFinalizerOptions = Readonly<{
  artifactStore: ArtifactStore;
  repository?: RepositoryAdapter;
  idAllocator?: IdAllocator;
  now?: () => Date;
}>;

export type ReviewerFinalizationErrorCode =
  | "REVIEWER_REQUEST_INVALID"
  | "RESULT_INVALID"
  | "FINDING_INVALID"
  | "RECHECK_INVALID"
  | "BASIS_INVALID";

export class ReviewerFinalizationError extends Error {
  constructor(
    readonly code: ReviewerFinalizationErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ReviewerFinalizationError";
  }
}

const READ_ONLY_WRITE_PATTERN =
  /(?:^|[-_\s])(write|edit|delete|remove|commit|push|merge|rebase|reset|restore|clean|branch|checkout|switch|cherry-pick|revert|tag|stash)(?:$|[-_\s])/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsWritePermission(value: unknown): string | undefined {
  if (typeof value === "string") {
    return READ_ONLY_WRITE_PATTERN.test(value) ? value : undefined;
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

/** Reviewer executions are read-only and cannot grant source or Git writes. */
export function validateReviewerExecutionRequest(
  request: AgentExecutionRequestV1,
): AgentExecutionRequestV1 {
  let validated: AgentExecutionRequestV1;
  try {
    validated = AgentExecutionRequestV1Schema.parse(request);
  } catch (error) {
    throw new ReviewerFinalizationError(
      "REVIEWER_REQUEST_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (validated.identity.agentId !== "reviewer" || validated.execution.mode !== "read-only") {
    throw new ReviewerFinalizationError(
      "REVIEWER_REQUEST_INVALID",
      "Reviewer execution requires agentId=reviewer and execution.mode=read-only",
    );
  }
  if (validated.authority.maximumDLevel !== "D0") {
    throw new ReviewerFinalizationError(
      "REVIEWER_REQUEST_INVALID",
      "Reviewer execution authority must be D0",
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
      throw new ReviewerFinalizationError(
        "REVIEWER_REQUEST_INVALID",
        `${source} grants a write operation: ${found}`,
      );
    }
  }
  return validated;
}

function reviewerResult(value: unknown, request: AgentExecutionRequestV1): StepResultV1 {
  try {
    const result = StepResultV1Schema.parse(value);
    if (
      result.identity.runId !== request.identity.runId ||
      result.identity.stepId !== request.identity.stepId ||
      result.identity.executionId !== request.identity.executionId
    ) {
      throw new ReviewerFinalizationError(
        "RESULT_INVALID",
        "Reviewer result identity does not match the Execution Request",
      );
    }
    if (result.mode !== undefined && result.mode !== request.execution.mode) {
      throw new ReviewerFinalizationError(
        "RESULT_INVALID",
        "Reviewer result mode cannot widen the Execution permissions",
      );
    }
    return result;
  } catch (error) {
    if (error instanceof ReviewerFinalizationError) throw error;
    throw new ReviewerFinalizationError(
      "RESULT_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function validRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReviewerFinalizationError(
      "RESULT_INVALID",
      "executionStateRevision must be a non-negative safe integer",
    );
  }
  return value;
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

function repositoryObservation(diff: RepositoryDiff): ReviewerRepositoryObservation {
  return {
    mutated: diff.files.length > 0 || diff.headChanged || diff.branchChanged,
    changedFiles: diff.changedFiles,
    headChanged: diff.headChanged,
    branchChanged: diff.branchChanged,
    statusChanged: diff.statusChanged,
    fingerprintChanged: diff.fingerprintChanged,
  };
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
  throw new ReviewerFinalizationError("BASIS_INVALID", `${path} must be a JSON value`);
}

function jsonObject(value: unknown, path: string): JsonObject {
  if (!isRecord(value)) {
    throw new ReviewerFinalizationError("BASIS_INVALID", `${path} must be an object`);
  }
  Object.entries(value).forEach(([key, entry]) => jsonValue(entry, `${path}.${key}`));
  return value as JsonObject;
}

function kindFor(request: AgentExecutionRequestV1, kind: ReviewKind | undefined): ReviewKind {
  const value = kind ?? (request.objective.type === "investigation" ? "investigation" : "change");
  if (!(REVIEW_KINDS as readonly string[]).includes(value)) {
    throw new ReviewerFinalizationError("RESULT_INVALID", `Unsupported Review kind: ${value}`);
  }
  return value;
}

function findingError(message: string): never {
  throw new ReviewerFinalizationError("FINDING_INVALID", message);
}

function recheckError(message: string): never {
  throw new ReviewerFinalizationError("RECHECK_INVALID", message);
}

function findingValue<T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    findingError(`${path} must be one of ${values.join(", ")}`);
  }
  return value as T[number];
}

function normalizeExistingFinding(value: Finding, index: number): Finding {
  try {
    if (typeof value.id !== "string" || !/^F-\d+$/.test(value.id)) {
      findingError(`findings[${index}].id must be an F-<number> identity`);
    }
    return createFinding({
      id: value.id,
      state: value.state,
      disposition: value.disposition,
      severity: value.severity,
      confidence: value.confidence,
    });
  } catch (error) {
    if (error instanceof ReviewerFinalizationError) throw error;
    return findingError(error instanceof Error ? error.message : String(error));
  }
}

function normalizeFindingCandidates(
  result: StepResultV1,
  allocator: IdAllocator,
  used: Set<string>,
): readonly NormalizedCandidate<FindingId>[] {
  return result.finding_candidates.map((candidate, index) => {
    if (Object.hasOwn(candidate, "id")) {
      findingError(`finding_candidates[${index}] must not contain an authoritative identity`);
    }
    if (Object.hasOwn(candidate, "state") || Object.hasOwn(candidate, "disposition")) {
      findingError(
        `finding_candidates[${index}] must not choose a final Finding state or disposition`,
      );
    }
    const severity = findingValue(
      candidate.severity,
      FINDING_SEVERITIES,
      `finding_candidates[${index}].severity`,
    );
    const confidence = findingValue(
      candidate.confidence,
      FINDING_CONFIDENCES,
      `finding_candidates[${index}].confidence`,
    );
    let id: FindingId;
    for (;;) {
      id = allocator.issueFindingId();
      if (!used.has(id)) break;
    }
    used.add(id);
    createFinding({
      id,
      severity: severity as FindingSeverity,
      confidence: confidence as FindingConfidence,
    });
    return { ...candidate, id };
  });
}

function recheckReference(candidate: Record<string, JsonValue>, index: number): FindingId {
  const keys = ["findingId", "finding_id"].filter((key) => Object.hasOwn(candidate, key));
  if (keys.length !== 1) {
    recheckError(
      `finding_rechecks[${index}] must contain exactly one findingId or finding_id reference`,
    );
  }
  const reference = candidate[keys[0]!];
  if (typeof reference !== "string" || !/^F-\d+$/.test(reference)) {
    recheckError(`finding_rechecks[${index}] must reference an F-<number> Finding`);
  }
  return reference as FindingId;
}

type RecheckAction = "fix" | "dismiss" | "reopen";

function actionValue(value: unknown, index: number): RecheckAction | undefined {
  if (value === undefined) return undefined;
  if (value === "fix" || value === "fixed") return "fix";
  if (value === "dismiss" || value === "dismissed") return "dismiss";
  if (value === "reopen" || value === "reopened") return "reopen";
  return recheckError(`finding_rechecks[${index}].action must be fix, dismiss, or reopen`);
}

function recheckTransition(
  finding: Finding,
  candidate: Record<string, JsonValue>,
  index: number,
): Finding {
  const action = actionValue(candidate.action, index);
  const disposition =
    candidate.disposition === undefined
      ? undefined
      : findingValue(
          candidate.disposition,
          FINDING_DISPOSITIONS,
          `finding_rechecks[${index}].disposition`,
        );
  const state =
    candidate.state === undefined
      ? undefined
      : findingValue(candidate.state, FINDING_STATES, `finding_rechecks[${index}].state`);

  if (action === "fix") {
    if (state !== undefined && state !== "resolved") {
      recheckError(`finding_rechecks[${index}] fix action must use resolved state`);
    }
    if (disposition !== undefined && disposition !== "fixed") {
      recheckError(`finding_rechecks[${index}] fix action must use fixed disposition`);
    }
    return transitionFinding(finding, "fixed");
  }
  if (action === "dismiss") {
    if (state !== undefined && state !== "resolved") {
      recheckError(`finding_rechecks[${index}] dismiss action must use resolved state`);
    }
    if (disposition !== undefined && disposition !== "dismissed") {
      recheckError(`finding_rechecks[${index}] dismiss action must use dismissed disposition`);
    }
    return transitionFinding(finding, "dismissed");
  }
  if (action === "reopen") {
    if (state !== undefined && state !== "open") {
      recheckError(`finding_rechecks[${index}] reopen action must use open state`);
    }
    if (
      disposition !== undefined &&
      !["pending", "fix-required", "accepted"].includes(disposition)
    ) {
      recheckError(`finding_rechecks[${index}] reopen action must use an open disposition`);
    }
    return reopenFinding(
      finding,
      (disposition as "pending" | "fix-required" | "accepted" | undefined) ?? "pending",
    );
  }

  if (state !== undefined && disposition !== undefined) {
    return transitionFinding(finding, state, disposition);
  }
  if (disposition !== undefined) {
    return transitionFinding(finding, disposition);
  }
  if (state !== undefined) {
    return transitionFinding(finding, state);
  }
  return recheckError(`finding_rechecks[${index}] must specify action, state, or disposition`);
}

function normalizeFindingRechecks(
  result: StepResultV1,
  existing: readonly Finding[],
): readonly NormalizedReviewerRecheck[] {
  const current = new Map(existing.map((finding) => [finding.id, finding]));
  return result.finding_rechecks.map((candidate, index) => {
    const id = recheckReference(candidate, index);
    const finding = current.get(id);
    if (finding === undefined) {
      recheckError(`Unknown Finding reference: ${id}`);
    }
    const next = recheckTransition(finding, candidate, index);
    current.set(id, next);
    return {
      ...candidate,
      id,
      state: next.state,
      disposition: next.disposition,
    };
  });
}

function artifactContents(
  request: AgentExecutionRequestV1,
  reviewRun: ReviewRun,
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
    artifact: { type: "review", status: reviewRun.status },
    created_at: createdAt,
    skills: [...request.skills.required, ...request.skills.optional],
    review_run_id: reviewRun.id,
  });
  const payload: JsonObject = {
    review_run_id: reviewRun.id,
    kind: reviewRun.kind,
    result: reviewRun.result,
    status: reviewRun.status,
    basis: reviewRun.basis,
    findings: reviewRun.findings,
    rechecks: reviewRun.rechecks,
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
    `Review result: ${reviewRun.result}`,
    `Kind: ${reviewRun.kind}; status: ${reviewRun.status}`,
    "",
    "## Review Run",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    "",
  ].join("\n");
}

export class ReviewerFinalizer {
  private readonly artifactStore: ArtifactStore;
  private readonly repository: RepositoryAdapter | undefined;
  private readonly idAllocator: IdAllocator;
  private readonly now: () => Date;

  constructor(options: ReviewerFinalizerOptions) {
    this.artifactStore = options.artifactStore;
    this.repository = options.repository;
    this.idAllocator = options.idAllocator ?? createIdAllocator();
    this.now = options.now ?? (() => new Date());
  }

  async finalize(input: ReviewerFinalizerInput): Promise<ReviewerFinalization> {
    const request = validateReviewerExecutionRequest(input.request);
    const result = reviewerResult(input.result, request);
    const revision = validRevision(input.executionStateRevision);
    const diff =
      input.diff ??
      (this.repository === undefined
        ? (() => {
            throw new ReviewerFinalizationError(
              "RESULT_INVALID",
              "Review finalization requires a RepositoryDiff or RepositoryAdapter",
            );
          })()
        : await this.repository.diff(input.before, input.after));
    const observation = repositoryObservation(diff);
    const existing = (input.findings ?? input.state?.snapshot.findings.findings ?? []).map(
      normalizeExistingFinding,
    );
    const used = new Set(existing.map(({ id }) => id));
    const findings = normalizeFindingCandidates(result, this.idAllocator, used);
    const rechecks = normalizeFindingRechecks(result, existing);
    const status: ArtifactStatus =
      result.outcome === "completed" && !observation.mutated ? "complete" : "partial";
    const reviewResult: ReviewResult =
      status === "partial"
        ? "incomplete"
        : findings.length > 0 || rechecks.length > 0
          ? "findings"
          : "clean";
    const reviewRun: ReviewRun = {
      id: this.idAllocator.issueReviewRunId(),
      runId: request.identity.runId,
      stepId: request.identity.stepId,
      executionId: request.identity.executionId,
      status,
      result: reviewResult,
      kind: kindFor(request, input.kind),
      basis:
        input.basis === undefined
          ? { repository: snapshotSummary(input.before) }
          : jsonObject(input.basis, "basis"),
      findings,
      rechecks,
      repository: observation,
    };
    const createdAt = this.now();
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
      throw new ReviewerFinalizationError("RESULT_INVALID", "now must return a valid Date");
    }
    const contents = artifactContents(
      request,
      reviewRun,
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
    const artifact = await this.artifactStore.finalize(staged, `reviews/${reviewRun.id}.md`);
    return { reviewRun, artifact, contents, findings, rechecks, diff };
  }
}

export type ReviewerExecutionDependencies = Readonly<{
  agentRuntime: AgentRuntime;
  repository: RepositoryAdapter;
  finalizer: Pick<ReviewerFinalizer, "finalize">;
}>;

export type ReviewerExecutionInput = Readonly<{
  request: AgentExecutionRequestV1;
  executionStateRevision: number;
  kind?: ReviewKind;
  basis?: JsonObject;
  findings?: readonly Finding[];
  state?: WorkflowState;
}>;

export type ReviewerExecutionResult = Readonly<{
  result: StepResultV1;
  before: RepositorySnapshot;
  after: RepositorySnapshot;
  diff: RepositoryDiff;
  finalization: ReviewerFinalization;
}>;

/** Executes one read-only Reviewer between repository snapshots. */
export class ReviewerExecutor {
  constructor(private readonly dependencies: ReviewerExecutionDependencies) {}

  async run(input: ReviewerExecutionInput): Promise<ReviewerExecutionResult> {
    const request = validateReviewerExecutionRequest(input.request);
    validRevision(input.executionStateRevision);
    const before = await this.dependencies.repository.captureSnapshot();
    const result = reviewerResult(await this.dependencies.agentRuntime.run(request), request);
    const after = await this.dependencies.repository.captureSnapshot();
    const diff = await this.dependencies.repository.diff(before, after);
    const finalization = await this.dependencies.finalizer.finalize({
      request,
      result,
      before,
      after,
      diff,
      executionStateRevision: input.executionStateRevision,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.basis === undefined ? {} : { basis: input.basis }),
      ...(input.findings === undefined ? {} : { findings: input.findings }),
      ...(input.state === undefined ? {} : { state: input.state }),
    });
    return { result, before, after, diff, finalization };
  }
}

export { ReviewerFinalizer as ReviewRunFinalizer, ReviewerExecutor as ReviewerExecution };
