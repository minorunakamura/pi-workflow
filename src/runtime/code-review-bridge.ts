import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import {
  createRequestId,
  createRunId,
  isActivePhase,
  isValidArtifactRef,
  isValidRequestId,
  isValidRunId,
  isValidWorkflowId,
  TIMEOUTS,
  type ArtifactRef,
  type CodeReviewResultSummary,
  type RequestId,
  type RootWorkflowState,
  type RunId,
  type WorkflowId,
  type WorkflowRequest,
} from "../core/index.ts";
import {
  hasOnlyKeys,
  invalidResult,
  isBoundedString,
  isNormalizedOpaqueId,
  isRecord,
  validResult,
  type ValidationResult,
} from "../core/validation.ts";
import {
  HUMAN_DECISION_NAMESPACE,
  INTERCOM_EXTENSION_REGISTER_EVENT,
  type IntercomExtensionChannel,
  type IntercomExtensionEvent,
  type IntercomExtensionRegistration,
} from "./human-decision-bridge.ts";
export type {
  IntercomExtensionChannel,
  IntercomExtensionEvent,
  IntercomExtensionRegistration,
} from "./human-decision-bridge.ts";
import type { RegistryTransitionResult } from "./root-lifecycle.ts";

export { INTERCOM_EXTENSION_REGISTER_EVENT } from "./human-decision-bridge.ts";

export const CODE_REVIEW_NAMESPACE = HUMAN_DECISION_NAMESPACE;
export const CODE_REVIEW_REQUEST_KIND = "code-review-request" as const;
export const CODE_REVIEW_RESPONSE_KIND = "code-review-response" as const;
const CODE_REVIEW_BINDING_REQUEST_KIND = "code-review-binding-request" as const;
const CODE_REVIEW_BINDING_RESPONSE_KIND =
  "code-review-binding-response" as const;

export const PLANNOTATOR_REQUEST_EVENT = "plannotator:request" as const;
export const CODE_REVIEW_TOOL_NAME = "pi_workflow_code_review" as const;

const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_ANNOTATIONS = 128;
const MAX_COMPLETED_REQUESTS = 64;
const MAX_CONFLICT_RECORDS = 64;

export type CodeReviewStatus =
  | "approved"
  | "rejected"
  | "unavailable"
  | "timeout"
  | "failed";

export interface CodeReviewBridgeRequest {
  version: 1;
  kind: typeof CODE_REVIEW_REQUEST_KIND;
  workflowId: WorkflowId;
  requestId: RequestId;
  originSessionId: string;
  coordinatorRunId: RunId;
  cwd: string;
}

export interface CodeReviewBridgeResponse {
  version: 1;
  kind: typeof CODE_REVIEW_RESPONSE_KIND;
  workflowId: WorkflowId;
  requestId: RequestId;
  recipientSessionId: string;
  status: CodeReviewStatus;
  approved: boolean;
  feedback?: string;
  annotations?: readonly unknown[];
  feedbackRef?: ArtifactRef;
  annotationsRef?: ArtifactRef;
  error?: { code: string; message: string };
}

export interface CodeReviewPayload {
  cwd: string;
  useLocal: true;
}

interface PlannotatorRequest {
  requestId: string;
  action: "code-review";
  payload: CodeReviewPayload;
  respond: (response: unknown) => void;
}

interface PlannotatorCodeReviewResult {
  approved: boolean;
  feedback?: string;
  annotations?: readonly unknown[];
}

export interface CodeReviewEventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

export interface CodeReviewRegistry {
  getState(): RootWorkflowState | undefined;
  getActiveWorkflowRequest?(): WorkflowRequest | undefined;
  setCodeReviewPending(
    requestId: unknown,
    coordinatorRunId: unknown,
  ): RegistryTransitionResult;
  recordCodeReviewResult(result: unknown): RegistryTransitionResult;
  transition(to: "FAILED"): RegistryTransitionResult;
}

export interface CodeReviewIntercomHost {
  getIntercomChannel(): IntercomExtensionChannel | undefined;
  addIntercomEventHandler(
    handler: (event: IntercomExtensionEvent) => void,
  ): () => void;
}

export interface CodeReviewRootBridgeOptions {
  events: CodeReviewEventBus;
  registry: CodeReviewRegistry;
  sessionId: string;
  timeoutMs?: number;
  intercom?: CodeReviewIntercomHost;
}

export interface CodeReviewChildRequestInput {
  workflowId: unknown;
  cwd: unknown;
  coordinatorRunId?: unknown;
}

export interface CodeReviewToolInput {
  workflowId: string;
  coordinatorRunId?: string;
}

export type CodeReviewToolParameters = Static<
  typeof CODE_REVIEW_TOOL_PARAMETERS
>;

export type CodeReviewBridgeErrorCode =
  | "INVALID_REQUEST"
  | "BRIDGE_UNAVAILABLE"
  | "BRIDGE_ABORTED"
  | "INVALID_RESPONSE"
  | "RESPONSE_CONFLICT"
  | "SHUTDOWN";

export class CodeReviewBridgeError extends Error {
  public readonly code: CodeReviewBridgeErrorCode;

  public constructor(code: CodeReviewBridgeErrorCode, message: string) {
    super(message);
    this.name = "CodeReviewBridgeError";
    this.code = code;
  }
}

export interface CodeReviewConflictRecord {
  requestId: string;
  workflowId: string;
  phase: "pending" | "completed";
  reason: "fingerprint-mismatch";
}

interface CodeReviewBindingRequest {
  version: 1;
  kind: typeof CODE_REVIEW_BINDING_REQUEST_KIND;
  workflowId: WorkflowId;
  requestId: RequestId;
  originSessionId: string;
}

