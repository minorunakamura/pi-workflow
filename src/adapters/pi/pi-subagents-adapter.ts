import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import { registerSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";
import {
  parseStepResultV1,
  STEP_RESULT_AGENT_OUTPUT_INSTRUCTIONS,
  type AgentExecutionRequestV1,
  type JsonObject,
  type JsonValue,
  type StepResultV1,
} from "../../contracts/execution/agent-execution.js";
import { validateAgentExecutionRequest } from "../../agents/permission-policy.js";
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

// The structured delegation contract does not carry ExtensionContext. The
// command-aware slash bridge is the Pi-supported requester-context boundary.
const PI_SUBAGENT_SLASH_REQUEST_EVENT = "subagent:slash:request";
const PI_SUBAGENT_SLASH_STARTED_EVENT = "subagent:slash:started";
const PI_SUBAGENT_SLASH_RESPONSE_EVENT = "subagent:slash:response";
const PI_SUBAGENT_SLASH_UPDATE_EVENT = "subagent:slash:update";
const PI_SUBAGENT_SLASH_CANCEL_EVENT = "subagent:slash:cancel";

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
  sessionId?: string;
  telemetryLevel?: TelemetryLevel;
  buildPrompt?: (request: AgentExecutionRequestV1) => string;
  getContext?: () => ExtensionContext | null | undefined;
}>;

export class PiSubagentsContextUnavailableError extends Error {
  readonly code = "PI_EXTENSION_CONTEXT_UNAVAILABLE";
  readonly category = "context" as const;
  readonly retryable = true;
  readonly recoverable = true;

  constructor(message = "No active Pi extension context for Agent delegation.") {
    super(`PI_EXTENSION_CONTEXT_UNAVAILABLE: ${message}`);
    this.name = "PiSubagentsContextUnavailableError";
  }
}

export class PiSubagentsToolCapabilityError extends Error {
  readonly code = "TOOL_CAPABILITY_DENIED";

  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(`TOOL_CAPABILITY_DENIED: ${message}`);
    this.name = "PiSubagentsToolCapabilityError";
  }
}

const resultArraySchema = { type: "array" } as const;
const candidateArraySchema = {
  type: "array",
  items: {
    type: "object",
    description:
      "Semantic candidate content only; authoritative identity is assigned by the Orchestrator.",
  },
} as const;

/** The structured result boundary is checked again by StepResultV1Schema below. */
export const STEP_RESULT_SCHEMA = {
  type: "object",
  description:
    "StepResultV1 from an Agent. Candidate objects are semantic-only; the Orchestrator allocates authoritative identity after validation.",
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

function toolNames(value: unknown, label: string): Set<string> {
  if (!Array.isArray(value)) {
    throw new Error(`PiSubagents ${label} must be an array of Tool names`);
  }
  const names = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`PiSubagents ${label}[${index}] must be a non-empty Tool name`);
    }
    names.add(entry.trim());
  }
  return names;
}

function resolvedToolNames(request: AgentExecutionRequestV1): ReadonlySet<string> {
  const resolved = toolNames(request.tools.resolved, "tools.resolved");
  const policy = isRecord(request.tools.policy) ? request.tools.policy : {};
  const allow =
    policy.allow === undefined ? undefined : toolNames(policy.allow, "tools.policy.allow");
  const deny =
    policy.deny === undefined ? new Set<string>() : toolNames(policy.deny, "tools.policy.deny");

  for (const tool of resolved) {
    if (allow !== undefined && !allow.has(tool)) {
      throw new PiSubagentsToolCapabilityError(
        tool,
        `Tool ${tool} is not allowed by the resolved Tool policy`,
      );
    }
    if (deny.has(tool)) {
      throw new PiSubagentsToolCapabilityError(
        tool,
        `Tool ${tool} is denied by the resolved Tool policy`,
      );
    }
  }
  return new Set([...resolved].filter((tool) => !deny.has(tool)));
}

function createTask(request: AgentExecutionRequestV1, prompt?: string): string {
  return [
    "Execute exactly one Workflow Agent Execution.",
    request.objective.objective,
    ...(prompt === undefined
      ? []
      : [
          "Resolved Workflow Prompt (assembled from the selected Skill content and execution inputs):",
          prompt,
        ]),
    STEP_RESULT_AGENT_OUTPUT_INSTRUCTIONS,
    "Execution request (JSON):",
    JSON.stringify(request),
    "Return only the StepResultV1 structured result and preserve the request identity.",
  ].join("\n\n");
}

