import { readFile as readFileFromDisk } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  PLAN_ARTIFACT_FILE_NAME,
  TIMEOUTS,
  canonicalizePlan,
  createRequestId,
  createReviewId,
  hashPlan,
  isActivePhase,
  isValidReviewId,
  validatePlanArtifactTemplate,
  validatePlanningHandoffAgainstPlan,
  type ArtifactRef,
  type PlanHash,
  type PlanningHandoff,
  type RootWorkflowState,
  type ReviewId,
} from "../core/index.ts";
import {
  hasOnlyKeys,
  isBoundedString,
  isRecord,
  validResult,
  invalidResult,
  type ValidationResult,
} from "../core/validation.ts";
import type { RegistryTransitionResult } from "./root-lifecycle.ts";
import type { PlanningCoordinatorLaunchResult } from "./subagents-rpc.ts";

export const PLANNOTATOR_REQUEST_EVENT = "plannotator:request" as const;
export const PLANNOTATOR_REVIEW_RESULT_EVENT =
  "plannotator:review-result" as const;

export interface PlanReviewEventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

interface PlannotatorRequest {
  requestId: string;
  action: "plan-review" | "review-status";
  payload: Record<string, unknown>;
  respond: (response: unknown) => void;
}

type PlanReviewStatusResult =
  | { status: "pending" }
  | { status: "missing" }
  | {
      status: "completed";
      reviewId: string;
      approved: boolean;
      feedback?: string;
    };

interface PlanReviewResult {
  reviewId: ReviewId;
  approved: boolean;
  feedback?: string;
}

export interface PlanReviewSnapshot {
  planContent: string;
  planHash: PlanHash;
  handoff: PlanningHandoff;
  planPath: string;
}

export interface PlanReviewRegistry {
  getState(): RootWorkflowState | undefined;
  setPlanReviewPending(
    requestId: unknown,
    reviewId: unknown,
  ): RegistryTransitionResult;
  recordPlanApproval(
    identity: unknown,
    currentPlanHash: unknown,
    handoff: unknown,
  ): RegistryTransitionResult;
  recordPlanRejection(
    reviewId: unknown,
    feedback?: unknown,
  ): RegistryTransitionResult;
  preparePlanResubmission(): RegistryTransitionResult;
  setPlanningRunId(runId: unknown): RegistryTransitionResult;
  transition(to: "FAILED"): RegistryTransitionResult;
}

export interface PlanReviewRootBridgeOptions {
  events: PlanReviewEventBus;
  registry: PlanReviewRegistry;
  launchFreshPlanningCoordinator?: () => Promise<PlanningCoordinatorLaunchResult>;
  stopPlanningCoordinator?: (runId: string) => Promise<unknown>;
  readFile?: (path: string) => Promise<Uint8Array>;
  resolveArtifactPath?: (path: string) => string;
  timeoutMs?: number;
}

export type PlanReviewStartResult =
  | { started: true; requestId: string; reviewId: ReviewId }
  | { started: false; reason: string };

export type PlanResubmissionResult =
  | { started: true; runId: PlanningCoordinatorLaunchResult["runId"] }
  | { started: false; reason: string };

export class PlanReviewError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PlanReviewError";
  }
}

function setUnref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
}

function responseError(value: unknown): string {
  if (!isRecord(value)) return "Plannotator response is invalid";
  if (value.status === "unavailable") {
    return typeof value.error === "string"
      ? value.error
      : "Plannotator is unavailable";
  }
  if (value.status === "error") {
    return typeof value.error === "string"
      ? value.error
      : "Plannotator returned an error";
  }
  return "Plannotator response is invalid";
}

function parseStartResponse(
  value: unknown,
): ValidationResult<{ reviewId: ReviewId }> {
  if (
    !isRecord(value) ||
    value.status !== "handled" ||
    !isRecord(value.result) ||
    value.result.status !== "pending" ||
    !isValidReviewId(value.result.reviewId)
  ) {
    return invalidResult(responseError(value));
  }
  try {
    return validResult({ reviewId: createReviewId(value.result.reviewId) });
  } catch {
    return invalidResult("Plannotator reviewId is invalid");
  }
}

