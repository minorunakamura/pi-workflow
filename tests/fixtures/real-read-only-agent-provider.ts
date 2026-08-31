import { writeFileSync } from "node:fs";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

const TOOL_AUDIT_ENV = "PI_WORKFLOW_STORY_06_05_TOOL_AUDIT";
const provider = fauxProvider({
  api: "workflow-smoke-faux",
  provider: "workflow-smoke",
  models: [
    {
      id: "fixed",
      input: ["text"],
      reasoning: false,
      contextWindow: 32_000,
      maxTokens: 4_096,
    },
  ],
});

type SmokeRequest = {
  identity: { runId: string; stepId: string; executionId: string; agentId: string };
  objective: { objective: string };
  execution: { mode: string };
  permissions: { repositoryTargets: unknown[] };
};

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n");
}

function requestFrom(context: { messages: readonly unknown[] }): SmokeRequest {
  for (const message of [...context.messages].reverse()) {
    if (!message || typeof message !== "object") continue;
    const value = message as { role?: unknown; content?: unknown };
    if (value.role !== "user") continue;
    const text = textContent(value.content);
    const marker = "Execution request (JSON):";
    const start = text.indexOf(marker);
    if (start < 0) continue;
    const jsonStart = text.indexOf("\n\n", start + marker.length);
    const jsonEnd = text.indexOf("\n\nReturn only", jsonStart + 2);
    if (jsonStart < 0 || jsonEnd < 0) continue;
    return JSON.parse(text.slice(jsonStart + 2, jsonEnd)) as SmokeRequest;
  }
  throw new Error("Smoke provider could not find an Agent Execution request");
}

function resultFor(request: SmokeRequest, recoveryAttempt: number): Record<string, unknown> {
  return {
    identity: {
      runId: request.identity.runId,
      stepId: request.identity.stepId,
      executionId: request.identity.executionId,
    },
    outcome: "completed",
    mode: request.execution.mode,
    summary: `real ${request.identity.agentId} smoke result`,
    artifacts: [],
    uncertainty_candidates: [],
    decision_requests: [],
    requirement_candidates: {
      acceptance_criteria: [],
      constraints: [],
      assumptions: [],
    },
    finding_candidates: [],
    finding_rechecks: [],
    plan_deviations: [],
    skill_requests: [],
    execution_checks: [],
    observations: [],
    blocked: null,
    failure: null,
    runtime: { recoveryAttempt },
  };
}

function response(
  context: { messages: readonly unknown[] },
  _options: unknown,
  state: { callCount: number },
) {
  const request = requestFrom(context);
  if (request.objective.objective === "schema-recovery" && state.callCount === 1) {
    const { summary: _summary, ...invalid } = resultFor(request, state.callCount);
    return fauxAssistantMessage(fauxToolCall("structured_output", { value: invalid }));
  }
  if (request.objective.objective === "read-only-permission-check" && state.callCount === 1) {
    const target = request.permissions.repositoryTargets.find(
      (value): value is string => typeof value === "string",
    );
    return fauxAssistantMessage(
      fauxToolCall("write", { path: target ?? "forbidden.txt", content: "must not be written" }),
    );
  }
  return fauxAssistantMessage(
    fauxToolCall("structured_output", { value: resultFor(request, state.callCount) }),
  );
}

provider.setResponses([response, response]);

export default function registerSmokeProvider(pi: {
  registerProvider(provider: unknown): void;
  on(event: string, handler: () => void): void;
  getActiveTools(): string[];
}): void {
  pi.registerProvider(provider.provider);
  pi.on("session_start", () => {
    const path = process.env[TOOL_AUDIT_ENV];
    if (path) writeFileSync(path, JSON.stringify(pi.getActiveTools()), "utf8");
  });
}