interface CodeReviewBindingResponse {
  version: 1;
  kind: typeof CODE_REVIEW_BINDING_RESPONSE_KIND;
  workflowId: WorkflowId;
  requestId: RequestId;
  recipientSessionId: string;
  coordinatorRunId: RunId;
}

interface PreparedCodeReviewRequest {
  workflowId: WorkflowId;
  cwd: string;
  coordinatorRunId?: RunId;
}

interface ParsedPlannotatorResponse {
  kind: "result" | "failure";
  result?: PlannotatorCodeReviewResult;
  status?: Exclude<CodeReviewStatus, "approved" | "rejected">;
  error?: { code: string; message: string };
}

interface PendingRootReview {
  request: CodeReviewBridgeRequest;
  fingerprint: string;
  timer?: ReturnType<typeof setTimeout>;
  settling: boolean;
  settled: boolean;
  responseFingerprint?: string;
}

interface CompletedRootReview {
  fingerprint: string;
  originSessionId: string;
  response: CodeReviewBridgeResponse;
}

interface PendingChildReview {
  request: CodeReviewBridgeRequest;
  resolve: (response: CodeReviewBridgeResponse) => void;
  reject: (error: CodeReviewBridgeError) => void;
  removeAbortListener: () => void;
}

interface PendingBinding {
  workflowId: WorkflowId;
  resolve: (runId: RunId) => void;
  reject: (error: CodeReviewBridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener: () => void;
}

function setUnref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
}

function isWithinPayloadLimit(value: unknown): boolean {
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    return encoded.byteLength <= MAX_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

function channelIsUsable(channel: IntercomExtensionChannel): boolean {
  try {
    const snapshot = channel.snapshot();
    return snapshot.connected && snapshot.supported;
  } catch {
    return false;
  }
}

function isCurrentRootOwner(
  event: IntercomExtensionEvent,
  channel: IntercomExtensionChannel | undefined,
): boolean {
  if (
    channel === undefined ||
    event.type !== "message" ||
    event.owner === undefined
  ) {
    return false;
  }
  try {
    const snapshot = channel.snapshot();
    const owner = snapshot.owner;
    return (
      snapshot.connected &&
      snapshot.supported &&
      owner !== undefined &&
      owner.sessionId === event.fromSessionId &&
      owner.sessionId === event.owner.sessionId &&
      owner.epoch === event.owner.epoch
    );
  } catch {
    return false;
  }
}

function validateError(
  value: unknown,
): ValidationResult<{ code: string; message: string }> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["code", "message"]) ||
    !isBoundedString(value.code, MAX_TEXT_BYTES, true) ||
    !isBoundedString(value.message, MAX_TEXT_BYTES, true)
  ) {
    return invalidResult("Code Review error is invalid");
  }
  return validResult({ code: value.code, message: value.message });
}

function validateCwd(value: unknown): value is string {
  return isBoundedString(value, 4096, true) && !/[\0\r\n]/u.test(value);
}

export function validateCodeReviewBridgeRequest(
  value: unknown,
): ValidationResult<CodeReviewBridgeRequest> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "kind",
      "workflowId",
      "requestId",
      "originSessionId",
      "coordinatorRunId",
      "cwd",
    ]) ||
    value.version !== 1 ||
    value.kind !== CODE_REVIEW_REQUEST_KIND ||
    !isValidWorkflowId(value.workflowId) ||
    !isValidRequestId(value.requestId) ||
    !isNormalizedOpaqueId(value.originSessionId) ||
    !isValidRunId(value.coordinatorRunId) ||
    !validateCwd(value.cwd)
  ) {
    return invalidResult("Code Review request is invalid");
  }
  const request: CodeReviewBridgeRequest = {
    version: 1,
    kind: CODE_REVIEW_REQUEST_KIND,
    workflowId: value.workflowId,
    requestId: value.requestId,
    originSessionId: value.originSessionId,
    coordinatorRunId: value.coordinatorRunId,
    cwd: value.cwd,
  };
  return isWithinPayloadLimit(request)
    ? validResult(request)
    : invalidResult("Code Review request exceeds the payload limit");
}

export function isCodeReviewBridgeRequest(
  value: unknown,
): value is CodeReviewBridgeRequest {
  return validateCodeReviewBridgeRequest(value).valid;
}

function isCodeReviewStatus(value: unknown): value is CodeReviewStatus {
  return (
    value === "approved" ||
    value === "rejected" ||
    value === "unavailable" ||
    value === "timeout" ||
    value === "failed"
  );
}

