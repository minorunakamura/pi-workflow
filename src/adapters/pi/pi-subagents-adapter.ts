import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
  type SubagentDelegationThinking,
} from "pi-subagents/delegation";
import {
  parseStepResultV1,
  type AgentExecutionRequestV1,
  type StepResultV1,
} from "../../contracts/execution/agent-execution.js";
import type { AgentRuntime } from "../../ports/agent-runtime.js";

const MAX_DELEGATION_TIMEOUT_MS = 2_147_483_647;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type PiEventBus = ExtensionAPI["events"];

export type PiSubagentsAdapterOptions = Readonly<{
  cwd?: string;
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

function resolveModel(request: AgentExecutionRequestV1): string | undefined {
  for (const candidate of [request.model.actual, request.model.requested]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return undefined;
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

function abortError(): Error {
  const error = new Error("PiSubagents Agent Execution was aborted");
  error.name = "AbortError";
  return error;
}

export class PiSubagentsAdapter implements AgentRuntime {
  private readonly events: PiEventBus;
  private readonly cwd: string;

  constructor(pi: Pick<ExtensionAPI, "events">, options: PiSubagentsAdapterOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    if (cwd.trim().length === 0) {
      throw new Error("PiSubagentsAdapter cwd must not be empty");
    }
    this.events = pi.events;
    this.cwd = cwd;
  }

  async run(
    request: AgentExecutionRequestV1,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<StepResultV1> {
    const response = await this.execute(request, signal);
    if (response.status !== "completed") {
      throw new Error(
        `PiSubagents Agent Execution ${response.status}: ${response.error ?? "no error details"}`,
      );
    }
    if (response.result?.kind !== "structured") {
      throw new Error("PiSubagents Agent Execution did not return a structured StepResultV1");
    }
    return parseStepResultV1(response.result.value);
  }

  private execute(
    request: AgentExecutionRequestV1,
    signal: AbortSignal,
  ): Promise<SubagentDelegationResponse> {
    const delegationRequest = createDelegationRequest(request, this.cwd);

    if (signal.aborted) {
      return Promise.reject(abortError());
    }

    return new Promise<SubagentDelegationResponse>((resolve, reject) => {
      let sent = false;
      let settled = false;
      let unsubscribe: (() => void) | undefined;

      const cleanup = (): void => {
        unsubscribe?.();
        signal.removeEventListener("abort", onAbort);
      };
      const resolveResponse = (response: SubagentDelegationResponse): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(response);
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

      unsubscribe = this.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, onResponse);
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
