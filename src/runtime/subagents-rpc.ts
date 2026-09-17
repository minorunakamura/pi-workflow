import {
  TIMEOUTS,
  createRequestId,
  createRunId,
  getWorkflowPolicy,
  isNormalizedOpaqueId,
  isValidWorkflowId,
  isWorkflowType,
  type RunId,
  type WorkflowRequest,
} from "../core/index.ts";
import { isBoundedString, isRecord } from "../core/validation.ts";

export const SUBAGENT_RPC_PROTOCOL_VERSION = 1 as const;
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready" as const;
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request" as const;
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX =
  "subagents:rpc:v1:reply:" as const;

export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started" as const;
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete" as const;
export const SUBAGENT_PROCESS_TERMINAL_EVENT =
  "subagent:process-terminal" as const;

export const SUBAGENT_ASYNC_TERMINAL_STATES = [
  "complete",
  "failed",
  "partial",
  "paused",
  "stopped",
  "rejected",
] as const;
export type SubagentAsyncTerminalState =
  (typeof SUBAGENT_ASYNC_TERMINAL_STATES)[number];

export const SUBAGENT_RPC_METHODS = [
  "ping",
  "status",
  "manage",
  "spawn",
  "steer",
  "interrupt",
  "stop",
  "resume",
] as const;
export type SubagentRpcMethod = (typeof SUBAGENT_RPC_METHODS)[number];

export interface SubagentRpcEventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

export interface SubagentRpcRequestEnvelope {
  version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
  requestId: string;
  method: SubagentRpcMethod;
  params?: Record<string, unknown>;
  source?: { extension?: string };
}

export type SubagentRpcReplyEnvelope<T = unknown> =
  | {
      version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
      requestId: string;
      method?: SubagentRpcMethod;
      success: true;
      data: T;
    }
  | {
      version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
      requestId: string;
      method?: SubagentRpcMethod;
      success: false;
      error: { code: string; message: string };
    };

export interface SubagentRpcReadyPayload {
  version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
  methods: readonly string[];
  capabilities: { asyncSpawn: true };
}

export type SubagentRpcErrorCode =
  | "RPC_DISPOSED"
  | "RPC_READY_TIMEOUT"
  | "RPC_REPLY_TIMEOUT"
  | "RPC_ABORTED"
  | "RPC_INVALID_REPLY"
  | "RPC_CONFLICTING_REPLY"
  | "RPC_EMIT_FAILED"
  | "RPC_INVALID_REQUEST"
  | "RPC_INVALID_RUN_ID"
  | "RPC_INVALID_COORDINATOR_TASK"
  | "RPC_FAILURE"
  | "RPC_MISSING_RUN_ID";

export class SubagentRpcError extends Error {
  public readonly code: SubagentRpcErrorCode;
  public readonly requestId: string | undefined;

  public constructor(
    code: SubagentRpcErrorCode,
    message: string,
    requestId?: string,
  ) {
    super(message);
    this.name = "SubagentRpcError";
    this.code = code;
    this.requestId = requestId;
  }
}