export function validateCodeReviewBridgeResponse(
  value: unknown,
  expected?: {
    workflowId?: string;
    requestId?: string;
    recipientSessionId?: string;
  },
): ValidationResult<CodeReviewBridgeResponse> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "kind",
      "workflowId",
      "requestId",
      "recipientSessionId",
      "status",
      "approved",
      "feedback",
      "annotations",
      "feedbackRef",
      "annotationsRef",
      "error",
    ]) ||
    value.version !== 1 ||
    value.kind !== CODE_REVIEW_RESPONSE_KIND ||
    !isValidWorkflowId(value.workflowId) ||
    !isValidRequestId(value.requestId) ||
    !isNormalizedOpaqueId(value.recipientSessionId) ||
    !isCodeReviewStatus(value.status) ||
    typeof value.approved !== "boolean" ||
    (value.status === "approved" && !value.approved) ||
    (value.status !== "approved" && value.approved) ||
    ("feedback" in value && !isBoundedString(value.feedback, MAX_TEXT_BYTES)) ||
    ("annotations" in value && !validateAnnotations(value.annotations).valid) ||
    ("feedbackRef" in value && !isValidArtifactRef(value.feedbackRef)) ||
    ("annotationsRef" in value && !isValidArtifactRef(value.annotationsRef)) ||
    ("error" in value && !validateError(value.error).valid)
  ) {
    return invalidResult("Code Review response is invalid");
  }
  if (
    expected?.workflowId !== undefined &&
    value.workflowId !== expected.workflowId
  ) {
    return invalidResult("Code Review response workflow does not match");
  }
  if (
    expected?.requestId !== undefined &&
    value.requestId !== expected.requestId
  ) {
    return invalidResult("Code Review response request does not match");
  }
  if (
    expected?.recipientSessionId !== undefined &&
    value.recipientSessionId !== expected.recipientSessionId
  ) {
    return invalidResult("Code Review response recipient does not match");
  }
  const feedback =
    typeof value.feedback === "string" ? value.feedback : undefined;
  const annotations = Array.isArray(value.annotations)
    ? value.annotations
    : undefined;
  const feedbackRef = isValidArtifactRef(value.feedbackRef)
    ? value.feedbackRef
    : undefined;
  const annotationsRef = isValidArtifactRef(value.annotationsRef)
    ? value.annotationsRef
    : undefined;
  const error = "error" in value ? validateError(value.error) : undefined;
  const response: CodeReviewBridgeResponse = {
    version: 1,
    kind: CODE_REVIEW_RESPONSE_KIND,
    workflowId: value.workflowId,
    requestId: value.requestId,
    recipientSessionId: value.recipientSessionId,
    status: value.status,
    approved: value.approved,
    ...(feedback === undefined ? {} : { feedback }),
    ...(annotations === undefined ? {} : { annotations }),
    ...(feedbackRef === undefined ? {} : { feedbackRef }),
    ...(annotationsRef === undefined ? {} : { annotationsRef }),
    ...(error === undefined || !error.valid ? {} : { error: error.value }),
  };
  return isWithinPayloadLimit(response)
    ? validResult(response)
    : invalidResult("Code Review response exceeds the intercom payload limit");
}

export function isCodeReviewBridgeResponse(
  value: unknown,
): value is CodeReviewBridgeResponse {
  return validateCodeReviewBridgeResponse(value).valid;
}

function validateBindingRequest(
  value: unknown,
): ValidationResult<CodeReviewBindingRequest> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "kind",
      "workflowId",
      "requestId",
      "originSessionId",
    ]) ||
    value.version !== 1 ||
    value.kind !== CODE_REVIEW_BINDING_REQUEST_KIND ||
    !isValidWorkflowId(value.workflowId) ||
    !isValidRequestId(value.requestId) ||
    !isNormalizedOpaqueId(value.originSessionId)
  ) {
    return invalidResult("Code Review binding request is invalid");
  }
  return validResult({
    version: 1,
    kind: CODE_REVIEW_BINDING_REQUEST_KIND,
    workflowId: value.workflowId,
    requestId: value.requestId,
    originSessionId: value.originSessionId,
  });
}

function validateBindingResponse(
  value: unknown,
): ValidationResult<CodeReviewBindingResponse> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "kind",
      "workflowId",
      "requestId",
      "recipientSessionId",
      "coordinatorRunId",
    ]) ||
    value.version !== 1 ||
    value.kind !== CODE_REVIEW_BINDING_RESPONSE_KIND ||
    !isValidWorkflowId(value.workflowId) ||
    !isValidRequestId(value.requestId) ||
    !isNormalizedOpaqueId(value.recipientSessionId) ||
    !isValidRunId(value.coordinatorRunId)
  ) {
    return invalidResult("Code Review binding response is invalid");
  }
  return validResult({
    version: 1,
    kind: CODE_REVIEW_BINDING_RESPONSE_KIND,
    workflowId: value.workflowId,
    requestId: value.requestId,
    recipientSessionId: value.recipientSessionId,
    coordinatorRunId: value.coordinatorRunId,
  });
}

function partialRequestIdentity(
  value: unknown,
):
  | Pick<
      CodeReviewBridgeRequest,
      "workflowId" | "requestId" | "originSessionId"
    >
  | undefined {
  if (
    !isRecord(value) ||
    !isValidWorkflowId(value.workflowId) ||
    !isValidRequestId(value.requestId) ||
    !isNormalizedOpaqueId(value.originSessionId)
  ) {
    return undefined;
  }
  return {
    workflowId: value.workflowId,
    requestId: value.requestId,
    originSessionId: value.originSessionId,
  };
}

function requestFingerprint(request: CodeReviewBridgeRequest): string {
  return JSON.stringify(request);
}

function failureResponse(
  request: Pick<
    CodeReviewBridgeRequest,
    "workflowId" | "requestId" | "originSessionId"
  >,
  status: Exclude<CodeReviewStatus, "approved" | "rejected">,
  code: string,
  message: string,
): CodeReviewBridgeResponse {
  const response: CodeReviewBridgeResponse = {
    version: 1,
    kind: CODE_REVIEW_RESPONSE_KIND,
    workflowId: request.workflowId,
    requestId: request.requestId,
    recipientSessionId: request.originSessionId,
    status,
    approved: false,
    error: { code, message },
  };
  if (isWithinPayloadLimit(response)) return response;
  return {
    version: 1,
    kind: CODE_REVIEW_RESPONSE_KIND,
    workflowId: request.workflowId,
    requestId: request.requestId,
    recipientSessionId: request.originSessionId,
    status: "failed",
    approved: false,
    error: {
      code: "response-too-large",
      message: "Code Review response exceeds the intercom payload limit",
    },
  };
}

