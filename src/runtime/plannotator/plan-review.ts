import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  validatePlanningDecisionForApproval,
  type PlanningDecisionV1,
} from "../../core/planning/planning-decision";
import { renderPlan } from "../../core/planning/render-plan";
import {
  requestPlannotator,
  type PiEventBus,
  waitForPlannotatorReviewResult,
} from "./request";

export interface PlanReviewInput {
  missionId: string;
  planningDecision: PlanningDecisionV1;
  round: number;
}

export interface PlanReviewOutput {
  approved: boolean;
  reviewId?: string;
  planPath: string;
  feedback?: string;
}

interface PlanReviewStart {
  status: "pending";
  reviewId: string;
}

interface ReviewStatusPending {
  status: "pending";
}

interface ReviewStatusMissing {
  status: "missing";
}

interface ReviewStatusCompleted {
  status: "completed";
  reviewId: string;
  approved: boolean;
  feedback?: string;
}

type ReviewStatus =
  | ReviewStatusPending
  | ReviewStatusMissing
  | ReviewStatusCompleted;

const MISSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanReviewStart(value: unknown): value is PlanReviewStart {
  return (
    isRecord(value) &&
    value.status === "pending" &&
    typeof value.reviewId === "string" &&
    value.reviewId.trim().length > 0
  );
}

function isReviewStatus(value: unknown): value is ReviewStatus {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "pending" || value.status === "missing") return true;
  return (
    value.status === "completed" &&
    typeof value.reviewId === "string" &&
    typeof value.approved === "boolean" &&
    (value.feedback === undefined || typeof value.feedback === "string")
  );
}

function planPath(cwd: string, missionId: string, round: number): string {
  if (!MISSION_ID_PATTERN.test(missionId)) {
    throw new Error("missionId must be a safe native Mission identifier.");
  }
  if (!Number.isInteger(round) || round < 1) {
    throw new Error("plan review round must be a positive integer.");
  }
  return join(cwd, ".pi", "pi-workflow", missionId, `plan-r${round}.md`);
}

function reviewOutput(
  path: string,
  reviewId: string,
  approved: boolean,
  feedback?: string,
): PlanReviewOutput {
  return {
    approved,
    reviewId,
    planPath: path,
    ...(feedback === undefined ? {} : { feedback }),
  };
}

function statusOutput(
  path: string,
  status: ReviewStatusCompleted,
): PlanReviewOutput {
  return reviewOutput(path, status.reviewId, status.approved, status.feedback);
}

async function recoverReviewStatus(
  events: PiEventBus,
  reviewId: string,
  path: string,
  signal?: AbortSignal,
): Promise<PlanReviewOutput | undefined> {
  const status = await requestPlannotator<unknown>(
    events,
    "review-status",
    { reviewId },
    signal,
  );
  if (!isReviewStatus(status)) {
    throw new Error("Invalid Plannotator review-status response.");
  }
  if (status.status === "completed") {
    if (status.reviewId !== reviewId) {
      throw new Error("Plannotator review-status returned the wrong reviewId.");
    }
    return statusOutput(path, status);
  }
  if (status.status === "missing") {
    throw new Error(`Plannotator review ${reviewId} is missing.`);
  }
  return undefined;
}

export async function runPlanReview(
  pi: Pick<ExtensionAPI, "events">,
  cwd: string,
  input: PlanReviewInput,
  signal?: AbortSignal,
): Promise<PlanReviewOutput> {
  const validation = validatePlanningDecisionForApproval(
    input.planningDecision,
  );
  if (!validation.ok) {
    throw new Error(
      validation.errors
        .map((error) => `${error.path}: ${error.message}`)
        .join("; "),
    );
  }

  const path = planPath(cwd, input.missionId, input.round);
  const content = renderPlan(validation.value);
  await mkdir(join(cwd, ".pi", "pi-workflow", input.missionId), {
    recursive: true,
  });
  await writeFile(path, content, "utf8");

  const started = await requestPlannotator<unknown>(
    pi.events,
    "plan-review",
    {
      planFilePath: path,
      planContent: content,
      origin: "pi-workflow",
    },
    signal,
  );
  if (!isPlanReviewStart(started)) {
    throw new Error("Invalid Plannotator plan-review response.");
  }

  const waitController = new AbortController();
  const forwardAbort = () => waitController.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const reviewResultPromise = waitForPlannotatorReviewResult(
    pi.events,
    started.reviewId,
    waitController.signal,
  );

  try {
    let recovered: PlanReviewOutput | undefined;
    try {
      recovered = await recoverReviewStatus(
        pi.events,
        started.reviewId,
        path,
        signal,
      );
    } catch (error) {
      waitController.abort();
      await reviewResultPromise.catch(() => undefined);
      throw error;
    }
    if (recovered) {
      waitController.abort();
      await reviewResultPromise.catch(() => undefined);
      return recovered;
    }

    const result = await reviewResultPromise;
    return reviewOutput(
      path,
      result.reviewId,
      result.approved,
      result.feedback,
    );
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
    waitController.abort();
  }
}
