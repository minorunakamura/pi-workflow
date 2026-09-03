import { appendFileSync } from "node:fs";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

const AUDIT_ENV = "PI_WORKFLOW_STORY_13_08_AUDIT";
const TARGET_ENV = "PI_WORKFLOW_STORY_13_08_TARGET";

const provider = fauxProvider({
  api: "pi-workflow-story-13-08",
  provider: "pi-workflow-story-13-08",
  models: [
    { id: "security", input: ["text"], reasoning: false, contextWindow: 32_000, maxTokens: 4_096 },
  ],
});

type SecurityRequest = {
  identity: { runId: string; stepId: string; executionId: string; agentId: string };
  execution: { mode: string };
};

type SecurityAudit = Readonly<{
  agent: string;
  call: number;
  mode: string;
  advertisedTools: string[];
  toolResults: ReadonlyArray<{ toolName: string; isError: boolean; text: string }>;
}>;

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

function requestFrom(context: { messages: readonly unknown[] }): SecurityRequest {
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
    return JSON.parse(text.slice(jsonStart + 2, jsonEnd)) as SecurityRequest;
  }
  throw new Error("Production security provider could not find an Agent Execution request");
}

function advertisedTools(context: { tools?: readonly unknown[] }): string[] {
  return (context.tools ?? []).flatMap((tool) => {
    if (!tool || typeof tool !== "object") return [];
    const name = (tool as { name?: unknown }).name;
    return typeof name === "string" ? [name] : [];
  });
}

function toolResults(context: { messages: readonly unknown[] }): SecurityAudit["toolResults"] {
  return context.messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const value = message as {
      role?: unknown;
      toolName?: unknown;
      isError?: unknown;
      content?: unknown;
    };
    if (
      value.role !== "toolResult" ||
      typeof value.toolName !== "string" ||
      typeof value.isError !== "boolean"
    ) {
      return [];
    }
    return [
      {
        toolName: value.toolName,
        isError: value.isError,
        text: textContent(value.content),
      },
    ];
  });
}

function resultFor(request: SecurityRequest): Record<string, unknown> {
  const verifier = request.identity.agentId === "verifier";
  const planner = request.identity.agentId === "planner";
  return {
    identity: {
      runId: request.identity.runId,
      stepId: request.identity.stepId,
      executionId: request.identity.executionId,
    },
    outcome: "completed",
    mode: request.execution.mode,
    summary: "production security bridge result",
    artifacts: [],
    uncertainty_candidates: [],
    decision_requests: [],
    requirement_candidates: { acceptance_criteria: [], constraints: [], assumptions: [] },
    finding_candidates: [],
    finding_rechecks: [],
    plan_deviations: [],
    skill_requests: [],
    execution_checks: verifier
      ? [{ type: "test", status: "passed", required: true, evidence: { exit_code: 0 } }]
      : [],
    observations: planner ? [{ write_scope: ["src"] }] : [],
    blocked: null,
    failure: null,
    runtime: {},
  };
}

function response(
  context: { messages: readonly unknown[]; tools?: readonly unknown[] },
  _options: unknown,
  state: { callCount: number },
) {
  const request = requestFrom(context);
  const auditPath = process.env[AUDIT_ENV];
  if (auditPath) {
    const audit: SecurityAudit = {
      agent: request.identity.agentId,
      call: state.callCount,
      mode: request.execution.mode,
      advertisedTools: advertisedTools(context),
      toolResults: toolResults(context),
    };
    appendFileSync(auditPath, `${JSON.stringify(audit)}\n`, "utf8");
  }

  const target = process.env[TARGET_ENV] ?? "src/security-sentinel.txt";
  if (request.identity.agentId === "scout" && state.callCount === 1) {
    return fauxAssistantMessage(
      fauxToolCall("edit", {
        path: target,
        edits: [{ oldText: "must remain unchanged\n", newText: "scout must not mutate\n" }],
      }),
    );
  }
  if (request.identity.agentId === "worker" && state.callCount === 1) {
    return fauxAssistantMessage(
      fauxToolCall("edit", {
        path: "src/feature.txt",
        edits: [{ oldText: "feature baseline\n", newText: "worker mutation\n" }],
      }),
    );
  }
  if (request.identity.agentId === "verifier" && state.callCount === 1) {
    return fauxAssistantMessage(
      fauxToolCall("write", { path: target, content: "verifier must not mutate\n" }),
    );
  }
  if (request.identity.agentId === "verifier" && state.callCount === 2) {
    return fauxAssistantMessage(fauxToolCall("bash", { command: `printf denied >> ${target}` }));
  }
  return fauxAssistantMessage(fauxToolCall("structured_output", { value: resultFor(request) }));
}

provider.setResponses([response, response, response, response, response]);

export default function registerProductionSecurityProvider(pi: {
  registerProvider(provider: unknown): void;
}): void {
  pi.registerProvider(provider.provider);
}