function boundedMessage(value: unknown, fallback: string): string {
  const message = value instanceof Error ? value.message : String(value);
  const trimmed = message.trim();
  return isBoundedString(trimmed, MAX_TEXT_BYTES, true) ? trimmed : fallback;
}

function validateAnnotations(
  value: unknown,
): ValidationResult<readonly unknown[]> {
  if (!Array.isArray(value) || value.length > MAX_ANNOTATIONS) {
    return invalidResult("Plannotator Code Review annotations are invalid");
  }
  try {
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
      MAX_PAYLOAD_BYTES
    ) {
      return invalidResult("Plannotator Code Review annotations are too large");
    }
  } catch {
    return invalidResult("Plannotator Code Review annotations are invalid");
  }
  return validResult(value);
}

function validatePlannotatorResult(
  value: unknown,
): ValidationResult<PlannotatorCodeReviewResult> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "approved",
      "feedback",
      "annotations",
      "agentSwitch",
    ]) ||
    typeof value.approved !== "boolean"
  ) {
    return invalidResult("Plannotator Code Review result is invalid");
  }
  if (
    value.feedback !== undefined &&
    !isBoundedString(value.feedback, MAX_TEXT_BYTES)
  ) {
    return invalidResult("Plannotator Code Review feedback is invalid");
  }
  if (value.annotations !== undefined) {
    const annotations = validateAnnotations(value.annotations);
    if (!annotations.valid) return annotations;
  }
  if (
    value.agentSwitch !== undefined &&
    !isBoundedString(value.agentSwitch, 4096, true)
  ) {
    return invalidResult("Plannotator Code Review agent switch is invalid");
  }
  const annotations = Array.isArray(value.annotations)
    ? value.annotations
    : undefined;
  return validResult({
    approved: value.approved,
    ...(value.feedback === undefined ? {} : { feedback: value.feedback }),
    ...(annotations === undefined ? {} : { annotations }),
  });
}

function parsePlannotatorResponse(
  value: unknown,
): ValidationResult<ParsedPlannotatorResponse> {
  if (!isRecord(value)) {
    return invalidResult("Plannotator Code Review response is invalid");
  }
  if (value.status === "unavailable") {
    return validResult({
      kind: "failure",
      status: "unavailable",
      error: {
        code: "plannotator-unavailable",
        message: boundedMessage(value.error, "Plannotator is unavailable"),
      },
    });
  }
  if (value.status === "error") {
    return validResult({
      kind: "failure",
      status: "failed",
      error: {
        code: "plannotator-error",
        message: boundedMessage(value.error, "Plannotator returned an error"),
      },
    });
  }
  if (value.status !== "handled") {
    return invalidResult("Plannotator Code Review response is invalid");
  }
  const result = validatePlannotatorResult(value.result);
  return result.valid
    ? validResult({ kind: "result", result: result.value })
    : invalidResult(...result.errors);
}

export class CodeReviewRootBridge {
  private readonly timeoutMs: number;
  private channel: IntercomExtensionChannel | undefined;
  private removeIntercomEvent: () => void = () => {};
  private pending: PendingRootReview | undefined;
  private disposed = false;
  private readonly completed = new Map<string, CompletedRootReview>();
  private readonly conflicts: CodeReviewConflictRecord[] = [];

