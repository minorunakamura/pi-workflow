import { readFileSync, writeFileSync } from "node:fs";
import { readFile as readFileAsync, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createEventBus,
  createSyntheticSourceInfo,
  loadSkillsFromDir,
  type ExtensionAPI,
  type ExtensionUIContext,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
} from "pi-subagents/delegation";
import { describe, expect, it } from "vitest";
import workflowExtension from "../../src/extensions/workflow.js";
import { FileArtifactStore } from "../../src/adapters/persistence/write/file-artifact-store.js";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import { JsonlEventReader } from "../../src/adapters/persistence/read/jsonl-event-reader.js";
import { START_WORKFLOW_COMMANDS } from "../../src/application/workflow-command-handler.js";
import type { RunId } from "../../src/domain/primitives/ids.js";
import { withGoldenRepository } from "../fixtures/golden-repositories.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const PROJECT_IGNORE = ".pi/\n";

type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];
type CommandContext = Parameters<RegisteredCommand["handler"]>[1];

type Dialog =
  | Readonly<{ kind: "approval"; title: string; message: string }>
  | Readonly<{ kind: "options"; title: string; options: readonly string[] }>
  | Readonly<{ kind: "custom"; title: string; placeholder?: string }>;

function packageSkills(): ReturnType<typeof loadSkillsFromDir>["skills"] {
  return loadSkillsFromDir({
    dir: resolve(PROJECT_ROOT, "skills"),
    source: "pi-workflow",
  }).skills.map((skill) => ({
    ...skill,
    sourceInfo: createSyntheticSourceInfo(skill.filePath, {
      source: "pi-workflow",
      scope: "project",
      origin: "package",
    }),
  }));
}

function tools(): ToolInfo[] {
  return [{ name: "read" }, { name: "edit" }] as unknown as ToolInfo[];
}

function completedResult(
  request: SubagentDelegationRequest,
  decisionRequests: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    identity: {
      runId: request.ownerRunId,
      stepId: request.nodeId,
      executionId: request.requestId,
    },
    outcome: "completed",
    summary: `completed:${request.agent}`,
    artifacts: [],
    uncertainty_candidates: [],
    decision_requests: decisionRequests,
    requirement_candidates: { acceptance_criteria: [], constraints: [], assumptions: [] },
    finding_candidates: [],
    finding_rechecks: [],
    plan_deviations: [],
    skill_requests: [],
    execution_checks:
      request.agent === "verifier"
        ? [{ type: "test", status: "passed", required: true, evidence: { exit_code: 0 } }]
        : [],
    ...(request.agent === "planner" ? { plan: { write_scope: ["src"] } } : {}),
    observations: [],
    blocked: null,
    failure: null,
    runtime: {},
  };
}

function respond(
  events: ReturnType<typeof createEventBus>,
  request: SubagentDelegationRequest,
  value: Record<string, unknown>,
): void {
  events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
    requestId: request.requestId,
    ownerRunId: request.ownerRunId,
    nodeId: request.nodeId,
    status: "completed",
    result: { kind: "structured", value },
  } satisfies SubagentDelegationResponse);
}

function context(
  repositoryRoot: string,
  skills: ReturnType<typeof loadSkillsFromDir>["skills"],
  notifications: string[],
  ui?: Pick<ExtensionUIContext, "select" | "confirm" | "input">,
): CommandContext {
  return {
    cwd: repositoryRoot,
    hasUI: ui !== undefined,
    ui: {
      select: ui?.select ?? (async () => undefined),
      confirm: ui?.confirm ?? (async () => undefined),
      input: ui?.input ?? (async () => undefined),
      notify(message: string) {
        notifications.push(message);
      },
    },
    model: { provider: "test", id: "model" },
    scopedModels: [],
    modelRegistry: {
      getAvailable: () => [{ provider: "test", id: "model" }],
    },
    getSystemPromptOptions: () => ({ cwd: repositoryRoot, skills }),
  } as unknown as CommandContext;
}

function registeredCommands(
  events: ReturnType<typeof createEventBus>,
): Map<string, RegisteredCommand> {
  const registrations = new Map<string, RegisteredCommand>();
  workflowExtension({
    registerCommand(name, options) {
      registrations.set(name, options);
    },
    events,
    getAllTools: tools,
  });
  return registrations;
}

