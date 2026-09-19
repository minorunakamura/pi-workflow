import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  canResubmitPlan,
  canStartCodeReviewChangeCycle,
  canStartWorkflow,
  createInitialWorkflowState,
  isActivePhase,
  isValidPlanHashValue,
  isValidRequestId,
  isValidReviewId,
  validateApprovalIdentity,
  validateCodeReviewResultSummary,
  validatePlanningCoordinatorResult,
  isValidRunId,
  isValidWorkflowId,
  isWorkflowType,
  transitionRootWorkflowState,
  validateRootWorkflowState,
  type PendingInteraction,
  type RootWorkflowState,
  type WorkflowPhase,
  type WorkflowRequest,
} from "../core/index.ts";
import { isBoundedString, isRecord } from "../core/validation.ts";

export const ROOT_LIFECYCLE_ENTRY_TYPE = "pi-workflow.lifecycle.v1" as const;

type AppendEntry = (customType: string, data?: unknown) => void;

export type StartWorkflowResult =
  | { started: true; state: RootWorkflowState }
  | {
      started: false;
      reason:
        | "ACTIVE_WORKFLOW_EXISTS"
        | "INVALID_WORKFLOW_IDENTITY"
        | "INVALID_STATE"
        | "PERSISTENCE_FAILED";
    };

export type RegistryTransitionResult =
  | { transitioned: true; state: RootWorkflowState }
  | { transitioned: false; reason: string };

function cloneState(state: RootWorkflowState): RootWorkflowState {
  return structuredClone(state);
}

function isLifecycleEntry(value: unknown): value is {
  type: "custom";
  customType: typeof ROOT_LIFECYCLE_ENTRY_TYPE;
  data?: unknown;
} {
  return (
    isRecord(value) &&
    value.type === "custom" &&
    value.customType === ROOT_LIFECYCLE_ENTRY_TYPE
  );
}

function readLatestRootWorkflowState(
  entries: readonly unknown[],
): RootWorkflowState | undefined {
  let latest: RootWorkflowState | undefined;
  for (const entry of entries) {
    if (!isLifecycleEntry(entry)) {
      continue;
    }
    const validation = validateRootWorkflowState(entry.data);
    if (validation.valid) {
      latest = cloneState(validation.value);
    }
  }
  return latest;
}

export function restoreRootWorkflowState(
  entries: readonly unknown[],
): RootWorkflowState | undefined {
  const latest = readLatestRootWorkflowState(entries);
  if (latest === undefined || !isActivePhase(latest.phase)) {
    return latest;
  }
  const stale = transitionRootWorkflowState(latest, "FAILED");
  return stale.valid ? stale.state : undefined;
}

export function persistRootWorkflowState(
  appendEntry: AppendEntry,
  state: RootWorkflowState,
): void {
  const validation = validateRootWorkflowState(state);
  if (!validation.valid) {
    throw new TypeError("Cannot persist an invalid Root workflow state");
  }
  appendEntry(ROOT_LIFECYCLE_ENTRY_TYPE, cloneState(validation.value));
}

export class RootWorkflowRegistry {
  private state: RootWorkflowState | undefined;
  private activeWorkflowRequest: WorkflowRequest | undefined;

  public constructor(private readonly appendEntry: AppendEntry) {}

  public getState(): RootWorkflowState | undefined {
    return this.state === undefined ? undefined : cloneState(this.state);
  }

  public bindWorkflowRequest(request: WorkflowRequest): boolean {
    const state = this.state;
    if (
      state === undefined ||
      !isActivePhase(state.phase) ||
      request.workflowId !== state.workflowId ||
      !isWorkflowType(request.workflowType) ||
      !isBoundedString(request.request, 64 * 1024, true) ||
      !isBoundedString(request.cwd, 4096, true) ||
      /[\0\r\n]/u.test(request.cwd) ||
      !isBoundedString(request.createdAt, 128, true)
    ) {
      return false;
    }
    this.activeWorkflowRequest = structuredClone(request);
    return true;
  }

  public getActiveWorkflowRequest(): WorkflowRequest | undefined {
    const state = this.state;
    const request = this.activeWorkflowRequest;
    if (
      state === undefined ||
      !isActivePhase(state.phase) ||
      request === undefined ||
      request.workflowId !== state.workflowId
    ) {
      return undefined;
    }
    return structuredClone(request);
  }

