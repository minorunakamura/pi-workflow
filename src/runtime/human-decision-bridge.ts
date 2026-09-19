import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import {
  createRequestId,
  createRunId,
  isActivePhase,
  isValidRequestId,
  isValidRunId,
  isValidWorkflowId,
  TIMEOUTS,
  type PendingInteraction,
  type RequestId,
  type RunId,
  type WorkflowId,
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
import type { RootWorkflowRegistry } from "./root-lifecycle.ts";

export const HUMAN_DECISION_NAMESPACE = "pi-workflow" as const;
export const HUMAN_DECISION_REQUEST_KIND = "human-decision-request" as const;
export const HUMAN_DECISION_RESPONSE_KIND = "human-decision-response" as const;
export const HUMAN_DECISION_BINDING_REQUEST_KIND =
  "human-decision-binding-request" as const;
export const HUMAN_DECISION_BINDING_RESPONSE_KIND =
  "human-decision-binding-response" as const;

export const INTERCOM_EXTENSION_REGISTER_EVENT =
  "intercom:extension-register" as const;
export const ASK_USER_QUESTION_REQUEST_EVENT =
  "pi-ask-user-question:request:v1" as const;
export const ASK_USER_QUESTION_CANCEL_EVENT =
  "pi-ask-user-question:cancel:v1" as const;
export const ASK_USER_QUESTION_REPLY_EVENT_PREFIX =
  "pi-ask-user-question:reply:" as const;

export const HUMAN_DECISION_TOOL_NAME = "pi_workflow_human_decision" as const;

const MAX_BRIDGE_PAYLOAD_BYTES = 16 * 1024;
const MAX_QUESTIONS = 32;
const MAX_OPTIONS = 64;
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_COMPLETED_REQUESTS = 64;
const MAX_CONFLICT_RECORDS = 64;
const ASK_USER_QUESTION_ERROR_CODES = [
  "invalid-request",
  "unsupported-version",
  "duplicate-request-id",
  "tui-unavailable",
  "internal-error",
] as const;

type AskUserQuestionErrorCode = (typeof ASK_USER_QUESTION_ERROR_CODES)[number];
export type AskUserQuestionStatus =
  | "answered"
  | "user-cancelled"
  | "caller-aborted"
  | "shutdown";

export interface AskUserQuestionOption {
  label: string;
  description?: string;
  preview?: string;
  value?: string;
}

export interface AskUserQuestion {
  question: string;
  header?: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
  allowOther?: boolean;
}

export interface AskUserQuestionRequest {
  version: 1;
  requestId: RequestId;
  title?: string;
  questions: AskUserQuestion[];
}

export interface AskUserQuestionResult {
  status: AskUserQuestionStatus;
  questions: unknown[];
  answers: Record<string, string | string[]>;
  selections: unknown[];
  cancelled: boolean;
  response?: string;
}

export interface AskUserQuestionSuccessResponse {
  version: 1;
  requestId: RequestId;
  success: true;
  result: AskUserQuestionResult;
}

export interface AskUserQuestionErrorResponse {
  version: 1;
  requestId: RequestId;
  success: false;
  error: {
    code: AskUserQuestionErrorCode;
    message: string;
  };
}

export type AskUserQuestionResponse =
  | AskUserQuestionSuccessResponse
  | AskUserQuestionErrorResponse;

export interface HumanDecisionBridgeRequest {
  version: 1;
  kind: typeof HUMAN_DECISION_REQUEST_KIND;
  workflowId: WorkflowId;
  requestId: RequestId;
  originSessionId: string;
  coordinatorRunId: RunId;
  title?: string;
  questions: AskUserQuestion[];
}

export type HumanDecisionResponseStatus = AskUserQuestionStatus | "failure";

export interface HumanDecisionBridgeResponse {
  version: 1;
  kind: typeof HUMAN_DECISION_RESPONSE_KIND;
  workflowId: WorkflowId;
  requestId: RequestId;
  recipientSessionId: string;
  status: HumanDecisionResponseStatus;
  result?: AskUserQuestionResult;
  error?: { code: string; message: string };
}

export interface HumanDecisionConflictRecord {
  requestId: string;
  workflowId: string;
  phase: "pending" | "completed";
  reason: "fingerprint-mismatch";
}

interface HumanDecisionBindingRequest {
  version: 1;
  kind: typeof HUMAN_DECISION_BINDING_REQUEST_KIND;
  workflowId: WorkflowId;
  requestId: RequestId;
  originSessionId: string;
}

interface HumanDecisionBindingResponse {
  version: 1;
  kind: typeof HUMAN_DECISION_BINDING_RESPONSE_KIND;
  workflowId: WorkflowId;
  requestId: RequestId;
  recipientSessionId: string;
  coordinatorRunId: RunId;
}

export interface HumanDecisionEventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

export interface IntercomExtensionChannel {
  readonly namespace: string;
  snapshot(): {
    connected: boolean;
    supported: boolean;
    owner?: { sessionId: string; epoch: string };
  };
  publish(
    payload: unknown,
    options?: { audience?: "owner" | "capable"; ownerOnly?: boolean },
  ): void;
}

export type IntercomExtensionEvent =
  | {
      type: "message";
      fromSessionId: string;
      owner?: { sessionId: string; epoch: string };
      payload: unknown;
    }
  | { type: "connection"; connected: boolean; supported: boolean }
  | { type: "owner"; owner?: { sessionId: string; epoch: string } };

export interface IntercomExtensionRegistration {
  namespace: string;
  ownerEligible: boolean;
  onEvent(event: IntercomExtensionEvent): void;
  onReady(channel: IntercomExtensionChannel): void;
}

export type HumanDecisionRegistry = Pick<
  RootWorkflowRegistry,
  | "getState"
  | "setPendingInteraction"
  | "clearPendingInteraction"
  | "transition"
>;

export interface HumanDecisionRootBridgeOptions {
  events: HumanDecisionEventBus;
  registry: HumanDecisionRegistry;
  sessionId: string;
  mode: string;
  timeoutMs?: number;
}

export interface HumanDecisionRootBridge {
  dispose(): void;
  getConflictRecords(): readonly HumanDecisionConflictRecord[];
  hasPendingInteraction(): boolean;
  getIntercomChannel(): IntercomExtensionChannel | undefined;
  addIntercomEventHandler(
    handler: (event: IntercomExtensionEvent) => void,
  ): () => void;
}

export type HumanDecisionToolInput = Static<
  typeof HUMAN_DECISION_TOOL_PARAMETERS
>;

export type HumanDecisionBridgeErrorCode =
  | "INVALID_REQUEST"
  | "BRIDGE_UNAVAILABLE"
  | "BRIDGE_ABORTED"
  | "INVALID_RESPONSE"
  | "RESPONSE_CONFLICT"
  | "SHUTDOWN";

export class HumanDecisionBridgeError extends Error {
  public readonly code: HumanDecisionBridgeErrorCode;

  public constructor(code: HumanDecisionBridgeErrorCode, message: string) {
    super(message);
    this.name = "HumanDecisionBridgeError";
    this.code = code;
  }
}

function replyEvent(requestId: string): string {
  return `${ASK_USER_QUESTION_REPLY_EVENT_PREFIX}${requestId}`;
}

export function getAskUserQuestionReplyEvent(requestId: string): string {
  return replyEvent(requestId);
}

function setUnref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
}

