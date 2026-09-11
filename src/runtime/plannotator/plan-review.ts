import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MAX_PLAN_REVIEW_ROUNDS } from "../../core/state/contracts";
import {
  validateReferenceValue,
  type ReferenceValue,
} from "../../core/state/references";
import { requestPlannotator, waitForPlannotatorReviewResult } from "./request";

export interface PlanReviewInput {
  missionId: string;
  round: number;
  planRef: ReferenceValue;
}

export interface PlanReviewOutput {
  approved: boolean;
  reviewId?: ReferenceValue;
  planRef: ReferenceValue;
  feedbackRef?: ReferenceValue;
}

interface PlanReviewStart {
  status: "pending";
  reviewId: ReferenceValue;
}

interface ReviewStatusPending {
  status: "pending";
}

interface ReviewStatusMissing {
  status: "missing";
}

interface ReviewStatusCompleted {
  status: "completed";
  reviewId: ReferenceValue;
  approved: boolean;
  feedback?: string;
}

type ReviewStatus =
  | ReviewStatusPending
  | ReviewStatusMissing
  | ReviewStatusCompleted;

const FEEDBACK_ARTIFACT_ROOT = join(tmpdir(), "pi-workflow", "feedback");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertReference(
  value: unknown,
  label: string,
): asserts value is ReferenceValue {
  const validation = validateReferenceValue(value);
  if (!validation.ok) {
    throw new Error(
      `${label} is invalid: ${validation.errors
        .map((error) => `${error.path}: ${error.message}`)
        .join("; ")}`,
    );
  }
}

function validatePlanReviewInput(input: PlanReviewInput): void {
  if (!isRecord(input)) throw new Error("Plan Review input must be an object.");
  const allowedKeys = ["missionId", "round", "planRef"];
  if (
    Object.keys(input).length !== allowedKeys.length ||
    Object.keys(input).some((key) => !allowedKeys.includes(key))
  ) {
    throw new Error("Plan Review input contains unknown fields.");
  }
  assertReference(input.missionId, "missionId");
  if (
    !Number.isInteger(input.round) ||
    input.round < 1 ||
    input.round > MAX_PLAN_REVIEW_ROUNDS
  ) {
    throw new Error(
      `Plan Review round must be an integer from 1 to ${MAX_PLAN_REVIEW_ROUNDS}.`,
    );
  }
  assertReference(input.planRef, "planRef");
}

function isPlanReviewStart(value: unknown): value is PlanReviewStart {
  if (!isRecord(value) || value.status !== "pending") return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    keys.includes("status") &&
    keys.includes("reviewId") &&
    validateReferenceValue(value.reviewId).ok
  );
}

function isReviewStatus(value: unknown): value is ReviewStatus {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "pending" || value.status === "missing") {
    return Object.keys(value).length === 1;
  }
  const allowedKeys = [
    "status",
    "reviewId",
    "approved",
    "feedback",
    "savedPath",
    "agentSwitch",
    "permissionMode",
  ];
  return (
    value.status === "completed" &&
    Object.keys(value).every((key) => allowedKeys.includes(key)) &&
    validateReferenceValue(value.reviewId).ok &&
    typeof value.approved === "boolean" &&
    (value.feedback === undefined || typeof value.feedback === "string") &&
    (value.savedPath === undefined || typeof value.savedPath === "string") &&
    (value.agentSwitch === undefined ||
      typeof value.agentSwitch === "string") &&
    (value.permissionMode === undefined ||
      typeof value.permissionMode === "string")
  );
}

/** Resolve only the explicitly supplied canonical Plan Artifact reference. */
export async function readPlanArtifact(
  planRef: ReferenceValue,
): Promise<string> {
  assertReference(planRef, "planRef");

  let details: Awaited<ReturnType<typeof stat>>;
  try {
    details = await stat(planRef);
  } catch (error) {
    throw new Error(
      `Plan Artifact cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!details.isFile()) {
    throw new Error("Plan Artifact reference must resolve to a regular file.");
  }

  try {
    const content = await readFile(planRef, "utf8");
    if (!content.trim()) throw new Error("Plan Artifact is empty.");
    return content;
  } catch (error) {
    throw new Error(
      `Plan Artifact cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Write feedback into a package-owned Artifact and return only its reference. */
export async function writeFeedbackArtifact(
  feedback: string,
): Promise<ReferenceValue> {
  if (typeof feedback !== "string" || !feedback.trim()) {
    throw new Error("Rejected Plan Review requires non-empty feedback.");
  }

  await mkdir(FEEDBACK_ARTIFACT_ROOT, { recursive: true });
  const directory = await mkdtemp(join(FEEDBACK_ARTIFACT_ROOT, "review-"));
  const path = join(directory, "feedback.md");
  await writeFile(path, feedback, { encoding: "utf8", mode: 0o600 });
  assertReference(path, "feedbackRef");
  return path;
}

async function toPlanReviewOutput(
  planRef: ReferenceValue,
  result: { reviewId: ReferenceValue; approved: boolean; feedback?: string },
): Promise<PlanReviewOutput> {
  assertReference(result.reviewId, "reviewId");
  if (result.approved === true) {
    return { approved: true, reviewId: result.reviewId, planRef };
  }
  if (typeof result.feedback !== "string" || !result.feedback.trim()) {
    throw new Error("Explicit Plan Review rejection did not include feedback.");
  }
  const feedbackRef = await writeFeedbackArtifact(result.feedback);
  return {
    approved: false,
    reviewId: result.reviewId,
    planRef,
    feedbackRef,
  };
}

export async function recoverPlanReview(
  pi: Pick<ExtensionAPI, "events">,
  input: PlanReviewInput,
  reviewId: ReferenceValue,
  signal?: AbortSignal,
): Promise<PlanReviewOutput | undefined> {
  validatePlanReviewInput(input);
  assertReference(reviewId, "reviewId");
  const status = await requestPlannotator<unknown>(
    pi.events,
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
    return toPlanReviewOutput(input.planRef, {
      reviewId: status.reviewId,
      approved: status.approved,
      ...(status.feedback === undefined ? {} : { feedback: status.feedback }),
    });
  }
  if (status.status === "missing") {
    throw new Error(`Plannotator review ${reviewId} is missing.`);
  }
  return undefined;
}

export async function runPlanReview(
  pi: Pick<ExtensionAPI, "events">,
  input: PlanReviewInput,
  signal?: AbortSignal,
): Promise<PlanReviewOutput> {
  validatePlanReviewInput(input);
  const planContent = await readPlanArtifact(input.planRef);

  const started = await requestPlannotator<unknown>(
    pi.events,
    "plan-review",
    {
      planFilePath: input.planRef,
      planContent,
      origin: "pi-workflow",
    },
    signal,
  );
  if (!isPlanReviewStart(started)) {
    throw new Error("Invalid Plannotator plan-review response.");
  }
  const reviewId = started.reviewId;

  const waitController = new AbortController();
  const forwardAbort = () => waitController.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const reviewResultPromise = waitForPlannotatorReviewResult(
    pi.events,
    reviewId,
    waitController.signal,
  );

  try {
    const result = await reviewResultPromise;
    if (result.reviewId !== reviewId) {
      throw new Error("Plannotator returned the wrong reviewId.");
    }
    return toPlanReviewOutput(input.planRef, result);
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
    waitController.abort();
  }
}