export function subagentRpcReplyEvent(requestId: string): string {
  return `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;
}

function isSubagentRpcMethod(value: unknown): value is SubagentRpcMethod {
  return (
    typeof value === "string" &&
    (SUBAGENT_RPC_METHODS as readonly string[]).includes(value)
  );
}

export function isValidSubagentRpcRequest(
  value: unknown,
): value is SubagentRpcRequestEnvelope {
  if (
    !isRecord(value) ||
    value.version !== SUBAGENT_RPC_PROTOCOL_VERSION ||
    !isNormalizedOpaqueId(value.requestId) ||
    !isSubagentRpcMethod(value.method)
  ) {
    return false;
  }
  return value.params === undefined || isRecord(value.params);
}

function normalizeReady(value: unknown): SubagentRpcReadyPayload | undefined {
  if (!isRecord(value) || value.version !== SUBAGENT_RPC_PROTOCOL_VERSION) {
    return undefined;
  }
  const methods = value.methods;
  const capabilities = value.capabilities;
  if (
    !Array.isArray(methods) ||
    !methods.every((method) => isSubagentRpcMethod(method)) ||
    !isRecord(capabilities) ||
    capabilities.asyncSpawn !== true
  ) {
    return undefined;
  }
  const requiredMethods = ["spawn", "status", "stop"] as const;
  if (!requiredMethods.every((method) => methods.includes(method))) {
    return undefined;
  }
  return {
    version: SUBAGENT_RPC_PROTOCOL_VERSION,
    methods: [...methods],
    capabilities: { asyncSpawn: true },
  };
}

export function isValidSubagentRpcReady(
  value: unknown,
): value is SubagentRpcReadyPayload {
  return normalizeReady(value) !== undefined;
}

function setUnref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
}

interface ReadyWaiter {
  resolve: (ready: SubagentRpcReadyPayload) => void;
  reject: (error: SubagentRpcError) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  removeAbortListener: () => void;
}

interface PendingRequest {
  reject: (error: SubagentRpcError) => void;
  cleanup: () => void;
}

interface ParsedReply {
  kind: "ignore" | "invalid" | "reply";
  reply?: SubagentRpcReplyEnvelope;
  message?: string;
}

function parseReply(
  value: unknown,
  requestId: string,
  method: SubagentRpcMethod,
): ParsedReply {
  if (!isRecord(value) || value.requestId !== requestId) {
    return { kind: "ignore" };
  }
  if (value.version !== SUBAGENT_RPC_PROTOCOL_VERSION) {
    return { kind: "invalid", message: "RPC reply has an unsupported version" };
  }
  if (value.method !== undefined && value.method !== method) {
    return { kind: "invalid", message: "RPC reply method does not match" };
  }
  if (value.success === true && Object.hasOwn(value, "data")) {
    return {
      kind: "reply",
      reply: {
        version: SUBAGENT_RPC_PROTOCOL_VERSION,
        requestId,
        ...(value.method === undefined ? {} : { method }),
        success: true,
        data: value.data,
      },
    };
  }
  if (
    value.success === false &&
    isRecord(value.error) &&
    isBoundedString(value.error.code, 4096, true) &&
    isBoundedString(value.error.message, 4096, true)
  ) {
    return {
      kind: "reply",
      reply: {
        version: SUBAGENT_RPC_PROTOCOL_VERSION,
        requestId,
        ...(value.method === undefined ? {} : { method }),
        success: false,
        error: { code: value.error.code, message: value.error.message },
      },
    };
  }
  return { kind: "invalid", message: "RPC reply has an invalid shape" };
}

function isSuccessReply(
  value: SubagentRpcReplyEnvelope,
): value is Extract<SubagentRpcReplyEnvelope, { success: true }> {
  return value.success;
}

function normalizeRunId(value: unknown): RunId | undefined {
  if (typeof value !== "string" || /[\r\n]/u.test(value)) {
    return undefined;
  }
  try {
    return createRunId(value);
  } catch {
    return undefined;
  }
}

function valueAt(value: unknown, path: readonly (string | number)[]): unknown {
  let current: unknown = value;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[part];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

const RUN_ID_PATHS: readonly (readonly (string | number)[])[] = [
  ["details", "results", 0, "runId"],
  ["details", "runId"],
  ["details", "id"],
  ["details", "asyncId"],
  ["runId"],
  ["id"],
  ["asyncId"],
];

export function runIdFromSpawnData(value: unknown): RunId | undefined {
  for (const path of RUN_ID_PATHS) {
    const runId = normalizeRunId(valueAt(value, path));
    if (runId !== undefined) return runId;
  }
  return undefined;
}

const MAX_COORDINATOR_TASK_BYTES = 64 * 1024;

function serializePlanningCoordinatorTask(request: WorkflowRequest): string {
  if (
    !isValidWorkflowId(request.workflowId) ||
    !isWorkflowType(request.workflowType) ||
    !isBoundedString(request.request, MAX_COORDINATOR_TASK_BYTES, true) ||
    !isBoundedString(request.cwd, 4096, true) ||
    /[\0\r\n]/u.test(request.cwd)
  ) {
    throw new SubagentRpcError(
      "RPC_INVALID_COORDINATOR_TASK",
      "Planning Coordinator task is invalid or too large",
    );
  }
  try {
    const policy = getWorkflowPolicy();
    const task = JSON.stringify({
      version: 1,
      role: "planning-coordinator",
      workflowId: request.workflowId,
      workflowType: request.workflowType,
      request: request.request,
      cwd: request.cwd,
      policy: {
        source: policy.source,
        commonPlanning: policy.commonPlanning,
        scoutFocus: policy.typePolicies[request.workflowType].scoutFocus,
      },
    });
    if (!isBoundedString(task, MAX_COORDINATOR_TASK_BYTES, true)) {
      throw new SubagentRpcError(
        "RPC_INVALID_COORDINATOR_TASK",
        "Planning Coordinator task is invalid or too large",
      );
    }
    return task;
  } catch (error) {
    if (error instanceof SubagentRpcError) throw error;
    throw new SubagentRpcError(
      "RPC_INVALID_COORDINATOR_TASK",
      "Planning Coordinator task could not be serialized",
    );
  }
}

export interface PlanningCoordinatorLaunchResult {
  requestId: string;
  runId: RunId;
}

export interface SubagentRpcRequestOptions {
  signal?: AbortSignal;
}

export class SubagentRpcAdapter {
  private ready: SubagentRpcReadyPayload | undefined;
  private disposed = false;
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly removeReadyListener: () => void;

  public constructor(private readonly events: SubagentRpcEventBus) {
    this.removeReadyListener = events.on(SUBAGENT_RPC_READY_EVENT, (value) => {
      const normalized = normalizeReady(value);
      if (normalized === undefined) return;
      this.ready = normalized;
      for (const waiter of [...this.readyWaiters]) {
        waiter.resolve(normalized);
      }
    });
  }

  public isReady(): boolean {
    return this.ready !== undefined && !this.disposed;
  }

  public async request(
    method: SubagentRpcMethod,
    params?: Record<string, unknown>,
    options: SubagentRpcRequestOptions = {},
  ): Promise<SubagentRpcReplyEnvelope> {
    if (!isSubagentRpcMethod(method)) {
      throw new SubagentRpcError(
        "RPC_INVALID_REQUEST",
        "Unsupported subagent RPC method",
      );
    }
    if (this.disposed) {
      throw new SubagentRpcError(
        "RPC_DISPOSED",
        "Subagent RPC adapter is disposed",
      );
    }

    const requestId = createRequestId();
    await this.waitForReady(requestId, options.signal);
    if (this.disposed) {
      throw new SubagentRpcError(
        "RPC_DISPOSED",
        "Subagent RPC adapter is disposed",
        requestId,
      );
    }

    const request: SubagentRpcRequestEnvelope = {
      version: SUBAGENT_RPC_PROTOCOL_VERSION,
      requestId,
      method,
      ...(params === undefined ? {} : { params }),
      source: { extension: "pi-workflow" },
    };
    return this.sendRequest(request, options.signal);
  }

  public async spawnPlanningCoordinator(
    request: WorkflowRequest,
    options: SubagentRpcRequestOptions = {},
  ): Promise<PlanningCoordinatorLaunchResult> {
    const task = serializePlanningCoordinatorTask(request);
    const response = await this.request(
      "spawn",
      {
        agent: "pi-workflow.planning-coordinator",
        task,
        context: "fresh",
        cwd: request.cwd,
        async: true,
        output: "coordinator-summary.md",
        outputMode: "file-only",
        artifacts: true,
        timeoutMs: TIMEOUTS.coordinatorTimeoutMs,
      },
      options,
    );
    if (!isSuccessReply(response)) {
      throw new SubagentRpcError(
        "RPC_FAILURE",
        `Planning Coordinator spawn failed: ${response.error.code}`,
        response.requestId,
      );
    }
    const runId = runIdFromSpawnData(response.data);
    if (runId === undefined) {
      throw new SubagentRpcError(
        "RPC_MISSING_RUN_ID",
        "Planning Coordinator spawn reply has no structured run ID",
        response.requestId,
      );
    }
    return { requestId: response.requestId, runId };
  }

  public status(
    runId?: string,
    options: SubagentRpcRequestOptions = {},
  ): Promise<SubagentRpcReplyEnvelope> {
    return this.request(
      "status",
      runId === undefined ? undefined : { id: this.requireRunId(runId) },
      options,
    );
  }

  public stop(
    runId: string,
    options: SubagentRpcRequestOptions = {},
  ): Promise<SubagentRpcReplyEnvelope> {
    return this.request("stop", { id: this.requireRunId(runId) }, options);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeReadyListener();
    for (const waiter of [...this.readyWaiters]) {
      waiter.reject(
        new SubagentRpcError(
          "RPC_DISPOSED",
          "Subagent RPC adapter is disposed",
        ),
      );
    }
    for (const pending of [...this.pendingRequests.values()]) {
      pending.reject(
        new SubagentRpcError(
          "RPC_DISPOSED",
          "Subagent RPC adapter is disposed",
        ),
      );
    }
  }

  private requireRunId(value: string): RunId {
    const runId = normalizeRunId(value);
    if (runId === undefined) {
      throw new SubagentRpcError(
        "RPC_INVALID_RUN_ID",
        "Run ID must be a non-empty opaque ID",
      );
    }
    return runId;
  }

  private waitForReady(
    requestId: string,
    signal: AbortSignal | undefined,
  ): Promise<SubagentRpcReadyPayload> {
    if (this.ready !== undefined) return Promise.resolve(this.ready);
    if (this.disposed) {
      return Promise.reject(
        new SubagentRpcError(
          "RPC_DISPOSED",
          "Subagent RPC adapter is disposed",
          requestId,
        ),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(
        new SubagentRpcError(
          "RPC_ABORTED",
          "RPC request was aborted",
          requestId,
        ),
      );
    }

    return new Promise((resolve, reject) => {
      let removeAbortListener = () => {};
      const waiter: ReadyWaiter = {
        resolve: (value) => {
          this.removeReadyWaiter(waiter);
          resolve(value);
        },
        reject: (error) => {
          this.removeReadyWaiter(waiter);
          reject(error);
        },
        timer: undefined,
        removeAbortListener: () => removeAbortListener(),
      };
      const timer = setTimeout(() => {
        waiter.reject(
          new SubagentRpcError(
            "RPC_READY_TIMEOUT",
            `Timed out waiting for ${SUBAGENT_RPC_READY_EVENT}`,
            requestId,
          ),
        );
      }, TIMEOUTS.rpcReadyTimeoutMs);
      setUnref(timer);
      waiter.timer = timer;
      this.readyWaiters.add(waiter);

      if (signal !== undefined) {
        const onAbort = () => {
          waiter.reject(
            new SubagentRpcError(
              "RPC_ABORTED",
              "RPC request was aborted",
              requestId,
            ),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () =>
          signal.removeEventListener("abort", onAbort);
      }
    });
  }

  private removeReadyWaiter(waiter: ReadyWaiter): void {
    this.readyWaiters.delete(waiter);
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    waiter.removeAbortListener();
  }

  private sendRequest(
    request: SubagentRpcRequestEnvelope,
    signal: AbortSignal | undefined,
  ): Promise<SubagentRpcReplyEnvelope> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let terminalReply: SubagentRpcReplyEnvelope | undefined;
      let removeReplyListener = () => {};
      let removeAbortListener = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        removeReplyListener();
        removeAbortListener();
        this.pendingRequests.delete(request.requestId);
      };
      const fail = (error: SubagentRpcError) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const finish = (reply: SubagentRpcReplyEnvelope) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(reply);
      };
      const onReply = (value: unknown) => {
        const parsed = parseReply(value, request.requestId, request.method);
        if (parsed.kind === "ignore") return;
        if (parsed.kind === "invalid" || parsed.reply === undefined) {
          fail(
            new SubagentRpcError(
              "RPC_INVALID_REPLY",
              parsed.message ?? "RPC reply is invalid",
              request.requestId,
            ),
          );
          return;
        }
        if (terminalReply !== undefined) {
          if (terminalReply.success !== parsed.reply.success) {
            fail(
              new SubagentRpcError(
                "RPC_CONFLICTING_REPLY",
                "RPC request received conflicting replies",
                request.requestId,
              ),
            );
          }
          return;
        }
        terminalReply = parsed.reply;
        queueMicrotask(() => {
          if (terminalReply !== undefined) finish(terminalReply);
        });
      };

      removeReplyListener = this.events.on(
        subagentRpcReplyEvent(request.requestId),
        onReply,
      );
      this.pendingRequests.set(request.requestId, { reject: fail, cleanup });
      timer = setTimeout(() => {
        fail(
          new SubagentRpcError(
            "RPC_REPLY_TIMEOUT",
            `Timed out waiting for RPC reply ${request.requestId}`,
            request.requestId,
          ),
        );
      }, TIMEOUTS.rpcReplyTimeoutMs);
      setUnref(timer);

      if (signal !== undefined) {
        const onAbort = () =>
          fail(
            new SubagentRpcError(
              "RPC_ABORTED",
              "RPC request was aborted",
              request.requestId,
            ),
          );
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () =>
          signal.removeEventListener("abort", onAbort);
      }

      try {
        this.events.emit(SUBAGENT_RPC_REQUEST_EVENT, request);
      } catch (error) {
        fail(
          new SubagentRpcError(
            "RPC_EMIT_FAILED",
            error instanceof Error ? error.message : "RPC request emit failed",
            request.requestId,
          ),
        );
      }
    });
  }
}

export type SubagentLifecycleKind = "started" | "complete" | "process-terminal";

export interface SubagentLifecycleRecord {
  kind: SubagentLifecycleKind;
  runId: RunId;
  state?: string;
  success?: boolean;
  artifactRefs: readonly string[];
}

export interface SubagentLifecycleObservationOptions {
  sessionId?: string;
  isRelevantRun?: (runId: RunId) => boolean;
  onStarted?: (record: SubagentLifecycleRecord) => void;
  onComplete?: (record: SubagentLifecycleRecord) => void;
  onConflict?: (runId: RunId) => void;
  onProcessTerminal?: (record: SubagentLifecycleRecord) => void;
}

const LIFECYCLE_ARTIFACT_KEYS = [
  "artifactPath",
  "outputFile",
  "workflowReceiptPath",
  "sessionFile",
  "structuredOutputPath",
  "structuredOutputSchemaPath",
] as const;
const MAX_LIFECYCLE_ARTIFACT_REFS = 32;

function addArtifactRef(refs: Set<string>, value: unknown): void {
  if (
    refs.size >= MAX_LIFECYCLE_ARTIFACT_REFS ||
    typeof value !== "string" ||
    !isBoundedString(value, 4096, true) ||
    /[\0\r\n]/u.test(value)
  ) {
    return;
  }
  refs.add(value.trim());
}

function collectArtifactRefs(value: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  for (const key of LIFECYCLE_ARTIFACT_KEYS) addArtifactRef(refs, value[key]);
  const artifactPaths = value.artifactPaths;
  if (Array.isArray(artifactPaths)) {
    for (const path of artifactPaths) addArtifactRef(refs, path);
  } else if (isRecord(artifactPaths)) {
    for (const path of Object.values(artifactPaths)) addArtifactRef(refs, path);
  }
  if (Array.isArray(value.results)) {
    for (const result of value.results) {
      if (!isRecord(result)) continue;
      for (const key of LIFECYCLE_ARTIFACT_KEYS)
        addArtifactRef(refs, result[key]);
      const resultPaths = result.artifactPaths;
      if (Array.isArray(resultPaths)) {
        for (const path of resultPaths) addArtifactRef(refs, path);
      } else if (isRecord(resultPaths)) {
        for (const path of Object.values(resultPaths))
          addArtifactRef(refs, path);
      }
    }
  }
  return [...refs];
}

function lifecycleRunId(
  value: Record<string, unknown>,
  kind: SubagentLifecycleKind,
): RunId | undefined {
  const candidate =
    kind === "started" ? (value.runId ?? value.id) : value.runId;
  return normalizeRunId(candidate);
}

function lifecycleState(
  value: Record<string, unknown>,
  kind: SubagentLifecycleKind,
): string | undefined {
  const candidate =
    kind === "process-terminal" && isRecord(value.processTerminal)
      ? value.processTerminal.state
      : value.state;
  return isBoundedString(candidate, 128, true) ? candidate : undefined;
}

function isSubagentAsyncTerminalState(
  value: string,
): value is SubagentAsyncTerminalState {
  return (SUBAGENT_ASYNC_TERMINAL_STATES as readonly string[]).includes(value);
}

function sameLifecycleRecord(
  left: SubagentLifecycleRecord,
  right: SubagentLifecycleRecord,
): boolean {
  return (
    left.state === right.state &&
    left.success === right.success &&
    left.artifactRefs.length === right.artifactRefs.length &&
    left.artifactRefs.every((ref, index) => ref === right.artifactRefs[index])
  );
}

function lifecycleRecord(
  value: unknown,
  kind: SubagentLifecycleKind,
  sessionId: string | undefined,
): SubagentLifecycleRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (
    sessionId !== undefined &&
    value.sessionId !== undefined &&
    value.sessionId !== sessionId
  ) {
    return undefined;
  }
  const runId = lifecycleRunId(value, kind);
  if (runId === undefined) return undefined;
  const record: SubagentLifecycleRecord = {
    kind,
    runId,
    artifactRefs: kind === "started" ? [] : collectArtifactRefs(value),
  };
  const state = lifecycleState(value, kind);
  if (
    kind === "complete" &&
    (state === undefined || !isSubagentAsyncTerminalState(state))
  ) {
    return undefined;
  }
  if (state !== undefined) record.state = state;
  if (typeof value.success === "boolean") record.success = value.success;
  return record;
}

export function registerSubagentLifecycleObservation(
  events: SubagentRpcEventBus,
  options: SubagentLifecycleObservationOptions = {},
): () => void {
  const startedRuns = new Set<RunId>();
  const completedRuns = new Map<RunId, SubagentLifecycleRecord>();
  const removeStarted = events.on(SUBAGENT_ASYNC_STARTED_EVENT, (value) => {
    const record = lifecycleRecord(value, "started", options.sessionId);
    if (record === undefined || startedRuns.has(record.runId)) return;
    startedRuns.add(record.runId);
    options.onStarted?.(record);
  });
  const removeComplete = events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (value) => {
    const record = lifecycleRecord(value, "complete", options.sessionId);
    if (
      record === undefined ||
      options.isRelevantRun?.(record.runId) === false
    ) {
      return;
    }
    const previous = completedRuns.get(record.runId);
    if (previous !== undefined) {
      if (!sameLifecycleRecord(previous, record)) {
        options.onConflict?.(record.runId);
      }
      return;
    }
    completedRuns.set(record.runId, record);
    options.onComplete?.(record);
  });
  const removeProcessTerminal = events.on(
    SUBAGENT_PROCESS_TERMINAL_EVENT,
    (value) => {
      const record = lifecycleRecord(
        value,
        "process-terminal",
        options.sessionId,
      );
      if (record === undefined) return;
      options.onProcessTerminal?.(record);
    },
  );
  return () => {
    removeStarted();
    removeComplete();
    removeProcessTerminal();
    startedRuns.clear();
    completedRuns.clear();
  };
}