function optionalText(
  value: unknown,
  fieldName: string,
): ValidationResult<string | undefined> {
  if (value === undefined) return validResult(undefined);
  return isBoundedString(value, MAX_TEXT_BYTES)
    ? validResult(value.trim() || undefined)
    : invalidResult(`${fieldName} must be a bounded string`);
}

function validateQuestions(
  value: unknown,
): ValidationResult<AskUserQuestion[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return invalidResult("questions must contain at least one item");
  }
  if (value.length > MAX_QUESTIONS) {
    return invalidResult(
      `questions must contain at most ${MAX_QUESTIONS} items`,
    );
  }

  const questions: AskUserQuestion[] = [];
  const identifiers = new Set<string>();
  for (const [index, rawQuestion] of value.entries()) {
    if (
      !isRecord(rawQuestion) ||
      !hasOnlyKeys(rawQuestion, [
        "question",
        "header",
        "options",
        "multiSelect",
        "allowOther",
      ])
    ) {
      return invalidResult(`questions[${index}] is invalid`);
    }
    if (!isBoundedString(rawQuestion.question, MAX_TEXT_BYTES, true)) {
      return invalidResult(`questions[${index}].question is invalid`);
    }
    const questionText = rawQuestion.question.trim();
    if (identifiers.has(questionText)) {
      return invalidResult(`questions[${index}].question is duplicated`);
    }
    identifiers.add(questionText);

    const header = optionalText(
      rawQuestion.header,
      `questions[${index}].header`,
    );
    if (!header.valid) return header;
    if (!Array.isArray(rawQuestion.options)) {
      return invalidResult(`questions[${index}].options must be an array`);
    }
    if (rawQuestion.options.length > MAX_OPTIONS) {
      return invalidResult(
        `questions[${index}].options must contain at most ${MAX_OPTIONS} items`,
      );
    }

    const options: AskUserQuestionOption[] = [];
    for (const [optionIndex, rawOption] of rawQuestion.options.entries()) {
      if (
        !isRecord(rawOption) ||
        !hasOnlyKeys(rawOption, ["label", "description", "preview", "value"]) ||
        !isBoundedString(rawOption.label, MAX_TEXT_BYTES, true)
      ) {
        return invalidResult(
          `questions[${index}].options[${optionIndex}] is invalid`,
        );
      }
      const description = optionalText(
        rawOption.description,
        `questions[${index}].options[${optionIndex}].description`,
      );
      const preview = optionalText(
        rawOption.preview,
        `questions[${index}].options[${optionIndex}].preview`,
      );
      const optionValue = optionalText(
        rawOption.value,
        `questions[${index}].options[${optionIndex}].value`,
      );
      if (!description.valid) return description;
      if (!preview.valid) return preview;
      if (!optionValue.valid) return optionValue;
      options.push({
        label: rawOption.label.trim(),
        ...(description.value === undefined
          ? {}
          : { description: description.value }),
        ...(preview.value === undefined ? {} : { preview: preview.value }),
        ...(optionValue.value === undefined
          ? {}
          : { value: optionValue.value }),
      });
    }

    if (
      rawQuestion.multiSelect !== undefined &&
      typeof rawQuestion.multiSelect !== "boolean"
    ) {
      return invalidResult(`questions[${index}].multiSelect is invalid`);
    }
    if (
      rawQuestion.allowOther !== undefined &&
      typeof rawQuestion.allowOther !== "boolean"
    ) {
      return invalidResult(`questions[${index}].allowOther is invalid`);
    }

    questions.push({
      question: questionText,
      ...(header.value === undefined ? {} : { header: header.value }),
      options,
      ...(rawQuestion.multiSelect === undefined
        ? {}
        : { multiSelect: rawQuestion.multiSelect }),
      ...(rawQuestion.allowOther === undefined
        ? {}
        : { allowOther: rawQuestion.allowOther }),
    });
  }

  return validResult(questions);
}

function isWithinPayloadLimit(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return (
      serialized !== undefined &&
      new TextEncoder().encode(serialized).byteLength <=
        MAX_BRIDGE_PAYLOAD_BYTES
    );
  } catch {
    return false;
  }
}

