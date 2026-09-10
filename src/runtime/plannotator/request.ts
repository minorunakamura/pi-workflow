import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request" as const;
export const PLANNOTATOR_REVIEW_RESULT_CHANNEL =
  "plannotator:review-result" as const;
export const PLANNOTATOR_REQUEST_TIMEOUT_MS = 5_000;

export type PiEventBus = Pick<ExtensionAPI, "events">["events"];
export type PlannotatorAction = "plan-review" | "review-status";

interface PlannotatorHandledResponse<T> {
  status: "handled";
  result: T;
}

interface PlannotatorUnavailableResponse {
  status: "unavailable";
  error?: string;
}

interface PlannotatorErrorResponse {
  status: "error";
  error: string;
}

type PlannotatorResponse<T> =
  | PlannotatorHandledResponse<T>
  | PlannotatorUnavailableResponse
  | PlannotatorErrorResponse;

interface PlannotatorRequest {
  requestId: string;
  action: PlannotatorAction;
  payload: Record<string, unknown>;
  respond: (response: PlannotatorResponse<unknown>) => void;
}

export interface PlannotatorReviewResult {
  reviewId: string;
  approved: boolean;
  feedback?: string;
  savedPath?: string;
  agentSwitch?: string;
  permissionMode?: string;
}

const NOOP = () => {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHandledResponse<T>(
  value: unknown,
): value is PlannotatorHandledResponse<T> {
  return isRecord(value) && value.status === "handled" && "result" in value;
}

function errorMessage(value: unknown): string {
  if (!isRecord(value)) return "Invalid Plannotator response.";
  if (typeof value.error === "string" && value.error.trim()) return value.error;
  return "Invalid Plannotator response.";
}

export function requestPlannotator<T>(
  events: PiEventBus,
  action: PlannotatorAction,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else if (value === undefined) {
        reject(new Error("Plannotator returned an empty result."));
      } else {
        resolve(value);
      }
    };

    const onAbort = () => finish(new Error("Plannotator request was aborted."));

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () =>
        finish(
          new Error(
            `Plannotator did not respond within ${PLANNOTATOR_REQUEST_TIMEOUT_MS} ms.`,
          ),
        ),
      PLANNOTATOR_REQUEST_TIMEOUT_MS,
    );

    const request: PlannotatorRequest = {
      requestId: randomUUID(),
      action,
      payload,
      respond: (response) => {
        if (isHandledResponse<T>(response)) {
          finish(undefined, response.result);
          return;
        }
        finish(new Error(errorMessage(response)));
      },
    };

    try {
      events.emit(PLANNOTATOR_REQUEST_CHANNEL, request);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function isReviewResult(
  value: unknown,
  reviewId: string,
): value is PlannotatorReviewResult {
  if (!isRecord(value) || value.reviewId !== reviewId) return false;
  const allowedKeys = [
    "reviewId",
    "approved",
    "feedback",
    "savedPath",
    "agentSwitch",
    "permissionMode",
  ];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key)))
    return false;
  return (
    typeof value.approved === "boolean" &&
    (value.feedback === undefined || typeof value.feedback === "string") &&
    (value.savedPath === undefined || typeof value.savedPath === "string") &&
    (value.agentSwitch === undefined ||
      typeof value.agentSwitch === "string") &&
    (value.permissionMode === undefined ||
      typeof value.permissionMode === "string")
  );
}

export function waitForPlannotatorReviewResult(
  events: PiEventBus,
  reviewId: string,
  signal?: AbortSignal,
): Promise<PlannotatorReviewResult> {
  return new Promise<PlannotatorReviewResult>((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = NOOP;

    const cleanup = () => {
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (error?: Error, value?: PlannotatorReviewResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else if (value === undefined) {
        reject(new Error("Plannotator returned an empty review result."));
      } else {
        resolve(value);
      }
    };

    const onAbort = () =>
      finish(new Error("Plannotator review result wait was aborted."));

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    unsubscribe = events.on(PLANNOTATOR_REVIEW_RESULT_CHANNEL, (data) => {
      if (!isRecord(data) || data.reviewId !== reviewId) return;
      if (!isReviewResult(data, reviewId)) {
        finish(new Error("Invalid Plannotator review result."));
        return;
      }
      finish(undefined, data);
    });
  });
}
