import { isAbsolute, resolve } from "node:path";

import {
  TIMEOUTS,
  validateApprovalIdentity,
  validateImplementationCoordinatorInput,
  isValidRequestId,
  isValidRunId,
  type ImplementationCoordinatorInput,
  type RootWorkflowState,
  type WorkflowRequest,
} from "../core/index.ts";
import { isRecord } from "../core/validation.ts";
import {
  readPlanReviewSnapshot,
  type PlanReviewSnapshot,
} from "./plan-review.ts";
import type { ImplementationCoordinatorLaunchResult } from "./subagents-rpc.ts";

export interface ImplementationLaunchRegistry {
  getState(): RootWorkflowState | undefined;
  getActiveWorkflowRequest(): WorkflowRequest | undefined;
}

export interface ImplementationCoordinatorSpawner {
  spawnImplementationCoordinator(
    input: ImplementationCoordinatorInput,
  ): Promise<ImplementationCoordinatorLaunchResult>;
}

export interface FreshImplementationLaunchOptions
  extends ImplementationCoordinatorSpawner {
  registry: ImplementationLaunchRegistry;
  state?: RootWorkflowState;
  stopImplementationCoordinator?: (runId: string) => Promise<unknown>;
  readFile?: (path: string) => Promise<Uint8Array>;
  resolveArtifactPath?: (path: string) => string;
}

export type FreshImplementationLaunchResult =
  | ({ started: true } & ImplementationCoordinatorLaunchResult)
  | { started: false; reason: string };

function resolvedArtifactPath(
  path: string,
  resolver: ((path: string) => string) | undefined,
): string {
  if (resolver !== undefined) return resolver(path);
  return isAbsolute(path) ? path : resolve(path);
}

function failure(reason: string): FreshImplementationLaunchResult {
  return { started: false, reason };
}

function approvalFromState(
  state: RootWorkflowState,
): Record<string, unknown> | undefined {
  if (
    state.approval !== true ||
    state.approvedPlanHash === undefined ||
    state.reviewId === undefined
  ) {
    return undefined;
  }
  return {
    approvedPlanHash: state.approvedPlanHash,
    reviewId: state.reviewId,
    approval: true,
    ...(state.approvalFeedback === undefined
      ? {}
      : { approvalFeedback: state.approvalFeedback }),
  };
}

function referencesFromSnapshot(
  snapshot: PlanReviewSnapshot,
  handoffPath: string,
): Pick<
  ImplementationCoordinatorInput,
  "planArtifactRef" | "planningHandoffRef"
> {
  return {
    planArtifactRef: {
      kind: "managed",
      path: snapshot.planPath,
      mediaType: "text/markdown",
    },
    planningHandoffRef: {
      kind: "managed",
      path: handoffPath,
      mediaType: "application/json",
    },
  };
}

function samePlanningRun(
  snapshot: PlanReviewSnapshot,
  state: RootWorkflowState,
): boolean {
  return (
    snapshot.handoff.planningRunId === undefined ||
    snapshot.handoff.planningRunId === state.planningRunId
  );
}

async function stopOrphan(
  stop: ((runId: string) => Promise<unknown>) | undefined,
  runId: string,
): Promise<void> {
  try {
    await stop?.(runId);
  } catch {
    // The caller still fails closed when an orphan cannot be stopped.
  }
}

export async function launchFreshImplementationCoordinator(
  options: FreshImplementationLaunchOptions,
): Promise<FreshImplementationLaunchResult> {
  const state = options.state ?? options.registry.getState();
  if (state === undefined) return failure("No Root workflow exists");
  if (state.phase !== "PLAN_REVIEW") {
    return failure("Implementation launch requires PLAN_REVIEW");
  }
  if (state.planningStatus !== "COMPLETED") {
    return failure("Planning Coordinator is not completed");
  }
  if (!isValidRunId(state.planningRunId)) {
    return failure("Planning Coordinator run identity is missing");
  }
  if (
    state.implementationStatus !== "NOT_STARTED" ||
    state.implementationRunId !== undefined
  ) {
    return failure("An Implementation Coordinator is already active");
  }
  if (state.pendingInteraction !== undefined) {
    return failure("A Root interaction is still pending");
  }
  if (state.planningHandoffRef === undefined) {
    return failure("Planning Handoff is missing");
  }

  const request = options.registry.getActiveWorkflowRequest();
  if (
    request === undefined ||
    request.workflowId !== state.workflowId ||
    request.workflowType !== state.workflowType
  ) {
    return failure("Workflow request context is unavailable");
  }

  let snapshot: PlanReviewSnapshot;
  try {
    snapshot = await readPlanReviewSnapshot(
      state,
      options.readFile,
      options.resolveArtifactPath,
    );
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : "Planning artifacts are invalid",
    );
  }

  if (!samePlanningRun(snapshot, state)) {
    return failure("Planning Handoff run identity does not match Root state");
  }

  const approvalCandidate = approvalFromState(state);
  if (approvalCandidate === undefined) {
    return failure("Root-owned Approval Identity is missing");
  }
  const approval = validateApprovalIdentity(
    approvalCandidate,
    snapshot.planHash.value,
    snapshot.handoff,
  );
  if (!approval.valid) {
    return failure(approval.errors.join("; "));
  }

  const handoffPath = resolvedArtifactPath(
    state.planningHandoffRef.path,
    options.resolveArtifactPath,
  );
  const references = referencesFromSnapshot(snapshot, handoffPath);
  const input: ImplementationCoordinatorInput = {
    contractVersion: 1,
    workflow: {
      workflowId: state.workflowId,
      workflowType: state.workflowType,
      cwd: request.cwd,
    },
    ...references,
    approval: approval.value,
    runtime: {
      timeoutMs: TIMEOUTS.coordinatorTimeoutMs,
      maxSubagentDepth: 2,
      outputMode: "file-only",
    },
  };
  const validatedInput = validateImplementationCoordinatorInput(input);
  if (!validatedInput.valid) {
    return failure(validatedInput.errors.join("; "));
  }

  let launch: ImplementationCoordinatorLaunchResult;
  try {
    launch = await options.spawnImplementationCoordinator(validatedInput.value);
  } catch (error) {
    return failure(
      error instanceof Error
        ? error.message
        : "Fresh Implementation Coordinator could not be started",
    );
  }
  if (
    !isRecord(launch) ||
    !isValidRequestId(launch.requestId) ||
    !isValidRunId(launch.runId)
  ) {
    return failure("Implementation Coordinator launch identity is invalid");
  }
  if (launch.runId === state.planningRunId) {
    await stopOrphan(options.stopImplementationCoordinator, launch.runId);
    return failure("Implementation Coordinator reused the Planning run ID");
  }

  return {
    started: true,
    requestId: launch.requestId,
    runId: launch.runId,
  };
}