export function validateHumanDecisionBridgeRequest(
  value: unknown,
): ValidationResult<HumanDecisionBridgeRequest> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "kind",
      "workflowId",
      "requestId",
      "originSessionId",
      "coordinatorRunId",
      "title",
      "questions",
    ])
  ) {
    return invalidResult(
      "Human Decision request has unknown or missing fields",
    );
  }
  if (
    value.version !== 1 ||
    value.kind !== HUMAN_DECISION_REQUEST_KIND ||
    !isValidWorkflowId(value.workflowId) ||
    !isValidRequestId(value.requestId) ||
    !isNormalizedOpaqueId(value.originSessionId) ||
    !isValidRunId(value.coordinatorRunId)
  ) {
    return invalidResult("Human Decision request identity is invalid");
  }

  const title = optionalText(value.title, "title");
  if (!title.valid) return title;
  const questions = validateQuestions(value.questions);
  if (!questions.valid) return questions;

  const request: HumanDecisionBridgeRequest = {
    version: 1,
    kind: HUMAN_DECISION_REQUEST_KIND,
    workflowId: value.workflowId,
    requestId: value.requestId,
    originSessionId: value.originSessionId,
    coordinatorRunId: value.coordinatorRunId,
    ...(title.value === undefined ? {} : { title: title.value }),
    questions: questions.value,
  };
  return isWithinPayloadLimit(request)
    ? validResult(request)
    : invalidResult("Human Decision request exceeds the payload limit");
}

export function isHumanDecisionBridgeRequest(
  value: unknown,
): value is HumanDecisionBridgeRequest {
  return validateHumanDecisionBridgeRequest(value).valid;
}

function validateHumanDecisionBindingRequest(
  value: unknown,
): ValidationResult<HumanDecisionBindingRequest> {
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
    value.kind !== HUMAN_DECISION_BINDING_REQUEST_KIND ||
    !isValidWorkflowId(value.workflowId) ||
    !isValidRequestId(value.requestId) ||
    !isNormalizedOpaqueId(value.originSessionId)
  ) {
    return invalidResult("Human Decision binding request is invalid");
  }
  return validResult({
    version: 1,
    kind: HUMAN_DECISION_BINDING_REQUEST_KIND,
    workflowId: value.workflowId,
    requestId: value.requestId,
    originSessionId: value.originSessionId,
  });
}

function validateHumanDecisionBindingResponse(
  value: unknown,
): ValidationResult<HumanDecisionBindingResponse> {
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
    value.kind !== HUMAN_DECISION_BINDING_RESPONSE_KIND ||
    !isValidWorkflowId(value.workflowId) ||
    !isValidRequestId(value.requestId) ||
    !isNormalizedOpaqueId(value.recipientSessionId) ||
    !isValidRunId(value.coordinatorRunId)
  ) {
    return invalidResult("Human Decision binding response is invalid");
  }
  return validResult({
    version: 1,
    kind: HUMAN_DECISION_BINDING_RESPONSE_KIND,
    workflowId: value.workflowId,
    requestId: value.requestId,
    recipientSessionId: value.recipientSessionId,
    coordinatorRunId: value.coordinatorRunId,
  });
}

function isAskUserQuestionStatus(
  value: unknown,
): value is AskUserQuestionStatus {
  return (
    value === "answered" ||
    value === "user-cancelled" ||
    value === "caller-aborted" ||
    value === "shutdown"
  );
}

function isAskUserQuestionErrorCode(
  value: unknown,
): value is AskUserQuestionErrorCode {
  return (
    typeof value === "string" &&
    (ASK_USER_QUESTION_ERROR_CODES as readonly string[]).includes(value)
  );
}

function isAnswerValue(value: unknown): value is string | string[] {
  return (
    (typeof value === "string" && isBoundedString(value, MAX_TEXT_BYTES)) ||
    (Array.isArray(value) &&
      value.every((item) => isBoundedString(item, MAX_TEXT_BYTES)))
  );
}

function validateAskUserQuestionResult(
  value: unknown,
): ValidationResult<AskUserQuestionResult> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "status",
      "questions",
      "answers",
      "selections",
      "cancelled",
      "response",
    ]) ||
    !isAskUserQuestionStatus(value.status) ||
    !Array.isArray(value.questions) ||
    !isRecord(value.answers) ||
    !Array.isArray(value.selections) ||
    typeof value.cancelled !== "boolean"
  ) {
    return invalidResult("Human Decision questionnaire result is invalid");
  }
  if (
    (value.status === "answered" && value.cancelled) ||
    (value.status !== "answered" && !value.cancelled)
  ) {
    return invalidResult(
      "Human Decision questionnaire status and cancellation disagree",
    );
  }
  if (
    Object.keys(value.answers).length > MAX_QUESTIONS ||
    Object.entries(value.answers).some(
      ([key, answer]) =>
        !isBoundedString(key, MAX_TEXT_BYTES, true) || !isAnswerValue(answer),
    )
  ) {
    return invalidResult("Human Decision answers are invalid");
  }
  const response = optionalText(value.response, "response");
  if (!response.valid) return response;

  const answers: Record<string, string | string[]> = {};
  for (const [key, answer] of Object.entries(value.answers)) {
    if (isAnswerValue(answer)) answers[key] = answer;
  }
  const result: AskUserQuestionResult = {
    status: value.status,
    questions: value.questions,
    answers,
    selections: value.selections,
    cancelled: value.cancelled,
    ...(response.value === undefined ? {} : { response: response.value }),
  };
  return isWithinPayloadLimit(result)
    ? validResult(result)
    : invalidResult(
        "Human Decision questionnaire result exceeds the payload limit",
      );
}