function createDelegationRequest(
  request: AgentExecutionRequestV1,
  cwd: string,
  prompt?: string,
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
    task: createTask(request, prompt),
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

function debugDiagnostics(
  response: SubagentDelegationResponse,
  observation: ExecutionObservation,
): JsonObject {
  const model = "model" in response ? response.model : undefined;
  const thinking = "thinking" in response ? response.thinking : undefined;
  const exitCode = "exitCode" in response ? response.exitCode : undefined;
  const launchContractDigest =
    "launchContractDigest" in response ? response.launchContractDigest : undefined;
  return {
    status: response.status,
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(exitCode === undefined ? {} : { exit_code: exitCode }),
    ...(launchContractDigest === undefined ? {} : { launch_contract_digest: launchContractDigest }),
    observation: {
      ...(observation.toolCount === undefined ? {} : { tool_count: observation.toolCount }),
      ...(observation.durationMs === undefined ? {} : { duration_ms: observation.durationMs }),
      ...(observation.tokens === undefined ? {} : { tokens: observation.tokens }),
      tools_used: [...observation.toolsUsed],
    },
  };
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

type SlashSubagentParams = Record<string, unknown>;
type SlashSubagentRequest = Readonly<{
  requestId: string;
  params: SlashSubagentParams;
  ctx: ExtensionContext;
}>;
type SlashSubagentChild = Record<string, unknown>;
type SlashSubagentToolResult = Readonly<{
  isError?: boolean;
  content?: unknown;
  details?: { results?: readonly unknown[] };
}>;
type SlashSubagentResponse = Readonly<{
  requestId: string;
  result?: SlashSubagentToolResult;
  isError?: boolean;
  errorText?: string;
}>;

function slashChild(result: SlashSubagentToolResult | undefined): SlashSubagentChild | undefined {
  const child = result?.details?.results?.[0];
  return isRecord(child) ? child : undefined;
}

function firstText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const part of value) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
    if (part.text.trim().length > 0) return part.text.trim();
  }
  return undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function slashUsage(value: unknown): SubagentDelegationUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = nonNegativeInteger(value.input);
  const output = nonNegativeInteger(value.output);
  const cacheRead = nonNegativeInteger(value.cacheRead);
  const cacheWrite = nonNegativeInteger(value.cacheWrite);
  const turns = nonNegativeInteger(value.turns);
  const toolCalls = nonNegativeInteger(value.toolCalls);
  const durationMs = nonNegativeInteger(value.durationMs);
  const cost =
    typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0
      ? value.cost
      : undefined;
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    turns === undefined ||
    toolCalls === undefined ||
    durationMs === undefined ||
    cost === undefined
  ) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, cost, turns, toolCalls, durationMs };
}

function contextError(value: string | undefined): boolean {
  return (
    value !== undefined &&
    /active extension context|extension ctx is stale|extension context no longer active/i.test(
      value,
    )
  );
}

function slashDelegationResponse(
  request: SubagentDelegationRequest,
  payload: SlashSubagentResponse,
): SubagentDelegationResponse {
  const result = payload.result;
  const child = slashChild(result);
  const error =
    (typeof child?.error === "string" && child.error) ||
    payload.errorText ||
    firstText(result?.content) ||
    "PiSubagents slash Agent Execution failed";
  const contextUnavailable = contextError(error);
  const timedOut = child?.timedOut === true;
  const cancelled = /cancelled|canceled/i.test(error);
  const interrupted = child?.interrupted === true || child?.stopped === true;
  const structuredOutputFailed = child?.structuredOutputFailed === true;
  const turnBudgetExceeded = child?.turnBudgetExceeded === true;
  const toolBudgetBlocked = child?.toolBudgetBlocked === true;
  const structuredOutputPresent = child !== undefined && Object.hasOwn(child, "structuredOutput");
  const status: SubagentDelegationResponse["status"] = contextUnavailable
    ? "unavailable_context"
    : timedOut
      ? "timed_out"
      : cancelled
        ? "cancelled"
        : interrupted
          ? "interrupted"
          : structuredOutputFailed
            ? "structured_output_failed"
            : turnBudgetExceeded
              ? "turn_budget_exhausted"
              : toolBudgetBlocked
                ? "tool_budget_exhausted"
                : payload.isError === true || result?.isError === true || child?.error !== undefined
                  ? "failed"
                  : structuredOutputPresent
                    ? "completed"
                    : "failed";
  const usage = slashUsage(child?.usage);
  return {
    requestId: request.requestId,
    ownerRunId: request.ownerRunId,
    nodeId: request.nodeId,
    status,
    ...(typeof child?.agent === "string" ? { agent: child.agent } : {}),
    ...(typeof child?.model === "string" ? { model: child.model } : {}),
    ...(typeof child?.thinking === "string" ? { thinking: child.thinking } : {}),
    ...(usage === undefined ? {} : { usage }),
    ...(status === "completed"
      ? { result: { kind: "structured" as const, value: child?.structuredOutput } }
      : { error }),
  };
}

