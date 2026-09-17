import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createRunId,
  isNormalizedOpaqueId,
  type RunId,
} from "../core/index.ts";
import { isRecord } from "../core/validation.ts";
import type { SubagentRpcEventBus } from "./subagents-rpc.ts";

export const SUBAGENT_RESULT_INTERCOM_EVENT =
  "subagent:result-intercom" as const;
export const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT =
  "subagent:result-intercom-delivery" as const;
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete" as const;

const SUBAGENT_CONFIG_RELATIVE_PATH = [
  "extensions",
  "subagent",
  "config.json",
] as const;
const ASYNC_TERMINAL_STATES = new Set([
  "complete",
  "failed",
  "partial",
  "paused",
  "stopped",
  "rejected",
]);
const MAX_PENDING_ACKNOWLEDGEMENTS = 128;

type ResultDeliveryEnvironment = Partial<
  Pick<NodeJS.ProcessEnv, "PI_CODING_AGENT_DIR" | "HOME" | "USERPROFILE">
>;

export type ResultDeliveryPreflightFailure =
  | "MISSING_CONFIG"
  | "UNREADABLE_CONFIG"
  | "INVALID_JSON"
  | "INVALID_CONFIGURATION";

export type ResultDeliveryPreflightResult =
  | { ready: true; configPath: string }
  | {
      ready: false;
      configPath: string;
      reason: ResultDeliveryPreflightFailure;
    };

export interface ResultDeliveryPreflightOptions {
  configPath?: string;
  environment?: ResultDeliveryEnvironment;
  readFile?: (configPath: string) => string;
}

function resolveHomeDirectory(environment: ResultDeliveryEnvironment): string {
  return environment.HOME || environment.USERPROFILE || os.homedir();
}

export function resolvePiSubagentsConfigPath(
  environment: ResultDeliveryEnvironment = process.env,
): string {
  const home = resolveHomeDirectory(environment);
  const configuredAgentDir = environment.PI_CODING_AGENT_DIR;
  const agentDir =
    configuredAgentDir === "~"
      ? home
      : configuredAgentDir?.startsWith("~/") ||
          configuredAgentDir?.startsWith("~\\")
        ? path.join(home, configuredAgentDir.slice(2))
        : configuredAgentDir || path.join(home, ".pi", "agent");
  return path.join(agentDir, ...SUBAGENT_CONFIG_RELATIVE_PATH);
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function preflightResultDelivery(
  options: ResultDeliveryPreflightOptions = {},
): ResultDeliveryPreflightResult {
  const configPath =
    options.configPath ?? resolvePiSubagentsConfigPath(options.environment);
  const readFile =
    options.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));

  let raw: string;
  try {
    raw = readFile(configPath);
  } catch (error) {
    return {
      ready: false,
      configPath,
      reason:
        errorCode(error) === "ENOENT" ? "MISSING_CONFIG" : "UNREADABLE_CONFIG",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ready: false, configPath, reason: "INVALID_JSON" };
  }

  if (!isRecord(parsed) || !isRecord(parsed.intercomBridge)) {
    return { ready: false, configPath, reason: "INVALID_CONFIGURATION" };
  }
  const bridge = parsed.intercomBridge;
  if (bridge.mode !== "always" || bridge.resultDelivery !== true) {
    return { ready: false, configPath, reason: "INVALID_CONFIGURATION" };
  }

  return { ready: true, configPath };
}

export type ResultDeliveryStatus =
  | "delivered"
  | "failed"
  | "missing"
  | "conflict";

type AckFailureStatus = Exclude<ResultDeliveryStatus, "delivered" | "missing">;

type DeliveryAttempt = {
  requestId: string;
  acknowledged?: boolean;
  conflict: boolean;
};

export interface ResultDeliveryObservationOptions {
  sessionId?: string;
  isRelevantRun?: (runId: RunId) => boolean;
  onAckFailure?: (runId: RunId, status: AckFailureStatus) => void;
  onUntrustedCompletion?: (runId: RunId, status: ResultDeliveryStatus) => void;
}

export interface ResultDeliveryObservation {
  statusFor(runId: unknown): ResultDeliveryStatus;
  isCompletionTrusted(runId: unknown): boolean;
  dispose(): void;
}

function runIdFrom(value: unknown): RunId | undefined {
  if (!isNormalizedOpaqueId(value)) return undefined;
  try {
    return createRunId(value);
  } catch {
    return undefined;
  }
}

function requestIdFrom(value: unknown): string | undefined {
  return isNormalizedOpaqueId(value) ? value : undefined;
}

function isRelevant(
  runId: RunId,
  predicate: ResultDeliveryObservationOptions["isRelevantRun"],
): boolean {
  if (predicate === undefined) return true;
  try {
    return predicate(runId);
  } catch {
    return false;
  }
}

function isSessionEvent(
  value: Record<string, unknown>,
  sessionId: string | undefined,
): boolean {
  return sessionId === undefined || value.sessionId === sessionId;
}