describe("Gate C default production path", () => {
  it("runs all six start commands and reads their project-local Runs through the Pi boundary", async () => {
    const skills = packageSkills();
    await withGoldenRepository(
      "feature",
      { ".gitignore": PROJECT_IGNORE },
      async (repositoryRoot) => {
        const events = createEventBus();
        const requests: SubagentDelegationRequest[] = [];
        events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
          const request = payload as SubagentDelegationRequest;
          requests.push(request);
          respond(events, request, completedResult(request));
        });

        const registrations = registeredCommands(events);
        const notifications: string[] = [];
        const reader = new FileRunReader(repositoryRoot);

        for (const [index, command] of START_WORKFLOW_COMMANDS.entries()) {
          const runId = `run-${String(index + 1).padStart(3, "0")}` as RunId;
          await registrations
            .get(`wf-${command}`)!
            .handler(
              `default production ${command}`,
              context(repositoryRoot, skills, notifications),
            );

          await expect(reader.load(runId)).resolves.toMatchObject({
            run: {
              run_id: runId,
              request: { type: command },
              status: "completed",
              finalized: true,
            },
          });
          await expect(
            readFileAsync(join(repositoryRoot, ".pi/runs", runId, "run.yaml"), "utf8"),
          ).resolves.toContain(`run_id: ${runId}`);
        }

        const statusNotifications: string[] = [];
        await registrations
          .get("wf-status")!
          .handler("run-001", context(repositoryRoot, skills, statusNotifications));

        expect(statusNotifications).toEqual([
          expect.stringContaining("Run run-001: status=completed; finalized=true"),
        ]);
        expect(new Set(requests.map(({ ownerRunId }) => ownerRunId))).toEqual(
          new Set(
            START_WORKFLOW_COMMANDS.map((_, index) => `run-${String(index + 1).padStart(3, "0")}`),
          ),
        );
        expect(requests.length).toBeGreaterThan(START_WORKFLOW_COMMANDS.length);
        expect(new Set(await Promise.all(requests.map(({ cwd }) => realpath(cwd))))).toEqual(
          new Set([await realpath(repositoryRoot)]),
        );
        expect(notifications.join("\n")).not.toContain("NOT_IMPLEMENTED");
      },
    );
  }, 30_000);

  it("routes D3 approval, options, custom, cancellation, and resume through the production UI adapter", async () => {
    const skills = packageSkills();
    await withGoldenRepository(
      "feature",
      { ".gitignore": PROJECT_IGNORE },
      async (repositoryRoot) => {
        const events = createEventBus();
        let firstRequest = true;
        events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
          const request = payload as SubagentDelegationRequest;
          const decisionRequests = firstRequest
            ? [
                {
                  class: "D3",
                  kind: "approval",
                  title: "Approve implementation",
                  message: "Approve the implementation?",
                },
                {
                  class: "D3",
                  kind: "options",
                  title: "Select strategy",
                  message: "Choose a strategy.",
                  options: ["safe", "fast"],
                },
                {
                  class: "D3",
                  kind: "custom",
                  title: "Provide note",
                  message: "Add an implementation note.",
                  placeholder: "optional note",
                },
                {
                  class: "D3",
                  kind: "approval",
                  title: "Continue workflow",
                  message: "Continue the workflow?",
                },
              ]
            : [];
          firstRequest = false;
          respond(events, request, completedResult(request, decisionRequests));
        });

        const dialogs: Dialog[] = [];
        let confirmCalls = 0;
        const ui: Pick<ExtensionUIContext, "select" | "confirm" | "input"> = {
          confirm: async (title, message) => {
            dialogs.push({ kind: "approval", title, message });
            confirmCalls += 1;
            return confirmCalls === 2 ? (undefined as unknown as boolean) : true;
          },
          select: async (title, options) => {
            dialogs.push({ kind: "options", title, options: [...options] });
            return options[1];
          },
          input: async (title, placeholder) => {
            dialogs.push({
              kind: "custom",
              title,
              ...(placeholder === undefined ? {} : { placeholder }),
            });
            return "implementation note";
          },
        };

        const registrations = registeredCommands(events);
        const notifications: string[] = [];
        const commandContext = context(repositoryRoot, skills, notifications, ui);
        const reader = new FileRunReader(repositoryRoot);

        await registrations.get("wf-feature")!.handler("D3 production path", commandContext);
        await expect(reader.load("run-001" as RunId)).resolves.toMatchObject({
          run: {
            status: "blocked",
            finalized: false,
            blocked: { reason: "user-input-required" },
          },
        });
        expect(dialogs.map(({ kind }) => kind)).toEqual([
          "approval",
          "options",
          "custom",
          "approval",
        ]);
        expect(dialogs[1]).toMatchObject({ kind: "options", options: ["safe", "fast"] });
        expect(dialogs[2]).toMatchObject({ kind: "custom", placeholder: "optional note" });
        expect(
          (await reader.load("run-001" as RunId)).snapshot.decisions.decisions.map(
            ({ status }) => status,
          ),
        ).toEqual(["resolved", "resolved", "resolved", "pending"]);

        const statusNotifications: string[] = [];
        await registrations
          .get("wf-status")!
          .handler("run-001", context(repositoryRoot, skills, statusNotifications));
        expect(statusNotifications).toEqual([
          expect.stringContaining("Run run-001: status=blocked"),
        ]);

        await registrations.get("wf-resume")!.handler("run-001", commandContext);
        await expect(reader.load("run-001" as RunId)).resolves.toMatchObject({
          run: { status: "completed", finalized: true },
        });
        expect(confirmCalls).toBe(3);
        expect(dialogs).toHaveLength(5);
        expect(notifications).toContainEqual(
          expect.stringContaining("Run run-001 resumed: status=completed; finalized=true"),
        );

        const eventTypes = (
          await new JsonlEventReader(repositoryRoot).readAfter("run-001" as RunId, 0)
        ).map(({ type }) => type);
        expect(eventTypes).toEqual(
          expect.arrayContaining([
            "run.blocked",
            "decision.resolved",
            "run.resumed",
            "run.completed",
          ]),
        );
      },
    );
  });

  it("cancels an active default-path Worker and preserves recovery evidence", async () => {
    const skills = packageSkills();
    await withGoldenRepository(
      "feature",
      { ".gitignore": PROJECT_IGNORE },
      async (repositoryRoot) => {
        const events = createEventBus();
        const requests: SubagentDelegationRequest[] = [];
        const cancelEvents: unknown[] = [];
        let workerEnteredResolve!: () => void;
        const workerEntered = new Promise<void>((resolve) => {
          workerEnteredResolve = resolve;
        });
        events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (payload) => {
          cancelEvents.push(payload);
        });
        events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
          const request = payload as SubagentDelegationRequest;
          requests.push(request);
          if (request.agent === "worker") {
            writeFileSync(
              join(repositoryRoot, "src", "partial.txt"),
              "partial Worker mutation\n",
              "utf8",
            );
            workerEnteredResolve();
            return;
          }
          respond(events, request, completedResult(request));
        });

        const registrations = registeredCommands(events);
        const notifications: string[] = [];
        const commandContext = context(repositoryRoot, skills, notifications);
        const start = registrations
          .get("wf-feature")!
          .handler("cancel active Worker", commandContext);
        await workerEntered;

        await registrations
          .get("wf-cancel")!
          .handler("run-001 stop active execution", context(repositoryRoot, skills, notifications));
        await start;

        const state = await new FileRunReader(repositoryRoot).load("run-001" as RunId);
        expect(state.run).toMatchObject({
          status: "cancelled",
          finalized: true,
          cancellation: { requested: true, reason: "stop active execution" },
          outcome: {
            status: "cancelled",
            request_satisfied: false,
            artifact_path: "outcome.md",
          },
        });
        await expect(
          readFileAsync(join(repositoryRoot, "src", "partial.txt"), "utf8"),
        ).resolves.toBe("partial Worker mutation\n");
        await expect(
          new FileArtifactStore(repositoryRoot).read({
            runId: "run-001" as RunId,
            path: "outcome.md",
            status: "complete",
          }),
        ).resolves.toMatchObject({
          frontMatter: { artifact: { type: "outcome", status: "complete" } },
        });
        await expect(
          new FileArtifactStore(repositoryRoot).read({
            runId: "run-001" as RunId,
            path: "implementation/change-set-CS-001.md",
            status: "partial",
          }),
        ).resolves.toMatchObject({
          frontMatter: { artifact: { type: "implementation", status: "partial" } },
        });
        expect(cancelEvents).toHaveLength(1);
        expect(requests.some(({ agent }) => agent === "worker")).toBe(true);
        expect(notifications.join("\n")).not.toContain("NOT_IMPLEMENTED");

        const eventTypes = (
          await new JsonlEventReader(repositoryRoot).readAfter("run-001" as RunId, 0)
        ).map(({ type }) => type);
        expect(eventTypes).toEqual(
          expect.arrayContaining(["run.cancel-requested", "run.cancelled"]),
        );
      },
    );
  });

  it("keeps a durable Run after a Pi Agent crash and finalizes it through the default cancel path", async () => {
    const skills = packageSkills();
    await withGoldenRepository(
      "feature",
      { ".gitignore": PROJECT_IGNORE },
      async (repositoryRoot) => {
        const events = createEventBus();
        events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
          const request = payload as SubagentDelegationRequest;
          events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            requestId: request.requestId,
            ownerRunId: request.ownerRunId,
            nodeId: request.nodeId,
            status: "failed",
            error: "simulated Pi Agent crash",
          } satisfies SubagentDelegationResponse);
        });

        const registrations = registeredCommands(events);
        const notifications: string[] = [];
        const commandContext = context(repositoryRoot, skills, notifications);
        const reader = new FileRunReader(repositoryRoot);

        await registrations.get("wf-feature")!.handler("crash recovery", commandContext);
        await expect(reader.load("run-001" as RunId)).resolves.toMatchObject({
          run: {
            status: "failed",
            finalized: false,
            failure: { resumable: true },
          },
        });
        expect(notifications.join("\n")).toContain("simulated Pi Agent crash");

        await registrations
          .get("wf-cancel")!
          .handler("run-001 crash cleanup", context(repositoryRoot, skills, notifications));
        await expect(reader.load("run-001" as RunId)).resolves.toMatchObject({
          run: {
            status: "cancelled",
            finalized: true,
            outcome: { status: "cancelled", request_satisfied: false },
          },
        });
      },
    );
  });

  it("keeps the extension on the production path instead of injecting command use cases", () => {
    const source = readFileSync(resolve(PROJECT_ROOT, "src/extensions/workflow.ts"), "utf8");
    expect(source).toContain("createWorkflowRuntime(runtimeDependencies)");
    expect(source).not.toContain("startWorkflow");
    expect(source).not.toContain("statusWorkflow");
    expect(source).not.toContain("resumeWorkflow");
    expect(source).not.toContain("cancelWorkflow");
  });
});