  public constructor(private readonly options: CodeReviewRootBridgeOptions) {
    const timeout = options.timeoutMs ?? TIMEOUTS.codeReviewTimeoutMs;
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new RangeError("Code Review timeout must be a positive integer");
    }
    this.timeoutMs = timeout;
    if (options.intercom === undefined) {
      this.registerIntercomChannel();
    } else {
      this.channel = options.intercom.getIntercomChannel();
      this.removeIntercomEvent = options.intercom.addIntercomEventHandler(
        (event) => this.onIntercomEvent(event),
      );
    }
  }

  public hasPendingReview(): boolean {
    return this.pending !== undefined && !this.pending.settled;
  }

  public getConflictRecords(): readonly CodeReviewConflictRecord[] {
    return this.conflicts.map((record) => ({ ...record }));
  }

  public dispose(): void {
    if (this.disposed) return;
    const pending = this.pending;
    if (pending !== undefined && !pending.settled) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.settled = true;
      pending.settling = true;
      this.failWorkflow();
    }
    this.pending = undefined;
    this.disposed = true;
    this.removeIntercomEvent();
    this.removeIntercomEvent = () => {};
    this.channel = undefined;
    this.completed.clear();
    this.conflicts.length = 0;
  }

  private registerIntercomChannel(): void {
    if (!isNormalizedOpaqueId(this.options.sessionId)) return;
    const registration: IntercomExtensionRegistration = {
      namespace: CODE_REVIEW_NAMESPACE,
      ownerEligible: true,
      onReady: (channel) => {
        if (!this.disposed) this.channel = channel;
      },
      onEvent: (event) => this.onIntercomEvent(event),
    };
    try {
      this.options.events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, registration);
    } catch {
      this.channel = undefined;
    }
  }

  private onIntercomEvent(event: IntercomExtensionEvent): void {
    if (
      this.disposed ||
      !isRecord(event) ||
      event.type !== "message" ||
      !isNormalizedOpaqueId(event.fromSessionId)
    ) {
      return;
    }

    const binding = validateBindingRequest(event.payload);
    if (binding.valid) {
      this.handleBindingRequest(event.fromSessionId, binding.value);
      return;
    }
    if (
      isRecord(event.payload) &&
      typeof event.payload.kind === "string" &&
      event.payload.kind !== CODE_REVIEW_REQUEST_KIND
    ) {
      return;
    }

    const parsed = validateCodeReviewBridgeRequest(event.payload);
    if (!parsed.valid) {
      this.respondToInvalidRequest(
        event.fromSessionId,
        event.payload,
        parsed.errors,
      );
      return;
    }
    const request = parsed.value;
    if (request.originSessionId !== event.fromSessionId) return;

    const completed = this.completed.get(request.requestId);
    const fingerprint = requestFingerprint(request);
    if (completed !== undefined) {
      if (
        completed.fingerprint === fingerprint &&
        completed.originSessionId === request.originSessionId
      ) {
        this.publishResponse(completed.response);
      } else {
        this.recordConflict(request, "completed");
      }
      return;
    }

    const pending = this.pending;
    if (pending !== undefined && !pending.settled) {
      if (pending.request.requestId === request.requestId) {
        if (pending.fingerprint !== fingerprint) {
          this.recordConflict(request, "pending");
        }
        return;
      }
      this.publishResponse(
        failureResponse(
          request,
          "failed",
          "review-pending",
          "Another Code Review request is already pending",
        ),
      );
      return;
    }

    const state = this.options.registry.getState();
    const workflowRequest = this.options.registry.getActiveWorkflowRequest?.();
    if (
      state === undefined ||
      state.workflowId !== request.workflowId ||
      state.phase !== "IMPLEMENTING" ||
      state.implementationStatus !== "RUNNING" ||
      state.implementationRunId !== request.coordinatorRunId ||
      state.pendingInteraction !== undefined ||
      (workflowRequest !== undefined &&
        (workflowRequest.workflowId !== request.workflowId ||
          workflowRequest.cwd !== request.cwd))
    ) {
      this.publishResponse(
        failureResponse(
          request,
          "failed",
          "stale-request",
          "Code Review request does not match the active Implementation Coordinator",
        ),
      );
      return;
    }
    if (this.channel === undefined || !channelIsUsable(this.channel)) {
      this.failWorkflow();
      return;
    }

    const attached = this.options.registry.setCodeReviewPending(
      request.requestId,
      request.coordinatorRunId,
    );
    if (!attached.transitioned) {
      this.publishResponse(
        failureResponse(
          request,
          "failed",
          "state-persistence-failed",
          attached.reason,
        ),
      );
      return;
    }
    this.startReview(request, fingerprint);
  }

  private handleBindingRequest(
    fromSessionId: string,
    request: CodeReviewBindingRequest,
  ): void {
    if (request.originSessionId !== fromSessionId) return;
    const state = this.options.registry.getState();
    if (
      state === undefined ||
      state.phase !== "IMPLEMENTING" ||
      state.implementationStatus !== "RUNNING" ||
      state.workflowId !== request.workflowId ||
      !isValidRunId(state.implementationRunId)
    ) {
      return;
    }
    this.publishIntercom({
      version: 1,
      kind: CODE_REVIEW_BINDING_RESPONSE_KIND,
      workflowId: state.workflowId,
      requestId: request.requestId,
      recipientSessionId: request.originSessionId,
      coordinatorRunId: state.implementationRunId,
    } satisfies CodeReviewBindingResponse);
  }

  private respondToInvalidRequest(
    fromSessionId: string,
    value: unknown,
    errors: readonly string[],
  ): void {
    const identity = partialRequestIdentity(value);
    if (identity === undefined || identity.originSessionId !== fromSessionId) {
      return;
    }
    this.publishResponse(
      failureResponse(
        identity,
        "failed",
        "invalid-request",
        errors[0] ?? "Code Review request is invalid",
      ),
    );
  }

  private startReview(
    request: CodeReviewBridgeRequest,
    fingerprint: string,
  ): void {
    const pending: PendingRootReview = {
      request,
      fingerprint,
      settling: false,
      settled: false,
    };
    this.pending = pending;
    pending.timer = setTimeout(() => this.onTimeout(pending), this.timeoutMs);
    setUnref(pending.timer);

    const plannotatorRequest: PlannotatorRequest = {
      requestId: request.requestId,
      action: "code-review",
      payload: { cwd: request.cwd, useLocal: true },
      respond: (response) => this.onPlannotatorResponse(pending, response),
    };
    try {
      this.options.events.emit(PLANNOTATOR_REQUEST_EVENT, plannotatorRequest);
    } catch (error) {
      this.settleFailure(
        pending,
        "failed",
        "plannotator-emit-failed",
        boundedMessage(error, "Could not start Code Review"),
      );
    }
  }

  private onPlannotatorResponse(
    pending: PendingRootReview,
    value: unknown,
  ): void {
    if (this.disposed || this.pending !== pending || pending.settled) return;
    const parsed = parsePlannotatorResponse(value);
    const fingerprint = JSON.stringify(parsed);
    if (pending.settling) {
      if (pending.responseFingerprint !== fingerprint) this.failWorkflow();
      return;
    }
    pending.settling = true;
    pending.responseFingerprint = fingerprint;
    if (!parsed.valid) {
      this.settleFailure(
        pending,
        "failed",
        "invalid-plannotator-response",
        parsed.errors[0] ?? "Plannotator Code Review result is invalid",
      );
      return;
    }
    if (parsed.value.kind === "failure") {
      this.settleFailure(
        pending,
        parsed.value.status ?? "failed",
        parsed.value.error?.code ?? "plannotator-failed",
        parsed.value.error?.message ?? "Plannotator Code Review failed",
      );
      return;
    }
    this.settleResult(pending, parsed.value.result);
  }

  private onTimeout(pending: PendingRootReview): void {
    if (
      this.disposed ||
      this.pending !== pending ||
      pending.settled ||
      pending.settling
    ) {
      return;
    }
    pending.settling = true;
    pending.responseFingerprint = "timeout";
    this.settleFailure(pending, "timeout", "timeout", "Code Review timed out");
  }

  private settleResult(
    pending: PendingRootReview,
    result: PlannotatorCodeReviewResult | undefined,
  ): void {
    if (result === undefined) {
      this.settleFailure(
        pending,
        "failed",
        "invalid-plannotator-response",
        "Plannotator Code Review result is missing",
      );
      return;
    }
    const status: "approved" | "rejected" = result.approved
      ? "approved"
      : "rejected";
    const response: CodeReviewBridgeResponse = {
      version: 1,
      kind: CODE_REVIEW_RESPONSE_KIND,
      workflowId: pending.request.workflowId,
      requestId: pending.request.requestId,
      recipientSessionId: pending.request.originSessionId,
      status,
      approved: result.approved,
      ...(result.feedback === undefined ? {} : { feedback: result.feedback }),
      ...(result.annotations === undefined
        ? {}
        : { annotations: result.annotations }),
    };
    const responseValidation = validateCodeReviewBridgeResponse(response);
    if (!responseValidation.valid) {
      this.settleFailure(
        pending,
        "failed",
        "response-too-large",
        "Code Review response exceeds the intercom payload limit",
      );
      return;
    }
    const summary: CodeReviewResultSummary = {
      requestId: pending.request.requestId,
      status,
      approved: result.approved,
    };
    const transition = this.options.registry.recordCodeReviewResult(summary);
    if (!transition.transitioned) {
      this.settleFailure(
        pending,
        "failed",
        "state-persistence-failed",
        transition.reason,
      );
      return;
    }
    this.finish(pending, responseValidation.value);
  }

  private settleFailure(
    pending: PendingRootReview,
    status: Exclude<CodeReviewStatus, "approved" | "rejected">,
    code: string,
    message: string,
  ): void {
    if (this.pending !== pending || pending.settled) return;
    pending.settling = true;
    const summary: CodeReviewResultSummary = {
      requestId: pending.request.requestId,
      status,
      approved: false,
    };
    const transition = this.options.registry.recordCodeReviewResult(summary);
    if (!transition.transitioned) this.failWorkflow();
    this.finish(
      pending,
      failureResponse(pending.request, status, code, message),
    );
  }

  private finish(
    pending: PendingRootReview,
    response: CodeReviewBridgeResponse,
  ): void {
    if (this.pending !== pending || pending.settled) return;
    pending.settled = true;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    this.pending = undefined;
    const validated = validateCodeReviewBridgeResponse(response);
    if (!validated.valid) {
      this.failWorkflow();
      return;
    }
    this.completed.set(response.requestId, {
      fingerprint: pending.fingerprint,
      originSessionId: pending.request.originSessionId,
      response: structuredClone(validated.value),
    });
    while (this.completed.size > MAX_COMPLETED_REQUESTS) {
      const oldest = this.completed.keys().next().value;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
    this.publishResponse(validated.value);
  }

  private publishIntercom(payload: unknown): boolean {
    if (this.channel === undefined || !channelIsUsable(this.channel)) {
      this.failWorkflow();
      return false;
    }
    try {
      this.channel.publish(payload, { audience: "capable" });
      return true;
    } catch {
      this.failWorkflow();
      return false;
    }
  }

  private publishResponse(response: CodeReviewBridgeResponse): boolean {
    const validation = validateCodeReviewBridgeResponse(response);
    if (!validation.valid) {
      this.failWorkflow();
      return false;
    }
    return this.publishIntercom(validation.value);
  }

  private recordConflict(
    request: CodeReviewBridgeRequest,
    phase: CodeReviewConflictRecord["phase"],
  ): void {
    this.conflicts.push({
      requestId: request.requestId,
      workflowId: request.workflowId,
      phase,
      reason: "fingerprint-mismatch",
    });
    if (this.conflicts.length > MAX_CONFLICT_RECORDS) {
      this.conflicts.shift();
    }
    this.failWorkflow();
  }

  private failWorkflow(): void {
    const state = this.options.registry.getState();
    if (state !== undefined && isActivePhase(state.phase)) {
      this.options.registry.transition("FAILED");
    }
  }
}

