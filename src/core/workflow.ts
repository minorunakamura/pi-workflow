import { randomUUID } from "node:crypto";

import {
  hasOnlyKeys,
  invalidResult,
  isBoundedString,
  isNormalizedOpaqueId,
  isRecord,
  isSafeRelativePath,
  validResult,
  type ValidationResult,
} from "./validation.ts";

export const WORKFLOW_TYPES = ["feature", "bug", "chore", "hotfix"] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

export const WORKFLOW_COMMANDS = {
  "/wf-feature": "feature",
  "/wf-bug": "bug",
  "/wf-chore": "chore",
  "/wf-hotfix": "hotfix",
} as const satisfies Readonly<Record<`/wf-${string}`, WorkflowType>>;

export type WorkflowId = string & { readonly __workflowId: unique symbol };
export type RunId = string & { readonly __runId: unique symbol };
export type RequestId = string & { readonly __requestId: unique symbol };
export type ReviewId = string & { readonly __reviewId: unique symbol };
export type FindingId = string & { readonly __findingId: unique symbol };
export type PlanHashValue = string & { readonly __planHash: unique symbol };

export type WorkflowPhase =
  | "IDLE"
  | "PLANNING"
  | "PLAN_REVIEW"
  | "IMPLEMENTING"
  | "CODE_REVIEW"
  | "READY_FOR_MERGE"
  | "FAILED"
  | "CANCELLED";

export type WorkflowLifecycleState = "IDLE" | "ACTIVE" | "TERMINAL";

export type PlanningStatus =
  | "NOT_STARTED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type ImplementationStatus =
  | "NOT_STARTED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface WorkflowRequest {
  workflowId: WorkflowId;
  workflowType: WorkflowType;
  request: string;
  cwd: string;
  createdAt: string;
}

export type TddMode = "required" | "optional" | "not-applicable";

export interface TestStrategy {
  kind: "unit" | "integration" | "mixed" | "none";
  required: boolean;
  summary: string;
}

export interface PlanHash {
  algorithm: "SHA-256";
  encoding: "hex";
  value: PlanHashValue;
}

export type ArtifactMediaType =
  | "text/markdown"
  | "application/json"
  | "text/plain"
  | "text/x-diff";

export interface ArtifactRef {
  kind: "managed";
  path: string;
  mediaType: ArtifactMediaType;
}

export type ApprovalValue = boolean | null;

export interface PendingInteraction {
  kind: "human" | "plan-review" | "code-review";
  requestId: RequestId;
  coordinatorRunId: RunId;
  reviewId?: ReviewId;
}

export interface CodeReviewResultSummary {
  requestId: RequestId;
  status: "approved" | "rejected" | "unavailable" | "timeout" | "failed";
  approved: boolean;
  feedbackRef?: ArtifactRef;
  annotationsRef?: ArtifactRef;
}

export type CancellationStopStatus =
  | "not-requested"
  | "requested"
  | "failed"
  | "unknown";

export interface CancellationOutcome {
  coordinatorRunId?: RunId;
  stop: CancellationStopStatus;
}

export type RootDiagnosticKind = "conflict" | "cancellation" | "late-event";

export interface RootDiagnostic {
  kind: RootDiagnosticKind;
  code: string;
  requestId?: RequestId;
  runId?: RunId;
  reviewId?: ReviewId;
}

export interface RootWorkflowState {
  schemaVersion: 1;
  workflowId: WorkflowId;
  workflowType: WorkflowType;
  phase: WorkflowPhase;
  planResubmissionCount: number;
  codeReviewChangeCycleCount: number;
  planningRunId?: RunId;
  planningStatus: PlanningStatus;
  planningHandoffRef?: ArtifactRef;
  reviewId?: ReviewId;
  approvedPlanHash?: PlanHashValue;
  approval: ApprovalValue;
  approvalFeedback?: string;
  implementationRunId?: RunId;
  implementationStatus: ImplementationStatus;
  pendingInteraction?: PendingInteraction;
  codeReviewResult?: CodeReviewResultSummary;
  cancellationOutcome?: CancellationOutcome;
  diagnostics?: RootDiagnostic[];
  finalStatus: "NONE" | "READY_FOR_MERGE" | "FAILED" | "CANCELLED";
}