export function validateAskUserQuestionResponse(
  value: unknown,
  expectedRequestId?: string,
): ValidationResult<AskUserQuestionResponse> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "requestId",
      "success",
      "result",
      "error",
    ]) ||
    value.version !== 1 ||
    !isValidRequestId(value.requestId) ||
    (expectedRequestId !== undefined && value.requestId !== expectedRequestId)
  ) {
    return invalidResult("Ask User Question response identity is invalid");
  }

  if (value.success === false) {
    if (
      !isRecord(value.error) ||
      !hasOnlyKeys(value.error, ["code", "message"]) ||
      !isAskUserQuestionErrorCode(value.error.code) ||
      !isBoundedString(value.error.message, MAX_TEXT_BYTES, true)
    ) {
      return invalidResult("Ask User Question error response is invalid");
    }
    return validResult({
      version: 1,
      requestId: value.requestId,
      success: false,
      error: { code: value.error.code, message: value.error.message },
    });
  }

  if (
    value.success !== true ||
    !Object.hasOwn(value, "result") ||
    Object.hasOwn(value, "error")
  ) {
    return invalidResult("Ask User Question success response is invalid");
  }
  const result = validateAskUserQuestionResult(value.result);
  if (!result.valid) return result;
  return validResult({
    version: 1,
    requestId: value.requestId,
    success: true,
    result: result.value,
  });
}

function isHumanDecisionResponseStatus(
  value: unknown,
): value is HumanDecisionResponseStatus {
  return (
    value === "answered" ||
    value === "user-cancelled" ||
    value === "caller-aborted" ||
    value === "shutdown" ||
    value === "failure"
  );
}

function validateBridgeError(
  value: unknown,
): ValidationResult<{ code: string; message: string }> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["code", "message"]) ||
    !isBoundedString(value.code, MAX_TEXT_BYTES, true) ||
    !isBoundedString(value.message, MAX_TEXT_BYTES, true)
  ) {
    return invalidResult("Human Decision bridge error is invalid");
  }
  return validResult({ code: value.code, message: value.message });
}

export function validateHumanDecisionBridgeResponse(
  value: unknown,
  expected?: {
    workflowId?: string;
    requestId?: string;
    recipientSessionId?: string;
  },
): ValidationResult<HumanDecisionBridgeResponse> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "kind",
      "workflowId",
      "requestId",
      "recipientSessionId",
      "status",
      "result",
      "error",
    ]) ||
    value.version !== 1 ||
    value.kind !== HUMAN_DECISION_RESPONSE_KIND ||
    !isValidWorkflowId(value.workflowId) ||
    !isValidRequestId(value.requestId) ||
    !isNormalizedOpaqueId(value.recipientSessionId) ||
    !isHumanDecisionResponseStatus(value.status)
  ) {
    return invalidResult("Human Decision response identity is invalid");
  }
  if (
    expected?.workflowId !== undefined &&
    value.workflowId !== expected.workflowId
  ) {
    return invalidResult("Human Decision response workflow does not match");
  }
  if (
    expected?.requestId !== undefined &&
    value.requestId !== expected.requestId
  ) {
    return invalidResult("Human Decision response request does not match");
  }
  if (
    expected?.recipientSessionId !== undefined &&
    value.recipientSessionId !== expected.recipientSessionId
  ) {
    return invalidResult("Human Decision response recipient does not match");
  }

  const status = value.status;
  if (status === "failure") {
    if (!Object.hasOwn(value, "error") || Object.hasOwn(value, "result")) {
      return invalidResult("Failed Human Decision response is invalid");
    }
    const error = validateBridgeError(value.error);
    if (!error.valid) return error;
    return validResult({
      version: 1,
      kind: HUMAN_DECISION_RESPONSE_KIND,
      workflowId: value.workflowId,
      requestId: value.requestId,
      recipientSessionId: value.recipientSessionId,
      status,
      error: error.value,
    });
  }

  if (Object.hasOwn(value, "error")) {
    return invalidResult("Successful Human Decision response has an error");
  }
  let result: AskUserQuestionResult | undefined;
  if (Object.hasOwn(value, "result")) {
    const parsed = validateAskUserQuestionResult(value.result);
    if (!parsed.valid) return parsed;
    result = parsed.value;
    if (result.status !== status) {
      return invalidResult(
        "Human Decision response status does not match its result",
      );
    }
  }
  if (status === "answered" && result === undefined) {
    return invalidResult("Answered Human Decision response has no result");
  }

  return validResult({
    version: 1,
    kind: HUMAN_DECISION_RESPONSE_KIND,
    workflowId: value.workflowId,
    requestId: value.requestId,
    recipientSessionId: value.recipientSessionId,
    status,
    ...(result === undefined ? {} : { result }),
  });
}

export function isHumanDecisionBridgeResponse(
  value: unknown,
): value is HumanDecisionBridgeResponse {
  return validateHumanDecisionBridgeResponse(value).valid;
}

function requestFingerprint(request: HumanDecisionBridgeRequest): string {
  return JSON.stringify({
    version: request.version,
    kind: request.kind,
    workflowId: request.workflowId,
    originSessionId: request.originSessionId,
    coordinatorRunId: request.coordinatorRunId,
    title: request.title ?? "",
    questions: request.questions,
  });
}