export function registerCodeReviewRootBridge(
  options: CodeReviewRootBridgeOptions,
): CodeReviewRootBridge {
  return new CodeReviewRootBridge(options);
}

function validateToolInput(
  input: CodeReviewChildRequestInput,
): ValidationResult<PreparedCodeReviewRequest> {
  if (!isValidWorkflowId(input.workflowId) || !validateCwd(input.cwd)) {
    return invalidResult("Code Review tool input is invalid");
  }
  if (input.coordinatorRunId === undefined) {
    return validResult({ workflowId: input.workflowId, cwd: input.cwd });
  }
  if (!isValidRunId(input.coordinatorRunId)) {
    return invalidResult("coordinatorRunId is invalid");
  }
  return validResult({
    workflowId: input.workflowId,
    cwd: input.cwd,
    coordinatorRunId: createRunId(input.coordinatorRunId),
  });
}

function childChannelIsUsable(
  channel: IntercomExtensionChannel | undefined,
): channel is IntercomExtensionChannel {
  return channel !== undefined && channelIsUsable(channel);
}

export class CodeReviewChildBridge {
  private channel: IntercomExtensionChannel | undefined;
  private registered = false;
  private disposed = false;
  private readonly pending = new Map<string, PendingChildReview>();
  private readonly bindings = new Map<string, RunId>();
  private readonly bindingWaiters = new Map<string, PendingBinding>();

  public constructor(
    private readonly events: CodeReviewEventBus,
    private readonly sessionId: string,
  ) {}