function slashRequest(
  request: SubagentDelegationRequest,
  context: ExtensionContext,
): SlashSubagentRequest {
  return {
    requestId: request.requestId,
    ctx: context,
    params: {
      agent: request.agent,
      task: request.task,
      context: request.context,
      cwd: request.cwd,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.toolBudget === undefined ? {} : { toolBudget: request.toolBudget }),
      ...(request.skill === undefined ? {} : { skill: request.skill }),
      ...(request.artifacts === undefined ? {} : { artifacts: request.artifacts }),
      output: false,
      outputSchema: STEP_RESULT_SCHEMA,
      acceptance: false,
      async: false,
      foregroundOnly: true,
    },
  };
}

export class PiSubagentsAdapter implements AgentRuntime {
  private readonly events: PiEventBus;
  private readonly cwd: string;
  private readonly sessionId: string | undefined;
  private readonly telemetryLevel: TelemetryLevel | undefined;
  private readonly buildPrompt: ((request: AgentExecutionRequestV1) => string) | undefined;
  private readonly getContext: (() => ExtensionContext | null | undefined) | undefined;

  constructor(pi: Pick<ExtensionAPI, "events">, options: PiSubagentsAdapterOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    if (cwd.trim().length === 0) {
      throw new Error("PiSubagentsAdapter cwd must not be empty");
    }
    this.events = pi.events;
    this.cwd = cwd;
    if (options.sessionId !== undefined && options.sessionId.trim().length === 0) {
      throw new Error("PiSubagentsAdapter sessionId must not be empty");
    }
    this.sessionId = options.sessionId;
    this.telemetryLevel = options.telemetryLevel;
    this.buildPrompt = options.buildPrompt;
    this.getContext = options.getContext;
  }