  public hasActiveWorkflow(): boolean {
    return this.state !== undefined && isActivePhase(this.state.phase);
  }

  public restore(entries: readonly unknown[]): RootWorkflowState | undefined {
    this.activeWorkflowRequest = undefined;
    const restored = readLatestRootWorkflowState(entries);
    if (restored === undefined || !isActivePhase(restored.phase)) {
      this.state = restored;
      return this.getState();
    }

    const stale = transitionRootWorkflowState(restored, "FAILED");
    if (!stale.valid) {
      this.state = undefined;
      return undefined;
    }
    this.state = stale.state;
    persistRootWorkflowState(this.appendEntry, stale.state);
    return this.getState();
  }

  public shutdown(): void {
    const current = this.state;
    try {
      if (current !== undefined && isActivePhase(current.phase)) {
        const stale = transitionRootWorkflowState(current, "FAILED");
        if (!stale.valid) {
          throw new Error(stale.reason);
        }
        this.state = stale.state;
        persistRootWorkflowState(this.appendEntry, stale.state);
      }
    } finally {
      this.clear();
    }
  }

  public clear(): void {
    this.state = undefined;
    this.activeWorkflowRequest = undefined;
  }

  public start(
    workflowId: unknown,
    workflowType: unknown,
  ): StartWorkflowResult {
    if (!isValidWorkflowId(workflowId) || !isWorkflowType(workflowType)) {
      return { started: false, reason: "INVALID_WORKFLOW_IDENTITY" };
    }
    if (!canStartWorkflow(this.state)) {
      return { started: false, reason: "ACTIVE_WORKFLOW_EXISTS" };
    }

    const initial = createInitialWorkflowState(workflowId, workflowType);
    const transition = transitionRootWorkflowState(initial, "PLANNING");
    if (!transition.valid) {
      return { started: false, reason: "INVALID_STATE" };
    }
    try {
      this.activeWorkflowRequest = undefined;
      return { started: true, state: this.commit(transition.state) };
    } catch {
      return { started: false, reason: "PERSISTENCE_FAILED" };
    }
  }

  public transition(to: WorkflowPhase): RegistryTransitionResult {
    if (this.state === undefined) {
      return { transitioned: false, reason: "No Root workflow exists" };
    }
    const transition = transitionRootWorkflowState(this.state, to);
    if (!transition.valid) {
      return { transitioned: false, reason: transition.reason };
    }
    try {
      return { transitioned: true, state: this.commit(transition.state) };
    } catch {
      return { transitioned: false, reason: "Persistence failed" };
    }
  }

  public setPlanningRunId(runId: unknown): RegistryTransitionResult {
    if (this.state === undefined) {
      return { transitioned: false, reason: "No Root workflow exists" };
    }
    const canAttachInitialRun =
      this.state.phase === "PLANNING" &&
      this.state.planningStatus === "RUNNING";
    const canAttachResubmissionRun =
      this.state.phase === "PLAN_REVIEW" &&
      this.state.planningStatus === "RUNNING";
    if (
      (!canAttachInitialRun && !canAttachResubmissionRun) ||
      this.state.planningRunId !== undefined ||
      !isValidRunId(runId)
    ) {
      return {
        transitioned: false,
        reason: "Planning run identity cannot be attached",
      };
    }
    try {
      return {
        transitioned: true,
        state: this.commit({ ...this.state, planningRunId: runId }),
      };
    } catch {
      return { transitioned: false, reason: "Persistence failed" };
    }
  }

  public setPlanReviewPending(
    requestId: unknown,
    reviewId: unknown,
  ): RegistryTransitionResult {
    const current = this.state;
    if (current === undefined) {
      return { transitioned: false, reason: "No Root workflow exists" };
    }
    if (
      current.phase !== "PLAN_REVIEW" ||
      current.planningStatus !== "COMPLETED" ||
      !isValidRunId(current.planningRunId) ||
      current.pendingInteraction !== undefined ||
      current.approval === true ||
      !isValidRequestId(requestId) ||
      !isValidReviewId(reviewId)
    ) {
      return {
        transitioned: false,
        reason: "Plan Review interaction cannot be attached",
      };
    }

    const next: RootWorkflowState = {
      ...current,
      reviewId,
      approval: null,
      pendingInteraction: {
        kind: "plan-review",
        requestId,
        coordinatorRunId: current.planningRunId,
        reviewId,
      },
    };
    delete next.approvedPlanHash;
    delete next.approvalFeedback;
    try {
      return { transitioned: true, state: this.commit(next) };
    } catch {
      return { transitioned: false, reason: "Persistence failed" };
    }
  }