  public register(): void {
    if (this.disposed) {
      throw new CodeReviewBridgeError(
        "SHUTDOWN",
        "Code Review bridge is shut down",
      );
    }
    if (this.registered) return;
    if (!isNormalizedOpaqueId(this.sessionId)) {
      throw new CodeReviewBridgeError(
        "BRIDGE_UNAVAILABLE",
        "Child session identity is unavailable",
      );
    }
    this.registered = true;
    const registration: IntercomExtensionRegistration = {
      namespace: CODE_REVIEW_NAMESPACE,
      ownerEligible: false,
      onReady: (channel) => {
        if (!this.disposed) this.channel = channel;
      },
      onEvent: (event) => this.onIntercomEvent(event),
    };
    try {
      this.events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, registration);
    } catch (error) {
      this.registered = false;
      throw new CodeReviewBridgeError(
        "BRIDGE_UNAVAILABLE",
        boundedMessage(error, "Could not register the Code Review channel"),
      );
    }
  }

  public request(
    input: CodeReviewChildRequestInput,
    signal?: AbortSignal,
  ): Promise<CodeReviewBridgeResponse> {
    if (this.disposed) {
      return Promise.reject(
        new CodeReviewBridgeError(
          "SHUTDOWN",
          "Code Review bridge is shut down",
        ),
      );
    }
    if (!this.registered || !childChannelIsUsable(this.channel)) {
      return Promise.reject(
        new CodeReviewBridgeError(
          "BRIDGE_UNAVAILABLE",
          "Code Review intercom channel is unavailable",
        ),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(
        new CodeReviewBridgeError(
          "BRIDGE_ABORTED",
          "Code Review request was aborted",
        ),
      );
    }
    const prepared = validateToolInput(input);
    if (!prepared.valid) {
      return Promise.reject(
        new CodeReviewBridgeError(
          "INVALID_REQUEST",
          prepared.errors.join("; "),
        ),
      );
    }
    const explicitRunId = prepared.value.coordinatorRunId;
    if (explicitRunId !== undefined) {
      return this.sendRequest(prepared.value, explicitRunId, signal);
    }
    const boundRunId = this.bindings.get(prepared.value.workflowId);
    if (boundRunId !== undefined) {
      return this.sendRequest(prepared.value, boundRunId, signal);
    }
    return this.bindCoordinator(prepared.value.workflowId, signal).then(
      (runId) => this.sendRequest(prepared.value, runId, signal),
    );
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const interaction of this.pending.values()) {
      interaction.reject(
        new CodeReviewBridgeError("SHUTDOWN", "Code Review bridge shut down"),
      );
    }
    for (const waiter of this.bindingWaiters.values()) {
      waiter.reject(
        new CodeReviewBridgeError("SHUTDOWN", "Code Review bridge shut down"),
      );
    }
    this.pending.clear();
    this.bindingWaiters.clear();
    this.bindings.clear();
    this.channel = undefined;
  }

  private sendRequest(
    input: PreparedCodeReviewRequest,
    coordinatorRunId: RunId,
    signal: AbortSignal | undefined,
  ): Promise<CodeReviewBridgeResponse> {
    const request: CodeReviewBridgeRequest = {
      version: 1,
      kind: CODE_REVIEW_REQUEST_KIND,
      workflowId: input.workflowId,
      requestId: createRequestId(),
      originSessionId: this.sessionId,
      coordinatorRunId,
      cwd: input.cwd,
    };
    if (!isWithinPayloadLimit(request)) {
      return Promise.reject(
        new CodeReviewBridgeError(
          "INVALID_REQUEST",
          "Code Review request exceeds the payload limit",
        ),
      );
    }

    return new Promise<CodeReviewBridgeResponse>((resolve, reject) => {
      let settled = false;
      let removeAbortListener = () => {};
      const cleanup = () => {
        removeAbortListener();
        this.pending.delete(request.requestId);
      };
      const finish = (response: CodeReviewBridgeResponse) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(response);
      };
      const fail = (error: CodeReviewBridgeError) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      this.pending.set(request.requestId, {
        request,
        resolve: finish,
        reject: fail,
        removeAbortListener: () => removeAbortListener(),
      });
      if (signal !== undefined) {
        const onAbort = () =>
          fail(
            new CodeReviewBridgeError(
              "BRIDGE_ABORTED",
              "Code Review request was aborted",
            ),
          );
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () =>
          signal.removeEventListener("abort", onAbort);
      }
      try {
        this.channel?.publish(request, { audience: "owner" });
      } catch (error) {
        fail(
          new CodeReviewBridgeError(
            "BRIDGE_UNAVAILABLE",
            boundedMessage(error, "Could not publish the Code Review request"),
          ),
        );
      }
    });
  }

  private bindCoordinator(
    workflowId: WorkflowId,
    signal: AbortSignal | undefined,
  ): Promise<RunId> {
    const channel = this.channel;
    if (!childChannelIsUsable(channel)) {
      return Promise.reject(
        new CodeReviewBridgeError(
          "BRIDGE_UNAVAILABLE",
          "Code Review intercom channel is unavailable",
        ),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(
        new CodeReviewBridgeError(
          "BRIDGE_ABORTED",
          "Code Review request was aborted",
        ),
      );
    }

    const requestId = createRequestId();
    return new Promise<RunId>((resolve, reject) => {
      let settled = false;
      let removeAbortListener = () => {};
      const timer = setTimeout(
        () =>
          fail(
            new CodeReviewBridgeError(
              "BRIDGE_UNAVAILABLE",
              "Timed out waiting for the Implementation Coordinator identity",
            ),
          ),
        TIMEOUTS.rpcReplyTimeoutMs,
      );
      setUnref(timer);
      const cleanup = () => {
        clearTimeout(timer);
        removeAbortListener();
        this.bindingWaiters.delete(requestId);
      };
      const finish = (runId: RunId) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.bindings.set(workflowId, runId);
        resolve(runId);
      };
      const fail = (error: CodeReviewBridgeError) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      this.bindingWaiters.set(requestId, {
        workflowId,
        resolve: finish,
        reject: fail,
        timer,
        removeAbortListener: () => removeAbortListener(),
      });
      if (signal !== undefined) {
        const onAbort = () =>
          fail(
            new CodeReviewBridgeError(
              "BRIDGE_ABORTED",
              "Code Review request was aborted",
            ),
          );
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () =>
          signal.removeEventListener("abort", onAbort);
      }
      try {
        channel.publish(
          {
            version: 1,
            kind: CODE_REVIEW_BINDING_REQUEST_KIND,
            workflowId,
            requestId,
            originSessionId: this.sessionId,
          } satisfies CodeReviewBindingRequest,
          { audience: "owner" },
        );
      } catch (error) {
        fail(
          new CodeReviewBridgeError(
            "BRIDGE_UNAVAILABLE",
            boundedMessage(
              error,
              "Could not publish the coordinator identity request",
            ),
          ),
        );
      }
    });
  }

  private onIntercomEvent(event: IntercomExtensionEvent): void {
    if (
      this.disposed ||
      !isRecord(event) ||
      event.type !== "message" ||
      !isNormalizedOpaqueId(event.fromSessionId) ||
      event.fromSessionId === this.sessionId ||
      !isCurrentRootOwner(event, this.channel)
    ) {
      return;
    }
    if (!isRecord(event.payload)) return;

    const binding = validateBindingResponse(event.payload);
    if (binding.valid) {
      if (binding.value.recipientSessionId !== this.sessionId) return;
      const waiter = this.bindingWaiters.get(binding.value.requestId);
      if (waiter === undefined) return;
      if (waiter.workflowId !== binding.value.workflowId) {
        waiter.reject(
          new CodeReviewBridgeError(
            "RESPONSE_CONFLICT",
            "Coordinator identity response does not match the request",
          ),
        );
        return;
      }
      waiter.resolve(binding.value.coordinatorRunId);
      return;
    }

    const requestId = event.payload.requestId;
    if (!isValidRequestId(requestId)) return;
    const interaction = this.pending.get(requestId);
    if (interaction === undefined) return;
    if (event.payload.recipientSessionId !== this.sessionId) return;
    const response = validateCodeReviewBridgeResponse(event.payload, {
      workflowId: interaction.request.workflowId,
      requestId,
      recipientSessionId: this.sessionId,
    });
    if (!response.valid) {
      interaction.reject(
        new CodeReviewBridgeError(
          "INVALID_RESPONSE",
          response.errors.join("; "),
        ),
      );
      return;
    }
    interaction.resolve(response.value);
  }
}

