import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
  type SubagentDelegationThinking,
  type SubagentDelegationUpdate,
  type SubagentDelegationUsage,
} from "pi-subagents/delegation";
import {
  parseStepResultV1,
  type AgentExecutionRequestV1,
  type JsonValue,
  type StepResultV1,
} from "../../contracts/execution/agent-execution.js";
import type { AgentRuntime } from "../../ports/agent-runtime.js";
import {
  attachRuntimeTelemetry,
  captureRuntimeTelemetry,
  type RuntimeTelemetryUsage,
  type TelemetryLevel,
} from "../../telemetry/runtime-metrics.js";

const MAX_DELEGATION_TIMEOUT_MS = 2_147_483_647;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type PiEventBus = ExtensionAPI["events"];

type ExecutionObservation = Readonly<{
  toolCount?: number;
  durationMs?: number;
  tokens?: number;
  toolsUsed: ReadonlySet<string>;
}>;

type AgentRuntimeExecution = Readonly<{
  response: SubagentDelegationResponse;
  observation: ExecutionObservation;
}>;

export type PiSubagentsAdapterOptions = Readonly<{
  cwd?: string;
  telemetryLevel?: TelemetryLevel;
}>;

const resultArraySchema = { type: "array" } as const;
const candidateArraySchema = { type: "array", items: { type: "object" } } as const;

/** The structured result boundary is checked again by StepResultV1Schema below. */
export const STEP_RESULT_SCHEMA = {
  type: "object",
  properties: {
    identity: {
      type: "object",
      properties: {
        runId: { type: "string" },
        stepId: { type: "string" },
        executionId: { type: "string" },
      },
      required: ["runId", "stepId", "executionId"],
      additionalProperties: false,
    },
    outcome: { enum: ["completed", "blocked", "failed"] },
    mode: { enum: ["read-only", "write", "verify-only"] },
    summary: { type: "string" },
    artifacts: resultArraySchema,
    uncertainty_candidates: candidateArraySchema,
    decision_requests: candidateArraySchema,
    requirement_candidates: {
      type: "object",
      properties: {
        acceptance_criteria: candidateArraySchema,
        constraints: candidateArraySchema,
        assumptions: candidateArraySchema,
      },
      required: ["acceptance_criteria", "constraints", "assumptions"],
      additionalProperties: false,
    },
    finding_candidates: candidateArraySchema,
    finding_rechecks: candidateArraySchema,
    plan_deviations: candidateArraySchema,
    skill_requests: candidateArraySchema,
    execution_checks: candidateArraySchema,
    observations: candidateArraySchema,
    blocked: { anyOf: [{ type: "object" }, { type: "null" }] },
    failure: { anyOf: [{ type: "object" }, { type: "null" }] },
    runtime: { type: "object" },
  },
  required: [
    "identity",
    "outcome",
    "summary",
    "artifacts",
    "uncertainty_candidates",
    "decision_requests",
    "requirement_candidates",
    "finding_candidates",
    "finding_rechecks",
    "plan_deviations",
    "skill_requests",
    "execution_checks",
    "observations",
    "blocked",
    "failure",
    "runtime",
  ],
  additionalProperties: false,
} as const satisfies Record<string, unknown>;