const UUID_BODY =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID_BODY}$`, "u");
const WORKFLOW_ID_PATTERN = new RegExp(`^wf-${UUID_BODY}$`, "u");
const PLAN_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_BOUNDED_TRANSITION_COUNT = 1;

function isBoundedTransitionCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_BOUNDED_TRANSITION_COUNT
  );
}

function isWorkflowCommand(
  value: string,
): value is keyof typeof WORKFLOW_COMMANDS {
  return Object.hasOwn(WORKFLOW_COMMANDS, value);
}

function isPendingInteractionKind(
  value: unknown,
): value is PendingInteraction["kind"] {
  return (
    value === "human" || value === "plan-review" || value === "code-review"
  );
}

function isCodeReviewStatus(
  value: unknown,
): value is CodeReviewResultSummary["status"] {
  return (
    value === "approved" ||
    value === "rejected" ||
    value === "unavailable" ||
    value === "timeout" ||
    value === "failed"
  );
}

function isApprovalValue(value: unknown): value is ApprovalValue {
  return value === null || typeof value === "boolean";
}

function isCancellationStopStatus(
  value: unknown,
): value is CancellationStopStatus {
  return (
    value === "not-requested" ||
    value === "requested" ||
    value === "failed" ||
    value === "unknown"
  );
}

function isRootDiagnosticKind(value: unknown): value is RootDiagnosticKind {
  return (
    value === "conflict" || value === "cancellation" || value === "late-event"
  );
}

function isFinalStatus(
  value: unknown,
): value is RootWorkflowState["finalStatus"] {
  return (
    value === "NONE" ||
    value === "READY_FOR_MERGE" ||
    value === "FAILED" ||
    value === "CANCELLED"
  );
}

export function isWorkflowType(value: unknown): value is WorkflowType {
  return (
    typeof value === "string" &&
    (WORKFLOW_TYPES as readonly string[]).includes(value)
  );
}

export function workflowTypeForCommand(
  command: string,
): WorkflowType | undefined {
  if (!isWorkflowCommand(command)) {
    return undefined;
  }
  return WORKFLOW_COMMANDS[command];
}

export function createWorkflowId(uuid = randomUUID()): WorkflowId {
  const normalized = uuid.trim();
  const value = `wf-${normalized}`;
  if (!isValidWorkflowId(value)) {
    throw new TypeError("Workflow ID requires a UUID");
  }
  return value;
}

export function createRequestId(uuid = randomUUID()): RequestId {
  const normalized = uuid.trim();
  if (!isValidRequestId(normalized)) {
    throw new TypeError("Request ID requires a UUID");
  }
  return normalized;
}

export function createRunId(value: string): RunId {
  const normalized = value.trim();
  if (!isValidRunId(normalized)) {
    throw new TypeError("Run ID must be a non-empty opaque ID");
  }
  return normalized;
}

export function createReviewId(value: string): ReviewId {
  const normalized = value.trim();
  if (!isValidReviewId(normalized)) {
    throw new TypeError("Review ID must be a non-empty opaque ID");
  }
  return normalized;
}

export function isValidWorkflowId(value: unknown): value is WorkflowId {
  return typeof value === "string" && WORKFLOW_ID_PATTERN.test(value);
}

export function isValidRunId(value: unknown): value is RunId {
  return isNormalizedOpaqueId(value);
}

export function isValidRequestId(value: unknown): value is RequestId {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isValidReviewId(value: unknown): value is ReviewId {
  return isNormalizedOpaqueId(value);
}

export function isValidPlanHashValue(value: unknown): value is PlanHashValue {
  return typeof value === "string" && PLAN_HASH_PATTERN.test(value);
}

export function isWorkflowPhase(value: unknown): value is WorkflowPhase {
  return (
    typeof value === "string" &&
    [
      "IDLE",
      "PLANNING",
      "PLAN_REVIEW",
      "IMPLEMENTING",
      "CODE_REVIEW",
      "READY_FOR_MERGE",
      "FAILED",
      "CANCELLED",
    ].includes(value)
  );
}

export function isPlanningStatus(value: unknown): value is PlanningStatus {
  return (
    typeof value === "string" &&
    ["NOT_STARTED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].includes(
      value,
    )
  );
}

export function isImplementationStatus(
  value: unknown,
): value is ImplementationStatus {
  return (
    typeof value === "string" &&
    ["NOT_STARTED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].includes(
      value,
    )
  );
}

export function isActivePhase(
  phase: unknown,
): phase is "PLANNING" | "PLAN_REVIEW" | "IMPLEMENTING" | "CODE_REVIEW" {
  return (
    phase === "PLANNING" ||
    phase === "PLAN_REVIEW" ||
    phase === "IMPLEMENTING" ||
    phase === "CODE_REVIEW"
  );
}

export function lifecycleStateForPhase(
  phase: unknown,
): WorkflowLifecycleState | undefined {
  if (!isWorkflowPhase(phase)) {
    return undefined;
  }
  if (phase === "IDLE") {
    return "IDLE";
  }
  return isActivePhase(phase) ? "ACTIVE" : "TERMINAL";
}

export function workflowTypeForCommandOrFail(command: string): WorkflowType {
  const workflowType = workflowTypeForCommand(command);
  if (workflowType === undefined) {
    throw new RangeError(`Unknown workflow command: ${command}`);
  }
  return workflowType;
}

export const CONCURRENCY_POLICY = Object.freeze({
  sameRootSession: "one-active" as const,
  crossSessionSupported: false,
  globalLock: false,
});

export function canStartWorkflow(
  existing:
    | Pick<RootWorkflowState, "phase">
    | { phase: unknown }
    | null
    | undefined,
): boolean {
  if (existing === null || existing === undefined) {
    return true;
  }
  if (!isWorkflowPhase(existing.phase)) {
    return false;
  }
  return !isActivePhase(existing.phase);
}

export const MAX_PLAN_RESUBMISSIONS = 1;
export const MAX_CODE_REVIEW_CHANGE_CYCLES = 1;
export const MAX_AUTOMATIC_FIX_WAVES = 1;

export function canResubmitPlan(resubmissionCount: number): boolean {
  return (
    Number.isInteger(resubmissionCount) &&
    resubmissionCount >= 0 &&
    resubmissionCount < MAX_PLAN_RESUBMISSIONS
  );
}

export function canStartCodeReviewChangeCycle(
  changeCycleCount: number,
): boolean {
  return (
    Number.isInteger(changeCycleCount) &&
    changeCycleCount >= 0 &&
    changeCycleCount < MAX_CODE_REVIEW_CHANGE_CYCLES
  );
}

export const TIMEOUTS = Object.freeze({
  rpcReadyTimeoutMs: 5_000,
  rpcReplyTimeoutMs: 30_000,
  coordinatorTimeoutMs: 43_200_000,
  humanDecisionTimeoutMs: 14_400_000,
  planReviewTimeoutMs: 14_400_000,
  codeReviewTimeoutMs: 14_400_000,
  gateTimeoutMs: 1_200_000,
});

export const TIMEOUT_POLICY = Object.freeze({
  coordinator: "wall-clock" as const,
  pauseWhileWaiting: false,
  failure: "FAILED" as const,
});

export const AUTOMATIC_RETRY_ENABLED = false;

function isRelativeArtifactPath(value: string): boolean {
  return isSafeRelativePath(value);
}

function isSafeArtifactPath(value: unknown): value is string {
  if (!isBoundedString(value, 4096, true) || /[\0\r\n]/u.test(value)) {
    return false;
  }
  const pathValue = value;
  if (isRelativeArtifactPath(pathValue)) return true;
  const absolute =
    pathValue.startsWith("/") ||
    pathValue.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/u.test(pathValue);
  return (
    absolute && pathValue.split(/[\\/]/u).every((segment) => segment !== "..")
  );
}

export function isValidArtifactRef(value: unknown): value is ArtifactRef {
  if (!isRecord(value) || !hasOnlyKeys(value, ["kind", "path", "mediaType"])) {
    return false;
  }
  return (
    value.kind === "managed" &&
    isSafeArtifactPath(value.path) &&
    (value.mediaType === "text/markdown" ||
      value.mediaType === "application/json" ||
      value.mediaType === "text/plain" ||
      value.mediaType === "text/x-diff")
  );
}

export function createInitialWorkflowState(
  workflowId: WorkflowId,
  workflowType: WorkflowType,
): RootWorkflowState {
  if (!isValidWorkflowId(workflowId) || !isWorkflowType(workflowType)) {
    throw new TypeError("Invalid workflow identity");
  }
  return {
    schemaVersion: 1,
    workflowId,
    workflowType,
    phase: "IDLE",
    planResubmissionCount: 0,
    codeReviewChangeCycleCount: 0,
    planningStatus: "NOT_STARTED",
    approval: null,
    implementationStatus: "NOT_STARTED",
    finalStatus: "NONE",
  };
}

const ROOT_STATE_KEYS = [
  "schemaVersion",
  "workflowId",
  "workflowType",
  "phase",
  "planResubmissionCount",
  "codeReviewChangeCycleCount",
  "planningRunId",
  "planningStatus",
  "planningHandoffRef",
  "reviewId",
  "approvedPlanHash",
  "approval",
  "approvalFeedback",
  "implementationRunId",
  "implementationStatus",
  "pendingInteraction",
  "codeReviewResult",
  "cancellationOutcome",
  "diagnostics",
  "finalStatus",
] as const;

function hasValidStateReferences(state: Record<string, unknown>): boolean {
  if ("planningRunId" in state && !isValidRunId(state.planningRunId)) {
    return false;
  }
  if (
    "planningHandoffRef" in state &&
    (!isValidArtifactRef(state.planningHandoffRef) ||
      state.planningHandoffRef.mediaType !== "application/json")
  ) {
    return false;
  }
  if ("reviewId" in state && !isValidReviewId(state.reviewId)) {
    return false;
  }
  if (
    "approvedPlanHash" in state &&
    !isValidPlanHashValue(state.approvedPlanHash)
  ) {
    return false;
  }
  if (
    "approvalFeedback" in state &&
    !isBoundedString(state.approvalFeedback, 16 * 1024)
  ) {
    return false;
  }
  if (
    "implementationRunId" in state &&
    !isValidRunId(state.implementationRunId)
  ) {
    return false;
  }
  return true;
}

function hasValidPendingInteraction(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["kind", "requestId", "coordinatorRunId", "reviewId"])
  ) {
    return false;
  }
  if (
    !isPendingInteractionKind(value.kind) ||
    !isValidRequestId(value.requestId) ||
    !isValidRunId(value.coordinatorRunId)
  ) {
    return false;
  }
  return !("reviewId" in value) || isValidReviewId(value.reviewId);
}

function hasValidCancellationOutcome(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["coordinatorRunId", "stop"]) &&
    isCancellationStopStatus(value.stop) &&
    (!("coordinatorRunId" in value) || isValidRunId(value.coordinatorRunId))
  );
}

export function validateCancellationOutcome(
  value: unknown,
): ValidationResult<CancellationOutcome> {
  if (!hasValidCancellationOutcome(value)) {
    return invalidResult("Cancellation outcome is invalid");
  }
  if (!isRecord(value) || !isCancellationStopStatus(value.stop)) {
    return invalidResult("Cancellation outcome is invalid");
  }
  return validResult({
    stop: value.stop,
    ...(isValidRunId(value.coordinatorRunId)
      ? { coordinatorRunId: value.coordinatorRunId }
      : {}),
  });
}

function hasValidDiagnostics(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 8) return false;
  return value.every((diagnostic) => {
    if (
      !isRecord(diagnostic) ||
      !hasOnlyKeys(diagnostic, [
        "kind",
        "code",
        "requestId",
        "runId",
        "reviewId",
      ]) ||
      !isRootDiagnosticKind(diagnostic.kind) ||
      !isBoundedString(diagnostic.code, 128, true) ||
      /[\0\r\n]/u.test(diagnostic.code)
    ) {
      return false;
    }
    return (
      (!("requestId" in diagnostic) ||
        isValidRequestId(diagnostic.requestId)) &&
      (!("runId" in diagnostic) || isValidRunId(diagnostic.runId)) &&
      (!("reviewId" in diagnostic) || isValidReviewId(diagnostic.reviewId))
    );
  });
}

export function validateRootDiagnostic(
  value: unknown,
): ValidationResult<RootDiagnostic> {
  if (
    !hasValidDiagnostics([value]) ||
    !isRecord(value) ||
    !isRootDiagnosticKind(value.kind) ||
    !isBoundedString(value.code, 128, true)
  ) {
    return invalidResult("Root diagnostic is invalid");
  }
  return validResult({
    kind: value.kind,
    code: value.code,
    ...(isValidRequestId(value.requestId)
      ? { requestId: value.requestId }
      : {}),
    ...(isValidRunId(value.runId) ? { runId: value.runId } : {}),
    ...(isValidReviewId(value.reviewId) ? { reviewId: value.reviewId } : {}),
  });
}

export function validateCodeReviewResultSummary(
  value: unknown,
): ValidationResult<CodeReviewResultSummary> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "requestId",
      "status",
      "approved",
      "feedbackRef",
      "annotationsRef",
    ]) ||
    !isValidRequestId(value.requestId) ||
    !isCodeReviewStatus(value.status) ||
    typeof value.approved !== "boolean" ||
    (value.status === "approved" && !value.approved) ||
    (value.status !== "approved" && value.approved) ||
    ("feedbackRef" in value && !isValidArtifactRef(value.feedbackRef)) ||
    ("annotationsRef" in value && !isValidArtifactRef(value.annotationsRef))
  ) {
    return invalidResult("Code Review result summary is invalid");
  }
  const feedbackRef = isValidArtifactRef(value.feedbackRef)
    ? value.feedbackRef
    : undefined;
  const annotationsRef = isValidArtifactRef(value.annotationsRef)
    ? value.annotationsRef
    : undefined;
  return validResult({
    requestId: value.requestId,
    status: value.status,
    approved: value.approved,
    ...(feedbackRef === undefined ? {} : { feedbackRef }),
    ...(annotationsRef === undefined ? {} : { annotationsRef }),
  });
}

export function isValidCodeReviewResultSummary(
  value: unknown,
): value is CodeReviewResultSummary {
  return validateCodeReviewResultSummary(value).valid;
}

function hasValidCodeReviewResult(value: unknown): boolean {
  return validateCodeReviewResultSummary(value).valid;
}

function hasValidRootWorkflowValues(
  state: unknown,
): state is RootWorkflowState {
  if (!isRecord(state)) {
    return false;
  }
  const pendingInteractionValid =
    !("pendingInteraction" in state) ||
    hasValidPendingInteraction(state.pendingInteraction);
  const codeReviewResultValid =
    !("codeReviewResult" in state) ||
    hasValidCodeReviewResult(state.codeReviewResult);
  const cancellationOutcomeValid =
    !("cancellationOutcome" in state) ||
    hasValidCancellationOutcome(state.cancellationOutcome);
  const diagnosticsValid =
    !("diagnostics" in state) || hasValidDiagnostics(state.diagnostics);
  const cancellationPhaseValid =
    !("cancellationOutcome" in state) || state.phase === "CANCELLED";
  return (
    state.schemaVersion === 1 &&
    isValidWorkflowId(state.workflowId) &&
    isWorkflowType(state.workflowType) &&
    isWorkflowPhase(state.phase) &&
    isBoundedTransitionCount(state.planResubmissionCount) &&
    isBoundedTransitionCount(state.codeReviewChangeCycleCount) &&
    isPlanningStatus(state.planningStatus) &&
    isImplementationStatus(state.implementationStatus) &&
    isApprovalValue(state.approval) &&
    isFinalStatus(state.finalStatus) &&
    hasValidStateReferences(state) &&
    pendingInteractionValid &&
    codeReviewResultValid &&
    cancellationOutcomeValid &&
    cancellationPhaseValid &&
    diagnosticsValid
  );
}

function hasValidPhaseStatuses(state: RootWorkflowState): boolean {
  switch (state.phase) {
    case "IDLE":
      return (
        state.planningStatus === "NOT_STARTED" &&
        state.implementationStatus === "NOT_STARTED" &&
        state.finalStatus === "NONE"
      );
    case "PLANNING":
      return (
        state.planningStatus === "RUNNING" &&
        state.implementationStatus === "NOT_STARTED" &&
        state.finalStatus === "NONE"
      );
    case "PLAN_REVIEW":
      return (
        (state.planningStatus === "RUNNING" ||
          state.planningStatus === "COMPLETED") &&
        state.implementationStatus === "NOT_STARTED" &&
        state.finalStatus === "NONE"
      );
    case "IMPLEMENTING":
      return (
        state.planningStatus === "COMPLETED" &&
        state.implementationStatus === "RUNNING" &&
        state.finalStatus === "NONE"
      );
    case "CODE_REVIEW":
      return (
        state.planningStatus === "COMPLETED" &&
        state.implementationStatus === "COMPLETED" &&
        state.finalStatus === "NONE"
      );
    case "READY_FOR_MERGE":
      return (
        state.planningStatus === "COMPLETED" &&
        state.implementationStatus === "COMPLETED" &&
        state.finalStatus === "READY_FOR_MERGE"
      );
    case "FAILED":
      return state.finalStatus === "FAILED";
    case "CANCELLED":
      return state.finalStatus === "CANCELLED";
    default:
      return false;
  }
}

export function validateRootWorkflowState(
  value: unknown,
): ValidationResult<RootWorkflowState> {
  if (!isRecord(value) || !hasOnlyKeys(value, ROOT_STATE_KEYS)) {
    return invalidResult("Root workflow state has unknown or missing fields");
  }
  if (!hasValidRootWorkflowValues(value)) {
    return invalidResult("Root workflow state contains an invalid value");
  }
  if (
    value.approval === true &&
    (!isValidReviewId(value.reviewId) ||
      !isValidPlanHashValue(value.approvedPlanHash))
  ) {
    return invalidResult("Approved state is missing its approval identity");
  }
  return hasValidPhaseStatuses(value)
    ? validResult(value)
    : invalidResult("Phase and status are inconsistent");
}

export interface PhaseTransitionOptions {
  kind?: "standard" | "plan-resubmission" | "code-review-change-cycle";
  resubmissionCount?: number;
  changeCycleCount?: number;
  sameCoordinator?: boolean;
  approvedScope?: boolean;
  newDecisionRequired?: boolean;
}

export type PhaseTransitionResult =
  | { valid: true; phase: WorkflowPhase }
  | { valid: false; reason: string };

const NORMAL_TRANSITIONS: Readonly<
  Record<WorkflowPhase, WorkflowPhase | undefined>
> = {
  IDLE: "PLANNING",
  PLANNING: "PLAN_REVIEW",
  PLAN_REVIEW: "IMPLEMENTING",
  IMPLEMENTING: "CODE_REVIEW",
  CODE_REVIEW: "READY_FOR_MERGE",
  READY_FOR_MERGE: undefined,
  FAILED: undefined,
  CANCELLED: undefined,
};

export function canTransitionPhase(
  from: WorkflowPhase,
  to: WorkflowPhase,
  options: PhaseTransitionOptions = {},
): boolean {
  if (from === to && from === "PLAN_REVIEW") {
    return (
      options.kind === "plan-resubmission" &&
      options.resubmissionCount !== undefined &&
      canResubmitPlan(options.resubmissionCount)
    );
  }
  if (from === "CODE_REVIEW" && to === "IMPLEMENTING") {
    return (
      options.kind === "code-review-change-cycle" &&
      options.changeCycleCount !== undefined &&
      canStartCodeReviewChangeCycle(options.changeCycleCount) &&
      options.sameCoordinator === true &&
      options.approvedScope === true &&
      options.newDecisionRequired === false
    );
  }
  if (isActivePhase(from) && (to === "FAILED" || to === "CANCELLED")) {
    return true;
  }
  return options.kind !== undefined && options.kind !== "standard"
    ? false
    : NORMAL_TRANSITIONS[from] === to;
}

export function transitionPhase(
  from: WorkflowPhase,
  to: WorkflowPhase,
  options: PhaseTransitionOptions = {},
): PhaseTransitionResult {
  if (!isWorkflowPhase(from) || !isWorkflowPhase(to)) {
    return { valid: false, reason: "Unknown workflow phase" };
  }
  return canTransitionPhase(from, to, options)
    ? { valid: true, phase: to }
    : { valid: false, reason: `Invalid transition: ${from} -> ${to}` };
}

export type RootStateTransitionResult =
  | { valid: true; state: RootWorkflowState }
  | { valid: false; reason: string };

export type CancellationTransitionResult =
  | { cancelled: true; duplicate: boolean; state: RootWorkflowState }
  | { cancelled: false; reason: string };

function isStep3Transition(
  from: WorkflowPhase,
  to: WorkflowPhase,
): to is "PLANNING" | "FAILED" | "CANCELLED" {
  return (
    (from === "IDLE" && to === "PLANNING") ||
    (isActivePhase(from) && (to === "FAILED" || to === "CANCELLED"))
  );
}

function updateStateForStep3Transition(
  state: RootWorkflowState,
  phase: "PLANNING" | "FAILED" | "CANCELLED",
): RootWorkflowState {
  const next: RootWorkflowState = { ...state, phase };
  if (phase === "PLANNING") {
    next.planningStatus = "RUNNING";
    next.implementationStatus = "NOT_STARTED";
    next.finalStatus = "NONE";
    return next;
  }

  if (phase === "FAILED") {
    if (next.planningStatus === "RUNNING") {
      next.planningStatus = "FAILED";
    }
    if (next.implementationStatus === "RUNNING") {
      next.implementationStatus = "FAILED";
    }
    delete next.pendingInteraction;
    next.finalStatus = "FAILED";
    return next;
  }

  delete next.pendingInteraction;
  if (next.planningStatus === "RUNNING") {
    next.planningStatus = "CANCELLED";
  }
  if (next.implementationStatus === "RUNNING") {
    next.implementationStatus = "CANCELLED";
  }
  next.finalStatus = "CANCELLED";
  return next;
}

export function transitionRootWorkflowState(
  value: unknown,
  to: unknown,
): RootStateTransitionResult {
  const current = validateRootWorkflowState(value);
  if (!current.valid) {
    return { valid: false, reason: "Current Root workflow state is invalid" };
  }
  if (!isWorkflowPhase(to)) {
    return { valid: false, reason: "Unknown workflow phase" };
  }

  const transition = transitionPhase(current.value.phase, to);
  if (!transition.valid) {
    return transition;
  }
  if (!isStep3Transition(current.value.phase, to)) {
    return {
      valid: false,
      reason: "Phase advance requires a later Step precondition",
    };
  }

  const next = updateStateForStep3Transition(current.value, to);
  const validation = validateRootWorkflowState(next);
  return validation.valid
    ? { valid: true, state: validation.value }
    : { valid: false, reason: "Phase and status are inconsistent" };
}