  public recordPlanApproval(
    identity: unknown,
    currentPlanHash: unknown,
    handoff: unknown,
  ): RegistryTransitionResult {
    const current = this.state;
    if (current === undefined) {
      return { transitioned: false, reason: "No Root workflow exists" };
    }
    const pending = current.pendingInteraction;
    if (
      current.phase !== "PLAN_REVIEW" ||
      current.planningStatus !== "COMPLETED" ||
      pending?.kind !== "plan-review" ||
      !isRecord(identity) ||
      pending.reviewId !== identity.reviewId
    ) {
      return {
        transitioned: false,
        reason: "Plan approval does not match the pending review",
      };
    }

    const approval = validateApprovalIdentity(
      identity,
      currentPlanHash,
      handoff,
    );
    if (!approval.valid) {
      return { transitioned: false, reason: approval.errors.join("; ") };
    }

    const next: RootWorkflowState = {
      ...current,
      reviewId: approval.value.reviewId,
      approvedPlanHash: approval.value.approvedPlanHash,
      approval: true,
    };
    if (approval.value.approvalFeedback === undefined) {
      delete next.approvalFeedback;
    } else {
      next.approvalFeedback = approval.value.approvalFeedback;
    }
    delete next.pendingInteraction;
    try {
      return { transitioned: true, state: this.commit(next) };
    } catch {
      return { transitioned: false, reason: "Persistence failed" };
    }
  }

  public startImplementation(runId: unknown): RegistryTransitionResult {
    const current = this.state;
    if (current === undefined) {
      return { transitioned: false, reason: "No Root workflow exists" };
    }
    if (
      current.phase !== "PLAN_REVIEW" ||
      current.planningStatus !== "COMPLETED" ||
      current.implementationStatus !== "NOT_STARTED" ||
      current.implementationRunId !== undefined ||
      current.pendingInteraction !== undefined ||
      current.planningHandoffRef === undefined ||
      current.approval !== true ||
      !isValidReviewId(current.reviewId) ||
      !isValidPlanHashValue(current.approvedPlanHash) ||
      !isValidRunId(current.planningRunId) ||
      !isValidRunId(runId) ||
      runId === current.planningRunId
    ) {
      return {
        transitioned: false,
        reason: "Implementation Coordinator launch preconditions are not met",
      };
    }

    const next: RootWorkflowState = {
      ...current,
      phase: "IMPLEMENTING",
      implementationStatus: "RUNNING",
      implementationRunId: runId,
    };
    try {
      return { transitioned: true, state: this.commit(next) };
    } catch {
      return { transitioned: false, reason: "Persistence failed" };
    }
  }

  public setCodeReviewPending(
    requestId: unknown,
    coordinatorRunId: unknown,
  ): RegistryTransitionResult {
    const current = this.state;
    if (current === undefined) {
      return { transitioned: false, reason: "No Root workflow exists" };
    }
    if (
      current.phase !== "IMPLEMENTING" ||
      current.planningStatus !== "COMPLETED" ||
      current.implementationStatus !== "RUNNING" ||
      current.pendingInteraction !== undefined ||
      !isValidRequestId(requestId) ||
      !isValidRunId(coordinatorRunId) ||
      current.implementationRunId !== coordinatorRunId
    ) {
      return {
        transitioned: false,
        reason: "Code Review interaction cannot be attached",
      };
    }

    const next: RootWorkflowState = {
      ...current,
      phase: "CODE_REVIEW",
      implementationStatus: "COMPLETED",
      pendingInteraction: {
        kind: "code-review",
        requestId,
        coordinatorRunId,
      },
    };
    try {
      return { transitioned: true, state: this.commit(next) };
    } catch {
      return { transitioned: false, reason: "Persistence failed" };
    }
  }