function failureResponse(
  request: Pick<
    HumanDecisionBridgeRequest,
    "workflowId" | "requestId" | "originSessionId"
  >,
  code: string,
  message: string,
): HumanDecisionBridgeResponse {
  return {
    version: 1,
    kind: HUMAN_DECISION_RESPONSE_KIND,
    workflowId: request.workflowId,
    requestId: request.requestId,
    recipientSessionId: request.originSessionId,
    status: "failure",
    error: { code, message },
  };
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

function partialRequestIdentity(
  value: unknown,
):
  | Pick<
      HumanDecisionBridgeRequest,
      "workflowId" | "requestId" | "originSessionId"
    >
  | undefined {
  if (!isRecord(value)) return undefined;
  if (
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

interface PendingRootInteraction {
  request: HumanDecisionBridgeRequest;
  fingerprint: string;
  removeReplyListener: () => void;
  timer?: ReturnType<typeof setTimeout>;
  settling: boolean;
  settled: boolean;
}

interface CompletedRootInteraction {
  fingerprint: string;
  originSessionId: string;
  response: HumanDecisionBridgeResponse;
}

class RootHumanDecisionBridge implements HumanDecisionRootBridge {
  private channel: IntercomExtensionChannel | undefined;
  private pending: PendingRootInteraction | undefined;
  private readonly completed = new Map<string, CompletedRootInteraction>();
  private readonly conflicts: HumanDecisionConflictRecord[] = [];
  private readonly intercomEventHandlers = new Set<
    (event: IntercomExtensionEvent) => void
  >();
  private disposed = false;
  private readonly timeoutMs: number;

  public constructor(private readonly options: HumanDecisionRootBridgeOptions) {
    const timeout = options.timeoutMs ?? TIMEOUTS.humanDecisionTimeoutMs;
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new RangeError("Human Decision timeout must be a positive integer");
    }
    this.timeoutMs = timeout;
    this.registerIntercomChannel();
  }

  public getConflictRecords(): readonly HumanDecisionConflictRecord[] {
    return this.conflicts.map((record) => ({ ...record }));
  }

  public hasPendingInteraction(): boolean {
    return this.pending !== undefined && !this.pending.settled;
  }

  public getIntercomChannel(): IntercomExtensionChannel | undefined {
    return this.channel;
  }

  public addIntercomEventHandler(
    handler: (event: IntercomExtensionEvent) => void,
  ): () => void {
    if (this.disposed) return () => {};
    this.intercomEventHandlers.add(handler);
    return () => {
      this.intercomEventHandlers.delete(handler);
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    const pending = this.pending;
    if (pending !== undefined && !pending.settled) {
      pending.settling = true;
      try {
        this.options.events.emit(ASK_USER_QUESTION_CANCEL_EVENT, {
          version: 1,
          requestId: pending.request.requestId,
        });
      } catch {
        // A shutdown race must still settle the Root-side waiter.
      }
      this.settle(
        pending,
        {
          version: 1,
          kind: HUMAN_DECISION_RESPONSE_KIND,
          workflowId: pending.request.workflowId,
          requestId: pending.request.requestId,
          recipientSessionId: pending.request.originSessionId,
          status: "shutdown",
        },
        false,
      );
    }
    this.disposed = true;
    this.channel = undefined;
    this.intercomEventHandlers.clear();
    this.completed.clear();
    this.conflicts.length = 0;
  }

  private recordConflict(
    request: Pick<HumanDecisionBridgeRequest, "workflowId" | "requestId">,
    phase: HumanDecisionConflictRecord["phase"],
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

  private registerIntercomChannel(): void {
    if (!isNormalizedOpaqueId(this.options.sessionId)) return;
    const registration: IntercomExtensionRegistration = {
      namespace: HUMAN_DECISION_NAMESPACE,
      ownerEligible: true,
      onReady: (channel) => {
        if (!this.disposed) this.channel = channel;
      },
      onEvent: (event) => {
        this.onIntercomEvent(event);
      },
    };
    try {
      this.options.events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, registration);
    } catch {
      this.channel = undefined;
    }
  }

  private onIntercomEvent(event: IntercomExtensionEvent): void {
    if (this.disposed) return;
    for (const handler of [...this.intercomEventHandlers]) {
      try {
        handler(event);
      } catch {
        // One bridge must not break the Root intercom dispatcher.
      }
    }
    if (
      !isRecord(event) ||
      event.type !== "message" ||
      !isNormalizedOpaqueId(event.fromSessionId)
    ) {
      return;
    }
    const binding = validateHumanDecisionBindingRequest(event.payload);
    if (binding.valid) {
      this.handleBindingRequest(event.fromSessionId, binding.value);
      return;
    }
    if (
      isRecord(event.payload) &&
      typeof event.payload.kind === "string" &&
      event.payload.kind !== HUMAN_DECISION_REQUEST_KIND
    ) {
      return;
    }
    const parsed = validateHumanDecisionBridgeRequest(event.payload);
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
        if (
          pending.fingerprint !== fingerprint ||
          pending.request.originSessionId !== request.originSessionId
        ) {
          this.recordConflict(request, "pending");
        }
        return;
      }
      this.publishResponse(
        failureResponse(
          request,
          "interaction-pending",
          "Another Human Decision request is already pending",
        ),
      );
      return;
    }

    const state = this.options.registry.getState();
    if (
      state === undefined ||
      state.phase !== "PLANNING" ||
      state.planningStatus !== "RUNNING" ||
      state.workflowId !== request.workflowId ||
      state.planningRunId !== request.coordinatorRunId
    ) {
      this.publishResponse(
        failureResponse(
          request,
          "stale-request",
          "Human Decision request does not match the active Planning Coordinator",
        ),
      );
      return;
    }
    if (state.pendingInteraction !== undefined) {
      this.publishResponse(
        failureResponse(
          request,
          "interaction-pending",
          "Root already has a pending Human Decision request",
        ),
      );
      return;
    }
    if (this.options.mode !== "tui") {
      this.publishResponse(
        failureResponse(
          request,
          "tui-unavailable",
          "Human Decision requires a Root TUI context",
        ),
      );
      return;
    }
    if (this.channel === undefined || !channelIsUsable(this.channel)) {
      this.failWorkflow();
      return;
    }

    const interaction: PendingInteraction = {
      kind: "human",
      requestId: request.requestId,
      coordinatorRunId: request.coordinatorRunId,
    };
    const attached = this.options.registry.setPendingInteraction(interaction);
    if (!attached.transitioned) {
      this.publishResponse(
        failureResponse(request, "state-persistence-failed", attached.reason),
      );
      return;
    }
    this.startQuestionnaire(request, fingerprint);
  }

  private handleBindingRequest(
    fromSessionId: string,
    request: HumanDecisionBindingRequest,
  ): void {
    if (request.originSessionId !== fromSessionId) return;
    const state = this.options.registry.getState();
    if (
      state === undefined ||
      state.phase !== "PLANNING" ||
      state.planningStatus !== "RUNNING" ||
      state.workflowId !== request.workflowId ||
      state.planningRunId === undefined
    ) {
      return;
    }
    const response: HumanDecisionBindingResponse = {
      version: 1,
      kind: HUMAN_DECISION_BINDING_RESPONSE_KIND,
      workflowId: state.workflowId,
      requestId: request.requestId,
      recipientSessionId: request.originSessionId,
      coordinatorRunId: state.planningRunId,
    };
    this.publishIntercom(response);
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
        "invalid-request",
        errors[0] ?? "Human Decision request is invalid",
      ),
    );
  }

  private startQuestionnaire(
    request: HumanDecisionBridgeRequest,
    fingerprint: string,
  ): void {
    const pending: PendingRootInteraction = {
      request,
      fingerprint,
      removeReplyListener: () => {},
      settling: false,
      settled: false,
    };
    this.pending = pending;

    try {
      pending.removeReplyListener = this.options.events.on(
        replyEvent(request.requestId),
        (value) => this.onQuestionnaireReply(pending, value),
      );
      pending.timer = setTimeout(() => this.onTimeout(pending), this.timeoutMs);
      setUnref(pending.timer);
      const askRequest: AskUserQuestionRequest = {
        version: 1,
        requestId: request.requestId,
        ...(request.title === undefined ? {} : { title: request.title }),
        questions: request.questions,
      };
      this.options.events.emit(ASK_USER_QUESTION_REQUEST_EVENT, askRequest);
    } catch (error) {
      this.settle(
        pending,
        failureResponse(
          request,
          "internal-error",
          error instanceof Error
            ? error.message
            : "Could not start the Human Decision questionnaire",
        ),
      );
    }
  }

  private onQuestionnaireReply(
    pending: PendingRootInteraction,
    value: unknown,
  ): void {
    if (
      this.disposed ||
      this.pending !== pending ||
      pending.settled ||
      pending.settling
    ) {
      return;
    }
    if (isRecord(value) && value.requestId !== pending.request.requestId) {
      return;
    }
    const parsed = validateAskUserQuestionResponse(
      value,
      pending.request.requestId,
    );
    if (!parsed.valid) {
      this.settle(
        pending,
        failureResponse(
          pending.request,
          "invalid-response",
          parsed.errors[0] ?? "Ask User Question response is invalid",
        ),
      );
      return;
    }

    if (!parsed.value.success) {
      this.settle(
        pending,
        failureResponse(
          pending.request,
          parsed.value.error.code,
          parsed.value.error.message,
        ),
      );
      return;
    }
    this.settle(pending, {
      version: 1,
      kind: HUMAN_DECISION_RESPONSE_KIND,
      workflowId: pending.request.workflowId,
      requestId: pending.request.requestId,
      recipientSessionId: pending.request.originSessionId,
      status: parsed.value.result.status,
      result: parsed.value.result,
    });
  }

  private onTimeout(pending: PendingRootInteraction): void {
    if (
      this.disposed ||
      this.pending !== pending ||
      pending.settled ||
      pending.settling
    ) {
      return;
    }
    pending.settling = true;
    try {
      this.options.events.emit(ASK_USER_QUESTION_CANCEL_EVENT, {
        version: 1,
        requestId: pending.request.requestId,
      });
    } catch {
      // Timeout still fails closed if the questionnaire cancellation event is unavailable.
    }
    this.settle(
      pending,
      failureResponse(
        pending.request,
        "timeout",
        "Human Decision timed out before an answer arrived",
      ),
    );
  }

  private settle(
    pending: PendingRootInteraction,
    response: HumanDecisionBridgeResponse,
    remember = true,
  ): void {
    if (this.pending !== pending || pending.settled) return;
    pending.settling = true;
    pending.settled = true;
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.removeReplyListener();
    this.pending = undefined;

    let finalResponse = response;
    const cleared = this.options.registry.clearPendingInteraction(
      pending.request.requestId,
    );
    if (!cleared.transitioned) {
      this.failWorkflow();
      finalResponse = failureResponse(
        pending.request,
        "state-persistence-failed",
        cleared.reason,
      );
      remember = false;
    }

    if (!this.publishResponse(finalResponse)) return;
    if (remember) {
      this.completed.delete(pending.request.requestId);
      this.completed.set(pending.request.requestId, {
        fingerprint: pending.fingerprint,
        originSessionId: pending.request.originSessionId,
        response: structuredClone(finalResponse),
      });
      while (this.completed.size > MAX_COMPLETED_REQUESTS) {
        const oldest = this.completed.keys().next().value;
        if (typeof oldest !== "string") break;
        this.completed.delete(oldest);
      }
    }
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

  private publishResponse(response: HumanDecisionBridgeResponse): boolean {
    const validation = validateHumanDecisionBridgeResponse(response);
    if (!validation.valid) {
      this.failWorkflow();
      return false;
    }
    return this.publishIntercom(validation.value);
  }

  private failWorkflow(): void {
    const state = this.options.registry.getState();
    if (state === undefined || !isActivePhase(state.phase)) return;
    try {
      this.options.registry.transition("FAILED");
    } catch {
      // The state machine remains fail-closed when persistence itself is unavailable.
    }
  }
}