function isThinkingLevel(value: string): value is SubagentDelegationThinking {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function modelId(value: JsonValue, label: string, allowNull = false): string | undefined {
  if (value === null) {
    if (allowNull) return undefined;
    throw new Error(`${label} must be a model ID or { provider, model }`);
  }
  if (typeof value === "string") {
    const model = value.trim();
    if (model.length > 0) return model;
  } else if (isJsonObject(value)) {
    const provider = value.provider;
    const model = value.model;
    if (
      typeof provider === "string" &&
      provider.trim().length > 0 &&
      typeof model === "string" &&
      model.trim().length > 0
    ) {
      return `${provider.trim()}/${model.trim()}`;
    }
  }
  throw new Error(`${label} must be a model ID or { provider, model }`);
}

function resolveModel(request: AgentExecutionRequestV1): string | undefined {
  const requested = modelId(request.model.requested, "Requested model", true);
  const fallbacks = request.model.allowedFallback.map((candidate, index) =>
    modelId(candidate, `Allowed fallback model [${index}]`),
  );
  const actual =
    request.model.actual === null ? undefined : modelId(request.model.actual, "Actual model");
  const configured = new Set(
    [requested, ...fallbacks].filter((value): value is string => value !== undefined),
  );

  if (actual !== undefined && !configured.has(actual)) {
    throw new Error("Actual model must be the requested model or a configured fallback");
  }
  return actual ?? requested;
}

function resolveSkills(request: AgentExecutionRequestV1): string[] {
  return [
    ...new Set([
      ...request.skills.required.map(({ id }) => id),
      ...request.skills.optional.map(({ id }) => id),
    ]),
  ];
}

function createTask(request: AgentExecutionRequestV1): string {
  return [
    "Execute exactly one Workflow Agent Execution.",
    request.objective.objective,
    "Execution request (JSON):",
    JSON.stringify(request),
    "Return only the StepResultV1 structured result and preserve the request identity.",
  ].join("\n\n");
}

function createDelegationRequest(
  request: AgentExecutionRequestV1,
  cwd: string,
): SubagentDelegationRequest {
  const timeoutMs = request.execution.timeoutMs;
  if (timeoutMs > MAX_DELEGATION_TIMEOUT_MS) {
    throw new RangeError(`Agent execution timeoutMs must be <= ${MAX_DELEGATION_TIMEOUT_MS}`);
  }

  const thinkingLevel = request.model.thinkingLevel;
  if (!isThinkingLevel(thinkingLevel)) {
    throw new Error(`Unsupported Agent execution thinking level: ${thinkingLevel}`);
  }

  const model = resolveModel(request);
  const skills = resolveSkills(request);

  return {
    requestId: request.identity.executionId,
    ownerRunId: request.identity.runId,
    nodeId: request.identity.stepId,
    agent: request.identity.agentId,
    task: createTask(request),
    context: "fresh",
    cwd,
    ...(model ? { model } : {}),
    thinking: thinkingLevel,
    ...(timeoutMs > 0 ? { timeoutMs } : {}),
    ...(skills.length > 0 ? { skill: skills } : {}),
    result: { kind: "structured", schema: STEP_RESULT_SCHEMA },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResponseFor(
  payload: unknown,
  request: SubagentDelegationRequest,
): payload is SubagentDelegationResponse {
  if (!isRecord(payload)) return false;
  return (
    payload.requestId === request.requestId &&
    payload.ownerRunId === request.ownerRunId &&
    payload.nodeId === request.nodeId
  );
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function observeUpdate(
  payload: SubagentDelegationUpdate,
  observation: {
    toolCount?: number;
    durationMs?: number;
    tokens?: number;
    toolsUsed: Set<string>;
  },
): void {
  const toolCount = nonNegativeNumber(payload.toolCount);
  if (toolCount !== undefined) {
    observation.toolCount = Math.max(observation.toolCount ?? 0, toolCount);
  }
  const durationMs = nonNegativeNumber(payload.durationMs);
  if (durationMs !== undefined) {
    observation.durationMs = Math.max(observation.durationMs ?? 0, durationMs);
  }
  const tokens = nonNegativeNumber(payload.tokens);
  if (tokens !== undefined) {
    observation.tokens = Math.max(observation.tokens ?? 0, tokens);
  }
  if (typeof payload.currentTool === "string" && payload.currentTool.trim().length > 0) {
    observation.toolsUsed.add(payload.currentTool.trim());
  }
  for (const tool of Array.isArray(payload.recentTools) ? payload.recentTools : []) {
    if (isRecord(tool) && typeof tool.tool === "string" && tool.tool.trim().length > 0) {
      observation.toolsUsed.add(tool.tool.trim());
    }
  }
}

function runtimeUsage(
  usage: SubagentDelegationUsage | undefined,
  observation: ExecutionObservation,
): RuntimeTelemetryUsage | undefined {
  if (usage === undefined) {
    return observation.durationMs === undefined &&
      observation.toolCount === undefined &&
      observation.tokens === undefined
      ? undefined
      : {
          ...(observation.durationMs === undefined ? {} : { executionMs: observation.durationMs }),
          ...(observation.toolCount === undefined ? {} : { toolCalls: observation.toolCount }),
          ...(observation.tokens === undefined ? {} : { totalTokens: observation.tokens }),
        };
  }
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.input + usage.output,
    cachedInputTokens: usage.cacheRead,
    cost: usage.cost,
    executionMs: usage.durationMs,
    toolCalls: Math.max(usage.toolCalls, observation.toolCount ?? 0),
  };
}

function abortError(): Error {
  const error = new Error("PiSubagents Agent Execution was aborted");
  error.name = "AbortError";
  return error;
}

export class PiSubagentsAdapter implements AgentRuntime {
  private readonly events: PiEventBus;
  private readonly cwd: string;
  private readonly telemetryLevel: TelemetryLevel | undefined;

  constructor(pi: Pick<ExtensionAPI, "events">, options: PiSubagentsAdapterOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    if (cwd.trim().length === 0) {
      throw new Error("PiSubagentsAdapter cwd must not be empty");
    }
    this.events = pi.events;
    this.cwd = cwd;
    this.telemetryLevel = options.telemetryLevel;
  }

  async run(
    request: AgentExecutionRequestV1,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<StepResultV1> {
    const started = performance.now();
    const execution = await this.execute(request, signal);
    const response = execution.response;
    if (response.status !== "completed") {
      throw new Error(
        `PiSubagents Agent Execution ${response.status}: ${response.error ?? "no error details"}`,
      );
    }
    if (response.result?.kind !== "structured") {
      throw new Error("PiSubagents Agent Execution did not return a structured StepResultV1");
    }
    const result = parseStepResultV1(response.result.value);
    const wallClockMs = Math.max(0, Math.round(performance.now() - started));
    const usage = runtimeUsage(response.usage, execution.observation);
    const telemetry = captureRuntimeTelemetry(request, {
      ...(this.telemetryLevel === undefined ? {} : { level: this.telemetryLevel }),
      wallClockMs,
      ...(response.model === undefined ? {} : { model: response.model }),
      ...(usage === undefined ? {} : { usage }),
      ...(execution.observation.toolsUsed.size === 0
        ? {}
        : { toolsUsed: [...execution.observation.toolsUsed] }),
    });
    return attachRuntimeTelemetry(result, telemetry);
  }

  private execute(
    request: AgentExecutionRequestV1,
    signal: AbortSignal,
  ): Promise<AgentRuntimeExecution> {
    const delegationRequest = createDelegationRequest(request, this.cwd);

    if (signal.aborted) {
      return Promise.reject(abortError());
    }

    const observation = { toolsUsed: new Set<string>() };
    return new Promise<AgentRuntimeExecution>((resolve, reject) => {
      let sent = false;
      let settled = false;
      let unsubscribeResponse: (() => void) | undefined;
      let unsubscribeUpdate: (() => void) | undefined;

      const cleanup = (): void => {
        unsubscribeResponse?.();
        unsubscribeUpdate?.();
        signal.removeEventListener("abort", onAbort);
      };
      const resolveResponse = (response: SubagentDelegationResponse): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ response, observation });
      };
      const rejectExecution = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onResponse = (payload: unknown): void => {
        if (isResponseFor(payload, delegationRequest)) {
          resolveResponse(payload);
        }
      };
      const onUpdate = (payload: unknown): void => {
        if (
          !isRecord(payload) ||
          payload.requestId !== delegationRequest.requestId ||
          payload.ownerRunId !== delegationRequest.ownerRunId ||
          payload.nodeId !== delegationRequest.nodeId
        ) {
          return;
        }
        observeUpdate(payload as unknown as SubagentDelegationUpdate, observation);
      };
      const onAbort = (): void => {
        if (sent) {
          this.events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, {
            requestId: delegationRequest.requestId,
            ownerRunId: delegationRequest.ownerRunId,
            nodeId: delegationRequest.nodeId,
          });
        }
        rejectExecution(abortError());
      };

      unsubscribeResponse = this.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, onResponse);
      unsubscribeUpdate = this.events.on(SUBAGENT_DELEGATION_UPDATE_EVENT, onUpdate);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        sent = true;
        this.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, delegationRequest);
      } catch (error) {
        rejectExecution(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
