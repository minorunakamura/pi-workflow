import {
  createAgentSession,
  createEventBus,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import { withGoldenRepository } from "../fixtures/golden-repositories.js";
import type { AgentExecutionRequestV1 } from "../../src/contracts/execution/agent-execution.js";
import type { RunId } from "../../src/domain/primitives/ids.js";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const { registerPromptTemplateDelegationBridge } = await import(
  /* @vite-ignore */
  pathToFileURL(
    resolve(PROJECT_ROOT, "node_modules/pi-subagents/src/slash/prompt-template-bridge.ts"),
  ).href
);
const { registerSlashSubagentBridge } = await import(
  /* @vite-ignore */
  pathToFileURL(resolve(PROJECT_ROOT, "node_modules/pi-subagents/src/slash/slash-bridge.ts")).href
);

type SlashParams = Record<string, unknown>;

type SlashResult = {
  content: [{ type: "text"; text: string }];
  details: {
    mode: "single";
    results: [
      {
        index: 0;
        agent: string;
        task: string;
        exitCode: 0;
        usage: {
          input: 0;
          output: 0;
          cacheRead: 0;
          cacheWrite: 0;
          cost: 0;
          turns: 0;
          toolCalls: 0;
          durationMs: 0;
        };
        structuredOutput: Record<string, unknown>;
      },
    ];
  };
};

function textFromTask(task: string): string {
  const marker = "Execution request (JSON):";
  const start = task.indexOf(marker);
  if (start < 0) throw new Error("Delegated task did not carry an execution request");
  const end = task.indexOf("\n\nReturn only", start);
  if (end < 0) throw new Error("Delegated task did not carry a bounded execution request");
  return task.slice(start + marker.length, end).trim();
}

function requestFromParams(params: SlashParams): AgentExecutionRequestV1 {
  const task = typeof params.task === "string" ? params.task : undefined;
  if (task !== undefined) return JSON.parse(textFromTask(task)) as AgentExecutionRequestV1;

  const script = typeof params.workflowScript === "string" ? params.workflowScript : "";
  const marker = 'runs.run("main", ';
  const start = script.indexOf(marker);
  if (start < 0 || !script.endsWith(")")) {
    throw new Error("Slash bridge did not preserve the delegated child task");
  }
  const child = JSON.parse(script.slice(start + marker.length, -1)) as { task?: unknown };
  if (typeof child.task !== "string") throw new Error("Slash bridge child task is missing");
  return JSON.parse(textFromTask(child.task)) as AgentExecutionRequestV1;
}

function stepResult(request: AgentExecutionRequestV1): Record<string, unknown> {
  return {
    identity: {
      runId: request.identity.runId,
      stepId: request.identity.stepId,
      executionId: request.identity.executionId,
    },
    outcome: "completed",
    mode: request.execution.mode,
    summary: `accepted:${request.identity.agentId}`,
    artifacts: [],
    uncertainty_candidates: [],
    decision_requests: [],
    requirement_candidates: { acceptance_criteria: [], constraints: [], assumptions: [] },
    finding_candidates: [],
    finding_rechecks: [],
    plan_deviations: [],
    skill_requests: [],
    execution_checks:
      request.identity.agentId === "verifier"
        ? [{ type: "test", status: "passed", required: true, evidence: { exit_code: 0 } }]
        : [],
    observations: request.identity.agentId === "planner" ? [{ write_scope: ["src"] }] : [],
    blocked: null,
    failure: null,
    runtime: {},
  };
}

function ui(notifications: string[]): ExtensionUIContext {
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (message: string) => notifications.push(message),
  } as unknown as ExtensionUIContext;
}

function bridgeExtension(seenContexts: object[], seenAgents: string[]): (pi: ExtensionAPI) => void {
  return (pi) => {
    registerPromptTemplateDelegationBridge({
      events: pi.events,
      getContext: () => null,
      execute: async () => ({ isError: true, content: [{ type: "text", text: "unexpected" }] }),
    });
    registerSlashSubagentBridge({
      events: pi.events,
      getContext: () => null,
      execute: async (
        _id: string,
        params: SlashParams,
        _signal: AbortSignal,
        _onUpdate: unknown,
        context: ExtensionContext,
      ): Promise<SlashResult> => {
        seenContexts.push(context);
        const request = requestFromParams(params);
        seenAgents.push(request.identity.agentId);
        return {
          content: [{ type: "text", text: "bridge accepted" }],
          details: {
            mode: "single",
            results: [
              {
                index: 0,
                agent: request.identity.agentId,
                task: request.objective.objective,
                exitCode: 0,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  cost: 0,
                  turns: 0,
                  toolCalls: 0,
                  durationMs: 0,
                },
                structuredOutput: stepResult(request),
              },
            ],
          },
        };
      },
    });
  };
}

function workflowPi(
  cwd: string,
  events: ReturnType<typeof createEventBus>,
  extensionFactories: Array<(pi: ExtensionAPI) => void>,
  settingsManager: SettingsManager,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    eventBus: events,
    additionalExtensionPaths: [`${PROJECT_ROOT}/src/extensions/workflow.ts`],
    additionalSkillPaths: [`${PROJECT_ROOT}/skills`],
    skillsOverride: ({ skills, diagnostics }) => ({
      skills: skills.map((skill) => ({
        ...skill,
        sourceInfo: createSyntheticSourceInfo(skill.filePath, {
          source: "pi-workflow",
          scope: "project",
          origin: "package",
        }),
      })),
      diagnostics,
    }),
    extensionFactories,
  });
}

describe("interactive command context lifecycle", () => {
  it("runs the default production path when the cached structured-bridge context is unavailable", async () => {
    await withGoldenRepository("feature", { ".gitignore": ".pi/\n" }, async (repositoryRoot) => {
      const events = createEventBus();
      const seenContexts: object[] = [];
      const seenAgents: string[] = [];
      const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
      const resourceLoader = workflowPi(
        repositoryRoot,
        events,
        [bridgeExtension(seenContexts, seenAgents)],
        settingsManager,
      );
      await resourceLoader.reload();
      const faux = fauxProvider({
        provider: "pi-workflow-command-context",
        models: [{ id: "test", input: ["text"], reasoning: false }],
      });
      const sessionResult = await createAgentSession({
        cwd: repositoryRoot,
        model: faux.getModel(),
        resourceLoader,
        sessionManager: SessionManager.inMemory(repositoryRoot),
        settingsManager,
      });
      const notifications: string[] = [];

      try {
        await sessionResult.session.bindExtensions({
          mode: "json",
          uiContext: ui(notifications),
        });
        await sessionResult.session.prompt("/wf-feature command context regression", {
          expandPromptTemplates: true,
        });

        await expect(
          new FileRunReader(repositoryRoot).load("run-001" as RunId),
        ).resolves.toMatchObject({
          run: { status: "completed", finalized: true },
        });
        expect(seenAgents).toEqual(["scout", "planner", "worker", "verifier", "reviewer"]);
        expect(seenContexts).toHaveLength(seenAgents.length);
        expect(notifications.join("\n")).not.toContain("unavailable_context");
      } finally {
        sessionResult.session.dispose();
      }
    });
  }, 30_000);
});