  async run(
    request: AgentExecutionRequestV1,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<StepResultV1> {
    const validatedRequest = validateAgentExecutionRequest(request);
    const allowedTools = resolvedToolNames(validatedRequest);
    const started = performance.now();
    const prompt = this.buildPrompt?.(validatedRequest);
    if (prompt !== undefined && prompt.trim().length === 0) {
      throw new Error("PiSubagentsAdapter assembled prompt must not be empty");
    }
    const context = this.activeContext();
    const execution = await this.executeWithCapabilityCeiling(
      validatedRequest,
      allowedTools,
      async () => {
        if (context === undefined) return this.execute(validatedRequest, signal, prompt);
        const structured = await this.execute(validatedRequest, signal, prompt);
        // Keep the owned structured contract primary. Use the command-aware bridge
        // only when that bridge explicitly cannot obtain its cached context.
        return structured.response.status === "unavailable_context"
          ? this.executeWithRequesterContext(validatedRequest, signal, prompt, context)
          : structured;
      },
    );
    const response = execution.response;
    if (response.status === "unavailable_context" || contextError(response.error)) {
      throw new PiSubagentsContextUnavailableError(response.error);
    }
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
    const telemetry = captureRuntimeTelemetry(validatedRequest, {
      ...(this.telemetryLevel === undefined ? {} : { level: this.telemetryLevel }),
      wallClockMs,
      ...(response.model === undefined ? {} : { model: response.model }),
      ...(usage === undefined ? {} : { usage }),
      ...(execution.observation.toolsUsed.size === 0
        ? {}
        : { toolsUsed: [...execution.observation.toolsUsed] }),
    });
    return attachRuntimeTelemetry(
      result,
      telemetry,
      this.telemetryLevel === "debug"
        ? { level: "debug", debug: debugDiagnostics(response, execution.observation) }
        : {},
    );
  }

  private async executeWithCapabilityCeiling(
    request: AgentExecutionRequestV1,
    allowedTools: ReadonlySet<string>,
    execute: () => Promise<AgentRuntimeExecution>,
  ): Promise<AgentRuntimeExecution> {
    if (this.sessionId === undefined) return execute();
    const capabilityCeiling = registerSubagentCapabilityCeiling({
      sessionId: this.sessionId,
      source: "pi-workflow",
      ceiling: {
        allowedAgents: [request.identity.agentId],
        allowedTools: [...allowedTools],
        denyExtensions: false,
      },
    });
    try {
      return await execute();
    } finally {
      capabilityCeiling.dispose();
    }
  }

  private activeContext(): ExtensionContext | undefined {
    if (this.getContext === undefined) return undefined;
    try {
      const context = this.getContext();
      if (context == null) throw new PiSubagentsContextUnavailableError();
      void context.cwd;
      void context.hasUI;
      void context.sessionManager;
      return context;
    } catch (error) {
      if (error instanceof PiSubagentsContextUnavailableError) throw error;
      throw new PiSubagentsContextUnavailableError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private executeWithRequesterContext(
    request: AgentExecutionRequestV1,
    signal: AbortSignal,
    prompt: string | undefined,
    context: ExtensionContext,
  ): Promise<AgentRuntimeExecution> {
    const delegationRequest = createDelegationRequest(request, this.cwd, prompt);
    return this.executeViaSlashBridge(delegationRequest, signal, context);
  }

  private execute(
    request: AgentExecutionRequestV1,
    signal: AbortSignal,
    prompt?: string,
  ): Promise<AgentRuntimeExecution> {
    const delegationRequest = createDelegationRequest(request, this.cwd, prompt);

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

  private executeViaSlashBridge(
    delegationRequest: SubagentDelegationRequest,
    signal: AbortSignal,
    context: ExtensionContext,
  ): Promise<AgentRuntimeExecution> {
    if (signal.aborted) return Promise.reject(abortError());

    const request = slashRequest(delegationRequest, context);
    const observation = { toolsUsed: new Set<string>() };
    return new Promise<AgentRuntimeExecution>((resolve, reject) => {
      let sent = false;
      let started = false;
      let settled = false;
      let unsubscribeStarted: (() => void) | undefined;
      let unsubscribeResponse: (() => void) | undefined;
      let unsubscribeUpdate: (() => void) | undefined;

      const cleanup = (): void => {
        unsubscribeStarted?.();
        unsubscribeResponse?.();
        unsubscribeUpdate?.();
        signal.removeEventListener("abort", onAbort);
      };
      const resolveResponse = (payload: SlashSubagentResponse): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ response: slashDelegationResponse(delegationRequest, payload), observation });
      };
      const rejectExecution = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onStarted = (payload: unknown): void => {
        if (isRecord(payload) && payload.requestId === request.requestId) started = true;
      };
      const onResponse = (payload: unknown): void => {
        if (!isRecord(payload) || payload.requestId !== request.requestId) return;
        resolveResponse(payload as unknown as SlashSubagentResponse);
      };
      const onUpdate = (payload: unknown): void => {
        if (!isRecord(payload) || payload.requestId !== request.requestId) return;
        observeUpdate(
          {
            ...payload,
            ownerRunId: delegationRequest.ownerRunId,
            nodeId: delegationRequest.nodeId,
          } as unknown as SubagentDelegationUpdate,
          observation,
        );
      };
      const onAbort = (): void => {
        if (sent)
          this.events.emit(PI_SUBAGENT_SLASH_CANCEL_EVENT, { requestId: request.requestId });
        rejectExecution(abortError());
      };

      unsubscribeStarted = this.events.on(PI_SUBAGENT_SLASH_STARTED_EVENT, onStarted);
      unsubscribeResponse = this.events.on(PI_SUBAGENT_SLASH_RESPONSE_EVENT, onResponse);
      unsubscribeUpdate = this.events.on(PI_SUBAGENT_SLASH_UPDATE_EVENT, onUpdate);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        sent = true;
        this.events.emit(PI_SUBAGENT_SLASH_REQUEST_EVENT, request);
        queueMicrotask(() => {
          if (!started && !settled) {
            rejectExecution(
              new PiSubagentsContextUnavailableError(
                "PiSubagents slash execution bridge is unavailable.",
              ),
            );
          }
        });
      } catch (error) {
        rejectExecution(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