  public recordCodeReviewResult(result: unknown): RegistryTransitionResult {
    const current = this.state;
    if (current === undefined) {
      return { transitioned: false, reason: "No Root workflow exists" };
    }
    const parsed = validateCodeReviewResultSummary(result);
    const pending = current.pendingInteraction;
    if (
      !parsed.valid ||
      current.phase !== "CODE_REVIEW" ||
      current.implementationStatus !== "COMPLETED" ||
      pending?.kind !== "code-review" ||
      pending.requestId !== parsed.value.requestId ||
      pending.coordinatorRunId !== current.implementationRunId
    ) {
      return {
        transitioned: false,
        reason: parsed.valid
          ? "Code Review result does not match the pending interaction"
          : parsed.errors.join("; "),
      };
    }

    const next: RootWorkflowState = {
      ...current,
      codeReviewResult: parsed.value,
    };
    delete next.pendingInteraction;

    if (parsed.value.status === "rejected") {
      if (!canStartCodeReviewChangeCycle(current.codeReviewChangeCycleCount)) {
        next.phase = "FAILED";
        next.implementationStatus = "FAILED";
        next.finalStatus = "FAILED";
      } else {
        next.phase = "IMPLEMENTING";
        next.implementationStatus = "RUNNING";
        next.codeReviewChangeCycleCount =
          current.codeReviewChangeCycleCount + 1;
      }
    } else if (parsed.value.status !== "approved") {
      next.phase = "FAILED";
      next.implementationStatus = "FAILED";
      next.finalStatus = "FAILED";
    }

    try {
      return { transitioned: true, state: this.commit(next) };
    } catch {
      return { transitioned: false, reason: "Persistence failed" };
    }
  }

  public recordPlanRejection(
    reviewId: unknown,
    feedback?: unknown,
  ): RegistryTransitionResult {
    const current = this.state;
    if (current === undefined) {
      return { transitioned: false, reason: "No Root workflow exists" };
    }
    const pending = current.pendingInteraction;
    const validReview =
      current.phase === "PLAN_REVIEW" &&
      current.planningStatus === "COMPLETED" &&
      pending?.kind === "plan-review" &&
      pending.reviewId === reviewId &&
      isValidReviewId(reviewId) &&
      (feedback === undefined || isBoundedString(feedback, 16 * 1024));
    if (!validReview) {
      if (
        current.phase === "PLAN_REVIEW" &&
        current.planningStatus === "COMPLETED"
      ) {
        const failure = this.transition("FAILED");
        return failure.transitioned
          ? {
              transitioned: false,
              reason: "Plan rejection does not match the pending review",
            }
          : failure;
      }
      return {
        transitioned: false,
        reason: "Plan rejection does not match the pending review",
      };
    }

    const next: RootWorkflowState = {
      ...current,
      ...(current.planResubmissionCount === 1
        ? { phase: "FAILED" as const, finalStatus: "FAILED" as const }
        : {}),
      reviewId,
      approval: false,
    };
    delete next.approvedPlanHash;
    delete next.pendingInteraction;
    if (feedback === undefined) {
      delete next.approvalFeedback;
    } else {
      next.approvalFeedback = feedback;
    }
    try {
      return { transitioned: true, state: this.commit(next) };
    } catch {
      return { transitioned: false, reason: "Persistence failed" };
    }
  }

  public preparePlanResubmission(): RegistryTransitionResult {
    const current = this.state;
    if (current === undefined) {
      return { transitioned: false, reason: "No Root workflow exists" };
    }
    const validRejectedPlan =
      current.phase === "PLAN_REVIEW" &&
      current.planningStatus === "COMPLETED" &&
      current.pendingInteraction === undefined &&
      current.approval === false &&
      isValidReviewId(current.reviewId) &&
      current.planResubmissionCount === 0 &&
      canResubmitPlan(current.planResubmissionCount);
    if (!validRejectedPlan) {
      const failure = this.transition("FAILED");
      return failure.transitioned
        ? { transitioned: false, reason: "Plan resubmission is not allowed" }
        : failure;
    }

    const next: RootWorkflowState = {
      ...current,
      phase: "PLAN_REVIEW",
      planResubmissionCount: current.planResubmissionCount + 1,
      planningStatus: "RUNNING",
      implementationStatus: "NOT_STARTED",
      approval: null,
      finalStatus: "NONE",
    };
    delete next.planningRunId;
    delete next.planningHandoffRef;
    delete next.reviewId;
    delete next.approvedPlanHash;
    delete next.approvalFeedback;
    delete next.pendingInteraction;
    delete next.codeReviewResult;
    try {
      return { transitioned: true, state: this.commit(next) };
    } catch {
      return { transitioned: false, reason: "Persistence failed" };
    }
  }