export function registerHumanDecisionRootBridge(
  options: HumanDecisionRootBridgeOptions,
): HumanDecisionRootBridge {
  return new RootHumanDecisionBridge(options);
}

interface PendingChildInteraction {
  request: HumanDecisionBridgeRequest;
  resolve: (response: HumanDecisionBridgeResponse) => void;
  reject: (error: HumanDecisionBridgeError) => void;
  removeAbortListener: () => void;
}

interface PendingBinding {
  workflowId: WorkflowId;
  resolve: (runId: RunId) => void;
  reject: (error: HumanDecisionBridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener: () => void;
}

interface PreparedToolRequest {
  workflowId: WorkflowId;
  title?: string;
  questions: AskUserQuestion[];
}

function validateToolInput(
  input: HumanDecisionToolInput,
): ValidationResult<PreparedToolRequest> {
  if (!isValidWorkflowId(input.workflowId)) {
    return invalidResult("workflowId is invalid");
  }
  const questions = validateQuestions(input.questions);
  if (!questions.valid) return questions;
  const title = optionalText(input.title, "title");
  if (!title.valid) return title;
  return validResult({
    workflowId: input.workflowId,
    ...(title.value === undefined ? {} : { title: title.value }),
    questions: questions.value,
  });
}

function toolRequest(
  input: PreparedToolRequest,
  originSessionId: string,
  coordinatorRunId: RunId,
): ValidationResult<HumanDecisionBridgeRequest> {
  if (!isNormalizedOpaqueId(originSessionId)) {
    return invalidResult("Child session identity is invalid");
  }
  const request: HumanDecisionBridgeRequest = {
    version: 1,
    kind: HUMAN_DECISION_REQUEST_KIND,
    workflowId: input.workflowId,
    requestId: createRequestId(),
    originSessionId,
    coordinatorRunId,
    ...(input.title === undefined ? {} : { title: input.title }),
    questions: input.questions,
  };
  return isWithinPayloadLimit(request)
    ? validResult(request)
    : invalidResult("Human Decision request exceeds the payload limit");
}

export class HumanDecisionChildBridge {
  private channel: IntercomExtensionChannel | undefined;
  private registered = false;
  private disposed = false;
  private readonly pending = new Map<string, PendingChildInteraction>();
  private readonly bindings = new Map<string, RunId>();
  private readonly bindingWaiters = new Map<string, PendingBinding>();