function parseReviewResult(value: unknown): ValidationResult<PlanReviewResult> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "reviewId",
      "approved",
      "feedback",
      "savedPath",
      "agentSwitch",
      "permissionMode",
    ]) ||
    !isValidReviewId(value.reviewId) ||
    typeof value.approved !== "boolean"
  ) {
    return invalidResult("Plannotator review result is invalid");
  }
  if (
    value.feedback !== undefined &&
    !isBoundedString(value.feedback, 16 * 1024)
  ) {
    return invalidResult("Plannotator review feedback is invalid");
  }
  try {
    const reviewId = createReviewId(value.reviewId);
    return validResult({
      reviewId,
      approved: value.approved,
      ...(value.feedback === undefined ? {} : { feedback: value.feedback }),
    });
  } catch {
    return invalidResult("Plannotator reviewId is invalid");
  }
}

function parseStatusResult(
  value: unknown,
): ValidationResult<PlanReviewStatusResult> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "status",
      "reviewId",
      "approved",
      "feedback",
      "savedPath",
      "agentSwitch",
      "permissionMode",
    ])
  ) {
    return invalidResult("Plannotator review-status result is invalid");
  }
  if (value.status === "pending" || value.status === "missing") {
    return validResult({ status: value.status });
  }
  if (
    value.status !== "completed" ||
    !isValidReviewId(value.reviewId) ||
    typeof value.approved !== "boolean" ||
    (value.feedback !== undefined &&
      !isBoundedString(value.feedback, 16 * 1024))
  ) {
    return invalidResult("Plannotator review-status result is invalid");
  }
  return validResult({
    status: "completed",
    reviewId: value.reviewId,
    approved: value.approved,
    ...(value.feedback === undefined ? {} : { feedback: value.feedback }),
  });
}

function reviewFingerprint(result: PlanReviewResult): string {
  return JSON.stringify({
    reviewId: result.reviewId,
    approved: result.approved,
    feedback: result.feedback ?? "",
  });
}

function artifactPath(
  reference: ArtifactRef,
  resolver: ((path: string) => string) | undefined,
): string {
  if (resolver !== undefined) return resolver(reference.path);
  return isAbsolute(reference.path) ? reference.path : resolve(reference.path);
}

async function decodeUtf8(value: Uint8Array): Promise<string> {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new PlanReviewError("Plan Review artifact is not valid UTF-8");
  }
}

export async function readPlanReviewSnapshot(
  state: RootWorkflowState,
  readFile: (path: string) => Promise<Uint8Array> = (path) =>
    readFileFromDisk(path),
  resolveArtifactPath?: (path: string) => string,
): Promise<PlanReviewSnapshot> {
  if (
    state.phase !== "PLAN_REVIEW" ||
    state.planningStatus !== "COMPLETED" ||
    state.planningHandoffRef === undefined
  ) {
    throw new PlanReviewError("Plan Review is not ready for the current state");
  }

  const handoffPath = artifactPath(
    state.planningHandoffRef,
    resolveArtifactPath,
  );
  const handoffText = await decodeUtf8(await readFile(handoffPath));
  let handoffValue: unknown;
  try {
    handoffValue = JSON.parse(handoffText);
  } catch {
    throw new PlanReviewError("Planning Handoff is not valid JSON");
  }

  if (
    !isRecord(handoffValue) ||
    !isRecord(handoffValue.planArtifact) ||
    handoffValue.planArtifact.path !== PLAN_ARTIFACT_FILE_NAME
  ) {
    throw new PlanReviewError(
      "Planning Handoff does not reference the Plan Artifact",
    );
  }
  const planPath = join(dirname(handoffPath), PLAN_ARTIFACT_FILE_NAME);
  const planBytes = await readFile(planPath);
  const template = validatePlanArtifactTemplate(planBytes);
  if (!template.valid) {
    throw new PlanReviewError(template.errors.join("; "));
  }
  const handoff = validatePlanningHandoffAgainstPlan(
    handoffValue,
    planBytes,
    state.workflowId,
  );
  if (!handoff.valid) {
    throw new PlanReviewError(handoff.errors.join("; "));
  }
  return {
    planContent: canonicalizePlan(planBytes),
    planHash: hashPlan(planBytes),
    handoff: handoff.value,
    planPath,
  };
}