  public setPendingInteraction(
    interaction: PendingInteraction,
  ): RegistryTransitionResult {
    if (this.state === undefined) {
      return { transitioned: false, reason: "No Root workflow exists" };
    }
    if (
      this.state.phase !== "PLANNING" ||
      this.state.planningStatus !== "RUNNING" ||
      this.state.planningRunId !== interaction.coordinatorRunId ||
      this.state.pendingInteraction !== undefined ||
      interaction.kind !== "human" ||
      !isValidRequestId(interaction.requestId) ||
      !isValidRunId(interaction.coordinatorRunId)
    ) {
      return {
        transitioned: false,
        reason: "Human Decision interaction cannot be attached",
      };
    }
    try {
      return {
        transitioned: true,
        state: this.commit({ ...this.state, pendingInteraction: interaction }),
      };
    } catch {
      return { transitioned: false, reason: "Persistence failed" };
    }
  }

  public clearPendingInteraction(requestId: unknown): RegistryTransitionResult {
    const current = this.state;
    if (current === undefined) {
      return { transitioned: false, reason: "No Root workflow exists" };
    }
    if (!isValidRequestId(requestId)) {
      return {
        transitioned: false,
        reason: "Human Decision request ID is invalid",
      };
    }
    const pending = current.pendingInteraction;
    if (pending === undefined) {
      return { transitioned: true, state: cloneState(current) };
    }
    if (pending.requestId !== requestId) {
      return {
        transitioned: false,
        reason: "Human Decision request does not match the pending interaction",
      };
    }
    const next: RootWorkflowState = { ...current };
    delete next.pendingInteraction;
    try {
      return { transitioned: true, state: this.commit(next) };
    } catch {
      return { transitioned: false, reason: "Persistence failed" };
    }
  }

  public completePlanning(
    runId: unknown,
    result: unknown,
  ): RegistryTransitionResult {
    if (this.state === undefined) {
      return { transitioned: false, reason: "No Root workflow exists" };
    }
    const planningPhase =
      this.state.phase === "PLANNING" || this.state.phase === "PLAN_REVIEW";
    if (
      !planningPhase ||
      this.state.planningStatus !== "RUNNING" ||
      !isValidRunId(runId) ||
      this.state.planningRunId !== runId
    ) {
      return {
        transitioned: false,
        reason: "Planning completion does not match the active run",
      };
    }

    const validation = validatePlanningCoordinatorResult(result);
    if (!validation.valid) {
      return {
        transitioned: false,
        reason: validation.errors.join("; "),
      };
    }
    if (
      validation.value.workflowId !== this.state.workflowId ||
      validation.value.status !== "COMPLETED" ||
      validation.value.planningHandoffRef === undefined
    ) {
      return {
        transitioned: false,
        reason: "Planning completion is not valid for this workflow",
      };
    }

    const {
      planningHandoffRef: _planningHandoffRef,
      reviewId: _reviewId,
      approvedPlanHash: _approvedPlanHash,
      approvalFeedback: _approvalFeedback,
      pendingInteraction: _pendingInteraction,
      ...withoutPlanningReview
    } = this.state;
    const next: RootWorkflowState = {
      ...withoutPlanningReview,
      phase: "PLAN_REVIEW",
      planningStatus: "COMPLETED",
      planningHandoffRef: validation.value.planningHandoffRef,
      approval: null,
    };
    try {
      return { transitioned: true, state: this.commit(next) };
    } catch {
      return { transitioned: false, reason: "Persistence failed" };
    }
  }

  private commit(state: RootWorkflowState): RootWorkflowState {
    const next = cloneState(state);
    persistRootWorkflowState(this.appendEntry, next);
    this.state = next;
    if (!isActivePhase(next.phase)) this.activeWorkflowRequest = undefined;
    return cloneState(next);
  }
}

export function createRootWorkflowRegistry(
  pi: Pick<ExtensionAPI, "appendEntry">,
): RootWorkflowRegistry {
  return new RootWorkflowRegistry((customType, data) => {
    pi.appendEntry(customType, data);
  });
}