  public constructor(
    private readonly events: HumanDecisionEventBus,
    private readonly sessionId: string,
  ) {}

  public register(): void {
    if (this.disposed) {
      throw new HumanDecisionBridgeError(
        "SHUTDOWN",
        "Human Decision bridge is shut down",
      );
    }
    if (this.registered) return;
    if (!isNormalizedOpaqueId(this.sessionId)) {
      throw new HumanDecisionBridgeError(
        "BRIDGE_UNAVAILABLE",
        "Child session identity is unavailable",
      );
    }
    this.registered = true;
    const registration: IntercomExtensionRegistration = {
      namespace: HUMAN_DECISION_NAMESPACE,
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
      throw new HumanDecisionBridgeError(
        "BRIDGE_UNAVAILABLE",
        error instanceof Error
          ? error.message
          : "Could not register the Human Decision intercom channel",
      );
    }
  }

  public request(
    input: HumanDecisionToolInput,
    signal?: AbortSignal,
  ): Promise<HumanDecisionBridgeResponse> {
    if (this.disposed) {
      return Promise.reject(
        new HumanDecisionBridgeError(
          "SHUTDOWN",
          "Human Decision bridge is shut down",
        ),
      );
    }
    if (
      !this.registered ||
      this.channel === undefined ||
      !channelIsUsable(this.channel)
    ) {
      return Promise.reject(
        new HumanDecisionBridgeError(
          "BRIDGE_UNAVAILABLE",
          "Human Decision intercom channel is unavailable",
        ),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(
        new HumanDecisionBridgeError(
          "BRIDGE_ABORTED",
          "Human Decision request was aborted",
        ),
      );
    }

    const prepared = validateToolInput(input);
    if (!prepared.valid) {
      return Promise.reject(
        new HumanDecisionBridgeError(
          "INVALID_REQUEST",
          prepared.errors.join("; "),
        ),
      );
    }

    const explicitRunId = input.coordinatorRunId;
    if (explicitRunId !== undefined) {
      if (!isValidRunId(explicitRunId)) {
        return Promise.reject(
          new HumanDecisionBridgeError(
            "INVALID_REQUEST",
            "coordinatorRunId is invalid",
          ),
        );
      }
      return this.sendRequest(
        prepared.value,
        createRunId(explicitRunId),
        signal,
      );
    }

    const boundRunId = this.bindings.get(prepared.value.workflowId);
    if (boundRunId !== undefined) {
      return this.sendRequest(prepared.value, boundRunId, signal);
    }
    return this.bindCoordinator(prepared.value.workflowId, signal).then(
      (runId) => this.sendRequest(prepared.value, runId, signal),
    );
  }

  private sendRequest(
    input: PreparedToolRequest,
    coordinatorRunId: RunId,
    signal: AbortSignal | undefined,
  ): Promise<HumanDecisionBridgeResponse> {
    const request = toolRequest(input, this.sessionId, coordinatorRunId);
    if (!request.valid) {
      return Promise.reject(
        new HumanDecisionBridgeError(
          "INVALID_REQUEST",
          request.errors.join("; "),
        ),
      );
    }

    return new Promise<HumanDecisionBridgeResponse>((resolve, reject) => {
      let settled = false;
      let removeAbortListener = () => {};
      const cleanup = () => {
        removeAbortListener();
        this.pending.delete(request.value.requestId);
      };
      const finish = (response: HumanDecisionBridgeResponse) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(response);
      };
      const fail = (error: HumanDecisionBridgeError) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      this.pending.set(request.value.requestId, {
        request: request.value,
        resolve: finish,
        reject: fail,
        removeAbortListener: () => removeAbortListener(),
      });

      if (signal !== undefined) {
        const onAbort = () =>
          fail(
            new HumanDecisionBridgeError(
              "BRIDGE_ABORTED",
              "Human Decision request was aborted",
            ),
          );
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () =>
          signal.removeEventListener("abort", onAbort);
      }

      try {
        this.channel?.publish(request.value, { audience: "owner" });
      } catch (error) {
        fail(
          new HumanDecisionBridgeError(
            "BRIDGE_UNAVAILABLE",
            error instanceof Error
              ? error.message
              : "Could not publish the Human Decision request",
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
    if (channel === undefined || !channelIsUsable(channel)) {
      return Promise.reject(
        new HumanDecisionBridgeError(
          "BRIDGE_UNAVAILABLE",
          "Human Decision intercom channel is unavailable",
        ),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(
        new HumanDecisionBridgeError(
          "BRIDGE_ABORTED",
          "Human Decision request was aborted",
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
            new HumanDecisionBridgeError(
              "BRIDGE_UNAVAILABLE",
              "Timed out waiting for the coordinator identity",
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
      const fail = (error: HumanDecisionBridgeError) => {
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
            new HumanDecisionBridgeError(
              "BRIDGE_ABORTED",
              "Human Decision request was aborted",
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
            kind: HUMAN_DECISION_BINDING_REQUEST_KIND,
            workflowId,
            requestId,
            originSessionId: this.sessionId,
          } satisfies HumanDecisionBindingRequest,
          { audience: "owner" },
        );
      } catch (error) {
        fail(
          new HumanDecisionBridgeError(
            "BRIDGE_UNAVAILABLE",
            error instanceof Error
              ? error.message
              : "Could not publish the coordinator identity request",
          ),
        );
      }
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const interaction of this.pending.values()) {
      interaction.reject(
        new HumanDecisionBridgeError(
          "SHUTDOWN",
          "Human Decision bridge shut down",
        ),
      );
    }
    for (const waiter of this.bindingWaiters.values()) {
      waiter.reject(
        new HumanDecisionBridgeError(
          "SHUTDOWN",
          "Human Decision bridge shut down",
        ),
      );
    }
    this.pending.clear();
    this.bindingWaiters.clear();
    this.bindings.clear();
    this.channel = undefined;
  }

  private onIntercomEvent(event: IntercomExtensionEvent): void {
    if (
      this.disposed ||
      !isRecord(event) ||
      event.type !== "message" ||
      !isNormalizedOpaqueId(event.fromSessionId) ||
      event.fromSessionId === this.sessionId
    ) {
      return;
    }
    if (!isCurrentRootOwner(event, this.channel)) return;
    if (!isRecord(event.payload)) return;
    const bindingResponse = validateHumanDecisionBindingResponse(event.payload);
    if (bindingResponse.valid) {
      if (bindingResponse.value.recipientSessionId !== this.sessionId) return;
      const waiter = this.bindingWaiters.get(bindingResponse.value.requestId);
      if (waiter === undefined) return;
      if (waiter.workflowId !== bindingResponse.value.workflowId) {
        waiter.reject(
          new HumanDecisionBridgeError(
            "RESPONSE_CONFLICT",
            "Coordinator identity response does not match the request",
          ),
        );
        return;
      }
      waiter.resolve(bindingResponse.value.coordinatorRunId);
      return;
    }
    const requestId = event.payload.requestId;
    if (!isValidRequestId(requestId)) return;
    const interaction = this.pending.get(requestId);
    if (interaction === undefined) return;
    if (event.payload.recipientSessionId !== this.sessionId) return;

    const response = validateHumanDecisionBridgeResponse(event.payload, {
      workflowId: interaction.request.workflowId,
      requestId,
      recipientSessionId: this.sessionId,
    });
    if (!response.valid) {
      interaction.reject(
        new HumanDecisionBridgeError(
          "INVALID_RESPONSE",
          response.errors.join("; "),
        ),
      );
      return;
    }
    interaction.resolve(response.value);
  }
}

const ASK_OPTION_SCHEMA = Type.Object({
  label: Type.String(),
  description: Type.Optional(Type.String()),
  preview: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
});

const ASK_QUESTION_SCHEMA = Type.Object({
  question: Type.String(),
  header: Type.Optional(Type.String()),
  options: Type.Array(ASK_OPTION_SCHEMA),
  multiSelect: Type.Optional(Type.Boolean()),
  allowOther: Type.Optional(Type.Boolean()),
});

export const HUMAN_DECISION_TOOL_PARAMETERS = Type.Object({
  workflowId: Type.String(),
  coordinatorRunId: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  questions: Type.Array(ASK_QUESTION_SCHEMA),
});

function toolText(response: HumanDecisionBridgeResponse): string {
  if (response.status === "answered" && response.result !== undefined) {
    return JSON.stringify({
      status: response.status,
      answers: response.result.answers,
    });
  }
  return JSON.stringify({
    status: response.status,
    ...(response.error === undefined ? {} : { error: response.error }),
  });
}

function createHumanDecisionTool(
  getBridge: () => HumanDecisionChildBridge | undefined,
): ToolDefinition<
  typeof HUMAN_DECISION_TOOL_PARAMETERS,
  HumanDecisionBridgeResponse
> {
  return {
    name: HUMAN_DECISION_TOOL_NAME,
    label: "Human Decision",
    description:
      "Request a structured decision from the user through the Root TUI. Never invent a default answer.",
    parameters: HUMAN_DECISION_TOOL_PARAMETERS,
    async execute(_toolCallId, params, signal) {
      const bridge = getBridge();
      if (bridge === undefined) {
        throw new HumanDecisionBridgeError(
          "BRIDGE_UNAVAILABLE",
          "Human Decision bridge is not ready",
        );
      }
      const response = await bridge.request(params, signal);
      return {
        content: [{ type: "text", text: toolText(response) }],
        details: response,
        ...(response.status === "answered" ? {} : { terminate: true }),
      };
    },
  };
}

export function registerHumanDecisionChildTool(
  pi: Pick<ExtensionAPI, "on" | "events" | "registerTool">,
): void {
  let bridge: HumanDecisionChildBridge | undefined;
  pi.registerTool(createHumanDecisionTool(() => bridge));

  pi.on("session_start", (_event, ctx) => {
    bridge?.dispose();
    bridge = new HumanDecisionChildBridge(
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

export default function humanDecisionChildExtension(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD !== "1") return;
  registerHumanDecisionChildTool(pi);
}