interface PendingReview {
  requestId: string;
  planHash: PlanHash["value"];
  reviewId?: ReviewId;
  responseHandled: boolean;
  statusRequested: boolean;
  settling: boolean;
  settlingFingerprint?: string;
  timer?: ReturnType<typeof setTimeout>;
  startSettled: boolean;
  resolveStart: (result: PlanReviewStartResult) => void;
}

export class PlanReviewRootBridge {
  private readonly timeoutMs: number;
  private pending: PendingReview | undefined;
  private disposed = false;
  private readonly completed = new Map<ReviewId, string>();
  private readonly removeReviewResult: () => void;

  public constructor(private readonly options: PlanReviewRootBridgeOptions) {
    const timeout = options.timeoutMs ?? TIMEOUTS.planReviewTimeoutMs;
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new RangeError("Plan Review timeout must be a positive integer");
    }
    this.timeoutMs = timeout;
    this.removeReviewResult = options.events.on(
      PLANNOTATOR_REVIEW_RESULT_EVENT,
      (value) => this.observeReviewResult(value),
    );
  }

  public hasPendingReview(): boolean {
    return this.pending !== undefined && !this.pending.settling;
  }

  public async start(
    state = this.options.registry.getState(),
  ): Promise<PlanReviewStartResult> {
    if (this.disposed) return { started: false, reason: "Bridge is disposed" };
    if (this.pending !== undefined) {
      return { started: false, reason: "Plan Review is already pending" };
    }
    if (state === undefined) {
      return { started: false, reason: "No Root workflow exists" };
    }
    if (
      state.reviewId !== undefined ||
      state.approval !== null ||
      state.pendingInteraction !== undefined
    ) {
      return {
        started: false,
        reason: "Plan Review requires an explicit fresh resubmission",
      };
    }

    let snapshot: PlanReviewSnapshot;
    try {
      snapshot = await readPlanReviewSnapshot(
        state,
        this.options.readFile,
        this.options.resolveArtifactPath,
      );
    } catch (error) {
      this.failWorkflow();
      return {
        started: false,
        reason:
          error instanceof Error
            ? error.message
            : "Plan Review artifact is invalid",
      };
    }

    const requestId = createRequestId();
    return new Promise<PlanReviewStartResult>((resolveStart) => {
      const pending: PendingReview = {
        requestId,
        planHash: snapshot.planHash.value,
        responseHandled: false,
        statusRequested: false,
        settling: false,
        startSettled: false,
        resolveStart,
      };
      this.pending = pending;
      this.armTimeout(pending);
      const request: PlannotatorRequest = {
        requestId,
        action: "plan-review",
        payload: {
          planContent: snapshot.planContent,
          planFilePath: snapshot.planPath,
          origin: "pi-workflow",
        },
        respond: (response) => this.onStartResponse(pending, response),
      };
      try {
        this.options.events.emit(PLANNOTATOR_REQUEST_EVENT, request);
      } catch (error) {
        this.failPending(
          pending,
          error instanceof Error
            ? error.message
            : "Could not start Plan Review",
        );
      }
    });
  }

  public async resubmitPlanning(): Promise<PlanResubmissionResult> {
    if (this.disposed) {
      return { started: false, reason: "Bridge is disposed" };
    }
    const prepared = this.options.registry.preparePlanResubmission();
    if (!prepared.transitioned) {
      return { started: false, reason: prepared.reason };
    }
    const launchPlanning = this.options.launchFreshPlanningCoordinator;
    if (launchPlanning === undefined) {
      this.failWorkflow();
      return {
        started: false,
        reason: "Fresh Planning launcher is unavailable",
      };
    }

    let launch: PlanningCoordinatorLaunchResult;
    try {
      launch = await launchPlanning();
    } catch (error) {
      this.failWorkflow();
      return {
        started: false,
        reason:
          error instanceof Error
            ? error.message
            : "Fresh Planning Coordinator could not be started",
      };
    }

    const attached = this.options.registry.setPlanningRunId(launch.runId);
    if (!attached.transitioned) {
      try {
        await this.options.stopPlanningCoordinator?.(launch.runId);
      } catch {
        // The workflow remains failed when an orphan stop cannot complete.
      }
      this.failWorkflow();
      return { started: false, reason: attached.reason };
    }
    return { started: true, runId: launch.runId };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeReviewResult();
    const pending = this.pending;
    if (pending !== undefined) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      this.pending = undefined;
      if (!pending.startSettled) {
        pending.startSettled = true;
        pending.resolveStart({
          started: false,
          reason: "Plan Review bridge shut down",
        });
      }
    }
    this.completed.clear();
  }

  private onStartResponse(pending: PendingReview, value: unknown): void {
    if (
      this.disposed ||
      this.pending !== pending ||
      pending.responseHandled ||
      pending.settling
    ) {
      return;
    }
    pending.responseHandled = true;
    const parsed = parseStartResponse(value);
    if (!parsed.valid) {
      this.failPending(
        pending,
        parsed.errors[0] ?? "Plan Review could not start",
      );
      return;
    }
    pending.reviewId = parsed.value.reviewId;
    const attached = this.options.registry.setPlanReviewPending(
      pending.requestId,
      pending.reviewId,
    );
    if (!attached.transitioned) {
      this.failPending(pending, attached.reason);
      return;
    }
    this.resolveStart(pending, {
      started: true,
      requestId: pending.requestId,
      reviewId: pending.reviewId,
    });
  }

  private resolveStart(
    pending: PendingReview,
    result: PlanReviewStartResult,
  ): void {
    if (pending.startSettled) return;
    pending.startSettled = true;
    pending.resolveStart(result);
  }

  private observeReviewResult(value: unknown): void {
    const candidate = isRecord(value) ? value.reviewId : undefined;
    if (!isValidReviewId(candidate)) return;
    const parsed = parseReviewResult(value);
    const completed = this.completed.get(createReviewId(candidate));
    if (this.pending === undefined) {
      if (completed !== undefined && parsed.valid) {
        if (completed !== reviewFingerprint(parsed.value)) this.failWorkflow();
      }
      return;
    }
    const pending = this.pending;
    if (pending.reviewId !== candidate) return;
    if (!parsed.valid) {
      this.failPending(
        pending,
        parsed.errors[0] ?? "Plan Review result is invalid",
      );
      return;
    }
    const fingerprint = reviewFingerprint(parsed.value);
    if (pending.settling) {
      if (pending.settlingFingerprint !== fingerprint) this.failWorkflow();
      return;
    }
    pending.settling = true;
    pending.settlingFingerprint = fingerprint;
    void this.finishReview(pending, parsed.value);
  }

  private async finishReview(
    pending: PendingReview,
    result: PlanReviewResult,
  ): Promise<void> {
    try {
      const state = this.options.registry.getState();
      if (state === undefined)
        throw new PlanReviewError("Root workflow is missing");
      const snapshot = await readPlanReviewSnapshot(
        state,
        this.options.readFile,
        this.options.resolveArtifactPath,
      );
      if (snapshot.planHash.value !== pending.planHash) {
        throw new PlanReviewError(
          "Plan content changed after Plan Review started",
        );
      }

      const transition = result.approved
        ? this.options.registry.recordPlanApproval(
            {
              approvedPlanHash: snapshot.planHash.value,
              reviewId: result.reviewId,
              approval: true,
              ...(result.feedback === undefined
                ? {}
                : { approvalFeedback: result.feedback }),
            },
            snapshot.planHash.value,
            snapshot.handoff,
          )
        : this.options.registry.recordPlanRejection(
            result.reviewId,
            result.feedback,
          );
      if (!transition.transitioned)
        throw new PlanReviewError(transition.reason);

      if (pending.timer !== undefined) clearTimeout(pending.timer);
      this.pending = undefined;
      this.completed.set(result.reviewId, reviewFingerprint(result));
      while (this.completed.size > 64) {
        const oldest = this.completed.keys().next().value;
        if (oldest === undefined) break;
        this.completed.delete(oldest);
      }
    } catch (error) {
      this.failPending(
        pending,
        error instanceof Error
          ? error.message
          : "Plan Review result is invalid",
      );
    }
  }

  private armTimeout(pending: PendingReview): void {
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this.onTimeout(pending), this.timeoutMs);
    setUnref(pending.timer);
  }

  private onTimeout(pending: PendingReview): void {
    if (this.disposed || this.pending !== pending || pending.settling) {
      return;
    }
    if (pending.reviewId !== undefined && !pending.statusRequested) {
      pending.statusRequested = true;
      this.requestStatus(pending);
      return;
    }
    this.failPending(pending, "Plan Review timed out");
  }

  private requestStatus(pending: PendingReview): void {
    if (pending.reviewId === undefined) {
      this.failPending(pending, "Plan Review has no review identity");
      return;
    }
    const requestId = createRequestId();
    const request: PlannotatorRequest = {
      requestId,
      action: "review-status",
      payload: { reviewId: pending.reviewId },
      respond: (response) => this.onStatusResponse(pending, response),
    };
    this.armTimeout(pending);
    try {
      this.options.events.emit(PLANNOTATOR_REQUEST_EVENT, request);
    } catch (error) {
      this.failPending(
        pending,
        error instanceof Error
          ? error.message
          : "Could not query Plan Review status",
      );
    }
  }

  private onStatusResponse(pending: PendingReview, value: unknown): void {
    if (this.disposed || this.pending !== pending) {
      return;
    }
    if (!isRecord(value) || value.status !== "handled") {
      this.failPending(pending, responseError(value));
      return;
    }
    const parsed = parseStatusResult(value.result);
    if (!parsed.valid) {
      this.failPending(
        pending,
        parsed.errors[0] ?? "Plan Review status is invalid",
      );
      return;
    }
    if (parsed.value.status !== "completed") {
      this.failPending(
        pending,
        "Plan Review did not produce a completed decision",
      );
      return;
    }
    const result = parseReviewResult({
      reviewId: parsed.value.reviewId,
      approved: parsed.value.approved,
      ...(parsed.value.feedback === undefined
        ? {}
        : { feedback: parsed.value.feedback }),
    });
    if (!result.valid || result.value.reviewId !== pending.reviewId) {
      this.failPending(pending, "Plan Review status identity does not match");
      return;
    }
    const fingerprint = reviewFingerprint(result.value);
    if (pending.settling) {
      if (pending.settlingFingerprint !== fingerprint) this.failWorkflow();
      return;
    }
    pending.settling = true;
    pending.settlingFingerprint = fingerprint;
    void this.finishReview(pending, result.value);
  }

  private failPending(pending: PendingReview, reason: string): void {
    if (this.pending !== pending) return;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    this.pending = undefined;
    this.failWorkflow();
    this.resolveStart(pending, { started: false, reason });
  }

  private failWorkflow(): void {
    const state = this.options.registry.getState();
    if (state !== undefined && isActivePhase(state.phase)) {
      this.options.registry.transition("FAILED");
    }
  }
}

export function registerPlanReviewRootBridge(
  options: PlanReviewRootBridgeOptions,
): PlanReviewRootBridge {
  return new PlanReviewRootBridge(options);
}

export function isPlanReviewRequest(
  value: unknown,
): value is PlannotatorRequest {
  return (
    isRecord(value) &&
    isBoundedString(value.requestId, 4096, true) &&
    (value.action === "plan-review" || value.action === "review-status") &&
    isRecord(value.payload) &&
    typeof value.respond === "function"
  );
}