export const CODE_REVIEW_TOOL_PARAMETERS = Type.Object({
  workflowId: Type.String(),
  coordinatorRunId: Type.Optional(Type.String()),
});

function toolText(response: CodeReviewBridgeResponse): string {
  return JSON.stringify({
    status: response.status,
    approved: response.approved,
    ...(response.feedback === undefined ? {} : { feedback: response.feedback }),
    ...(response.annotations === undefined
      ? {}
      : { annotations: response.annotations }),
    ...(response.feedbackRef === undefined
      ? {}
      : { feedbackRef: response.feedbackRef }),
    ...(response.annotationsRef === undefined
      ? {}
      : { annotationsRef: response.annotationsRef }),
    ...(response.error === undefined ? {} : { error: response.error }),
  });
}

function createCodeReviewTool(
  getBridge: () => CodeReviewChildBridge | undefined,
): ToolDefinition<
  typeof CODE_REVIEW_TOOL_PARAMETERS,
  CodeReviewBridgeResponse
> {
  return {
    name: CODE_REVIEW_TOOL_NAME,
    label: "Code Review",
    description:
      "Request a direct Root-owned Plannotator code review. Continue in the same Coordinator after a rejection; never invent approval.",
    parameters: CODE_REVIEW_TOOL_PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const bridge = getBridge();
      if (bridge === undefined) {
        throw new CodeReviewBridgeError(
          "BRIDGE_UNAVAILABLE",
          "Code Review bridge is not ready",
        );
      }
      const response = await bridge.request(
        {
          workflowId: params.workflowId,
          cwd: ctx.cwd,
          ...(params.coordinatorRunId === undefined
            ? {}
            : { coordinatorRunId: params.coordinatorRunId }),
        },
        signal,
      );
      return {
        content: [{ type: "text", text: toolText(response) }],
        details: response,
        ...(response.status === "rejected" || response.status === "approved"
          ? {}
          : { terminate: true }),
      };
    },
  };
}

export function registerCodeReviewChildTool(
  pi: Pick<ExtensionAPI, "on" | "events" | "registerTool">,
): void {
  let bridge: CodeReviewChildBridge | undefined;
  pi.registerTool(createCodeReviewTool(() => bridge));

  pi.on("session_start", (_event, ctx) => {
    bridge?.dispose();
    bridge = new CodeReviewChildBridge(
      pi.events,
      ctx.sessionManager.getSessionId(),
    );
    try {
      bridge.register();
    } catch {
      bridge.dispose();
      bridge = undefined;
    }
  });

  pi.on("session_shutdown", () => {
    bridge?.dispose();
    bridge = undefined;
  });
}

export default function codeReviewChildExtension(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD !== "1") return;
  registerCodeReviewChildTool(pi);
}
