import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createEventBus,
  createSyntheticSourceInfo,
  loadSkillsFromDir,
  type ExtensionAPI,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
} from "pi-subagents/delegation";
import { describe, expect, it } from "vitest";
import workflowExtension from "../../src/extensions/workflow.js";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import { type ExecutionId, type RunId, type StepId } from "../../src/domain/primitives/ids.js";
import { withGoldenRepository } from "../fixtures/golden-repositories.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];
type CommandContext = Parameters<RegisteredCommand["handler"]>[1];

type ToolName = "read" | "edit";

function tools(): ToolInfo[] {
  return (["read", "edit"] as const satisfies readonly ToolName[]).map(
    (name) => ({ name }) as unknown as ToolInfo,
  );
}

function result(request: SubagentDelegationRequest): Record<string, unknown> {
  return {
    identity: {
      runId: request.ownerRunId as RunId,
      stepId: request.nodeId as StepId,
      executionId: request.requestId as ExecutionId,
    },
    outcome: "completed",
    summary: `completed:${request.agent}`,
    artifacts: [],
    uncertainty_candidates: [],
    decision_requests: [],
    requirement_candidates: { acceptance_criteria: [], constraints: [], assumptions: [] },
    finding_candidates: [],
    finding_rechecks: [],
    plan_deviations: [],
    skill_requests: [],
    execution_checks: [],
    observations: [],
    blocked: null,
    failure: null,
    runtime: {},
  };
}

function commandContext(
  repositoryRoot: string,
  skills: ReturnType<typeof loadSkillsFromDir>["skills"],
  notifications: string[],
): CommandContext {
  return {
    cwd: repositoryRoot,
    hasUI: false,
    ui: {
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

describe("workflow Extension production composition", () => {
  it("uses the command cwd and Pi execution events for the default runtime", async () => {
    const packageSkills = loadSkillsFromDir({
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

    await withGoldenRepository("feature", {}, async (repositoryRoot) => {
      const events = createEventBus();
      const requests: SubagentDelegationRequest[] = [];
      events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
        const request = payload as SubagentDelegationRequest;
        requests.push(request);
        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "completed",
          result: { kind: "structured", value: result(request) },
        } satisfies SubagentDelegationResponse);
      });

      const registrations = new Map<string, RegisteredCommand>();
      const pi: Parameters<typeof workflowExtension>[0] = {
        registerCommand(name, options) {
          registrations.set(name, options);
        },
        events,
        getAllTools: tools,
      };
      workflowExtension(pi);

      const notifications: string[] = [];
      const commandCwd = resolve(repositoryRoot, "src");
      await registrations
        .get("wf-feature")!
        .handler(
          "production composition root",
          commandContext(commandCwd, packageSkills, notifications),
        );

      const state = await new FileRunReader(repositoryRoot).load("run-001" as RunId);
      expect(notifications).toEqual([
        expect.stringContaining("Run run-001: status=completed; finalized=true"),
      ]);
      expect(notifications.join("\n")).not.toContain("NOT_IMPLEMENTED");
      expect(state.run).toMatchObject({
        status: "completed",
        finalized: true,
        request: { type: "feature" },
      });
      expect(requests.map(({ agent }) => agent)).toEqual([
        "scout",
        "planner",
        "worker",
        "verifier",
        "reviewer",
      ]);
      expect(new Set(requests.map(({ cwd }) => cwd))).toHaveLength(1);
      expect(await realpath(requests[0]!.cwd)).toBe(await realpath(repositoryRoot));
      await expect(
        readFile(resolve(repositoryRoot, ".pi/runs/run-001/effective-config.yaml"), "utf8"),
      ).resolves.toContain("feature");
    });
  });
});