export function registerResultDeliveryObservation(
  events: SubagentRpcEventBus,
  options: ResultDeliveryObservationOptions = {},
): ResultDeliveryObservation {
  const attemptsByRun = new Map<RunId, DeliveryAttempt>();
  const runsByRequest = new Map<string, RunId>();
  const acknowledgementsBeforeResult = new Map<string, boolean | "conflict">();
  const completedRuns = new Set<RunId>();
  const notifiedAckFailures = new Map<RunId, AckFailureStatus>();
  let disposed = false;

  const rememberAcknowledgement = (
    requestId: string,
    value: boolean | "conflict",
  ): void => {
    if (
      !acknowledgementsBeforeResult.has(requestId) &&
      acknowledgementsBeforeResult.size >= MAX_PENDING_ACKNOWLEDGEMENTS
    ) {
      const oldest = acknowledgementsBeforeResult.keys().next().value;
      if (typeof oldest === "string")
        acknowledgementsBeforeResult.delete(oldest);
    }
    acknowledgementsBeforeResult.set(requestId, value);
  };

  const statusForRun = (runId: RunId): ResultDeliveryStatus => {
    const attempt = attemptsByRun.get(runId);
    if (attempt === undefined || attempt.conflict)
      return attempt?.conflict ? "conflict" : "missing";
    if (attempt.acknowledged === true) return "delivered";
    if (attempt.acknowledged === false) return "failed";
    return "missing";
  };

  const notifyAckFailure = (runId: RunId): void => {
    const status = statusForRun(runId);
    if (status !== "failed" && status !== "conflict") return;
    if (notifiedAckFailures.get(runId) === status) return;
    notifiedAckFailures.set(runId, status);
    options.onAckFailure?.(runId, status);
  };

  const markConflict = (runId: RunId): void => {
    const attempt = attemptsByRun.get(runId);
    if (attempt === undefined || completedRuns.has(runId)) return;
    attempt.conflict = true;
    notifyAckFailure(runId);
  };

  const onResultIntercom = (value: unknown): void => {
    if (disposed || !isRecord(value)) return;
    const requestId = requestIdFrom(value.requestId);
    const runId = runIdFrom(value.runId);
    if (
      requestId === undefined ||
      runId === undefined ||
      completedRuns.has(runId) ||
      !isRelevant(runId, options.isRelevantRun)
    ) {
      return;
    }

    const mappedRunId = runsByRequest.get(requestId);
    if (mappedRunId !== undefined && mappedRunId !== runId) {
      markConflict(mappedRunId);
    }

    const existing = attemptsByRun.get(runId);
    if (existing !== undefined) {
      if (existing.requestId !== requestId) {
        markConflict(runId);
      }
      return;
    }

    const attempt: DeliveryAttempt = {
      requestId,
      conflict: mappedRunId !== undefined && mappedRunId !== runId,
    };
    const earlyAcknowledgement = acknowledgementsBeforeResult.get(requestId);
    if (earlyAcknowledgement !== undefined) {
      acknowledgementsBeforeResult.delete(requestId);
      if (earlyAcknowledgement === "conflict") {
        attempt.conflict = true;
      } else {
        attempt.acknowledged = earlyAcknowledgement;
      }
    }
    attemptsByRun.set(runId, attempt);
    runsByRequest.set(requestId, runId);
    notifyAckFailure(runId);
  };

  const onDeliveryAcknowledgement = (value: unknown): void => {
    if (disposed || !isRecord(value)) return;
    const requestId = requestIdFrom(value.requestId);
    const delivered = value.delivered;
    if (requestId === undefined || typeof delivered !== "boolean") return;

    const runId = runsByRequest.get(requestId);
    if (runId === undefined) {
      const previous = acknowledgementsBeforeResult.get(requestId);
      if (previous === undefined) {
        rememberAcknowledgement(requestId, delivered);
      } else if (previous !== delivered) {
        rememberAcknowledgement(requestId, "conflict");
      }
      return;
    }

    if (completedRuns.has(runId)) return;
    const attempt = attemptsByRun.get(runId);
    if (attempt === undefined) return;
    if (attempt.acknowledged === undefined) {
      attempt.acknowledged = delivered;
    } else if (attempt.acknowledged !== delivered) {
      attempt.conflict = true;
    }
    notifyAckFailure(runId);
  };

  const onAsyncComplete = (value: unknown): void => {
    if (
      disposed ||
      !isRecord(value) ||
      !isSessionEvent(value, options.sessionId)
    ) {
      return;
    }
    const runId = runIdFrom(value.runId);
    if (
      runId === undefined ||
      typeof value.state !== "string" ||
      !ASYNC_TERMINAL_STATES.has(value.state) ||
      completedRuns.has(runId) ||
      !isRelevant(runId, options.isRelevantRun)
    ) {
      return;
    }

    completedRuns.add(runId);
    const attempt = attemptsByRun.get(runId);
    if (value.intercomDelivered === false && attempt?.acknowledged === true) {
      attempt.conflict = true;
    }
    const status = statusForRun(runId);
    if (status !== "delivered") {
      options.onUntrustedCompletion?.(runId, status);
    }
  };

  const removeResult = events.on(
    SUBAGENT_RESULT_INTERCOM_EVENT,
    onResultIntercom,
  );
  const removeAcknowledgement = events.on(
    SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
    onDeliveryAcknowledgement,
  );
  const removeCompletion = events.on(
    SUBAGENT_ASYNC_COMPLETE_EVENT,
    onAsyncComplete,
  );

  return {
    statusFor(runId: unknown): ResultDeliveryStatus {
      const normalized = runIdFrom(runId);
      return normalized === undefined ? "missing" : statusForRun(normalized);
    },
    isCompletionTrusted(runId: unknown): boolean {
      return this.statusFor(runId) === "delivered";
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      removeResult();
      removeAcknowledgement();
      removeCompletion();
      attemptsByRun.clear();
      runsByRequest.clear();
      acknowledgementsBeforeResult.clear();
      completedRuns.clear();
      notifiedAckFailures.clear();
    },
  };
}
