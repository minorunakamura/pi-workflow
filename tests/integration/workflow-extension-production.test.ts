import { writeFileSync } from "node:fs";
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
import { FileArtifactStore } from "../../src/adapters/persistence/write/file-artifact-store.js";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import { JsonlEventReader } from "../../src/adapters/persistence/read/jsonl-event-reader.js";
import { GitRepositoryAdapter } from "../../src/adapters/repository/git-repository-adapter.js";
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

function result(
  request: SubagentDelegationRequest,
  options: Readonly<{
    verificationFailed?: boolean;
    verificationChecks?: boolean;
    finding?: boolean;
    recheck?: boolean;
    planDeviation?: boolean;
    requestAmendment?: boolean;
    writeScope?: readonly string[];
  }> = {},
): Record<string, unknown> {
  const verificationFailed = request.agent === "verifier" && options.verificationFailed === true;
  return {
    identity: {
      runId: request.ownerRunId as RunId,
      stepId: request.nodeId as StepId,
      executionId: request.requestId as ExecutionId,
    },
    outcome: verificationFailed ? "failed" : "completed",
    summary: `completed:${request.agent}`,
    artifacts: [],
    uncertainty_candidates: [],
    decision_requests: [],
    requirement_candidates: {
      acceptance_criteria: [],
      constraints: [],
      assumptions: options.requestAmendment
        ? [
            {
              operation: "add",
              effect: "changing",
              kind: "assumptions",
              value: "amended production assumption",
            },
          ]
        : [],
    },
    finding_candidates: options.finding
      ? [{ severity: "high", confidence: "high", summary: "blocking production finding" }]
      : [],
    finding_rechecks: options.recheck ? [{ findingId: "F-001", action: "fix" }] : [],
    plan_deviations: options.planDeviation ? [{ summary: "production plan deviation" }] : [],
    skill_requests: [],
    execution_checks:
      request.agent === "verifier" && options.verificationChecks !== false
        ? [
            {
              type: "test",
              status: verificationFailed ? "failed" : "passed",
              required: true,
              evidence: { exit_code: verificationFailed ? 1 : 0 },
            },
          ]
        : [],
    observations:
      options.writeScope === undefined ? [] : [{ write_scope: [...options.writeScope] }],
    blocked: null,
    failure: verificationFailed ? { reason: "production verification failed" } : null,
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
  it("uses the command cwd and tolerates unrelated bundled Skills", async () => {
    const packageSkills = [
      ...loadSkillsFromDir({
        dir: resolve(PROJECT_ROOT, "skills"),
        source: "pi-workflow",
      }).skills.map((skill) => ({
        ...skill,
        sourceInfo: createSyntheticSourceInfo(skill.filePath, {
          source: "pi-workflow",
          scope: "project",
          origin: "package",
        }),
      })),
      ...loadSkillsFromDir({
        dir: resolve(PROJECT_ROOT, "node_modules/pi-subagents/skills"),
        source: "pi-subagents",
      }).skills.map((skill) => ({
        ...skill,
        sourceInfo: createSyntheticSourceInfo(skill.filePath, {
          source: "pi-subagents",
          origin: "package",
        }),
      })),
    ];

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
      expect(
        requests.every(({ skill }) => !(Array.isArray(skill) && skill.includes("pi-subagents"))),
      ).toBe(true);
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

      const steps = state.snapshot.steps.steps;
      expect(steps.find(({ agent }) => agent === "worker")?.result).toMatchObject({
        finalization: {
          kind: "change-set",
          change_set: { status: "complete", accepted: true },
        },
      });
      expect(steps.find(({ agent }) => agent === "verifier")?.result).toMatchObject({
        finalization: {
          kind: "verification-run",
          verification_run: { status: "complete", result: "passed", accepted: true },
        },
      });
      expect(steps.find(({ agent }) => agent === "reviewer")?.result).toMatchObject({
        finalization: {
          kind: "review-run",
          review_run: { status: "complete", result: "clean" },
        },
      });
      const artifacts = new FileArtifactStore(repositoryRoot);
      await expect(
        artifacts.read({
          runId: "run-001" as RunId,
          path: "implementation/change-set-CS-001.md",
          status: "complete",
        }),
      ).resolves.toMatchObject({ frontMatter: { artifact: { type: "implementation" } } });
      await expect(
        artifacts.read({
          runId: "run-001" as RunId,
          path: "verification/VR-001.md",
          status: "complete",
        }),
      ).resolves.toMatchObject({ frontMatter: { artifact: { type: "verification" } } });
      await expect(
        artifacts.read({
          runId: "run-001" as RunId,
          path: "reviews/RR-001.md",
          status: "complete",
        }),
      ).resolves.toMatchObject({ frontMatter: { artifact: { type: "review" } } });
      await expect(
        artifacts.read({
          runId: "run-001" as RunId,
          path: "outcome.md",
          status: "complete",
        }),
      ).resolves.toMatchObject({ frontMatter: { artifact: { type: "outcome" } } });
      const eventTypes = (
        await new JsonlEventReader(repositoryRoot).readAfter("run-001" as RunId, 0)
      ).map(({ type }) => type);
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          "change-set.created",
          "verification.completed",
          "review.completed",
          "run.completed",
        ]),
      );
    });
  });

  it("propagates the approved Plan Write Scope and preserves a dirty baseline", async () => {
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

    await withGoldenRepository("dirty-tree", { ".gitignore": ".pi/\n" }, async (repositoryRoot) => {
      const baseline = await new GitRepositoryAdapter(repositoryRoot).captureSnapshot();
      const events = createEventBus();
      const requests: SubagentDelegationRequest[] = [];
      events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
        const request = payload as SubagentDelegationRequest;
        requests.push(request);
        const writeScope = request.agent === "planner" ? ["src"] : undefined;
        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "completed",
          result: {
            kind: "structured",
            value: result(request, writeScope === undefined ? {} : { writeScope }),
          },
        } satisfies SubagentDelegationResponse);
      });

      const registrations = new Map<string, RegisteredCommand>();
      workflowExtension({
        registerCommand(name, options) {
          registrations.set(name, options);
        },
        events,
        getAllTools: tools,
      });
      const notifications: string[] = [];
      await registrations
        .get("wf-feature")!
        .handler(
          "production repository safety",
          commandContext(repositoryRoot, packageSkills, notifications),
        );

      const state = await new FileRunReader(repositoryRoot).load("run-001" as RunId);
      const workerRequest = requests.find(({ agent }) => agent === "worker");
      expect(workerRequest?.task).toContain('"repositoryTargets":["src"]');
      expect(workerRequest?.task).toContain('"resolved":["read","edit"]');
      expect(workerRequest?.task).toContain('"allow":["read","edit"]');
      expect(workerRequest?.task).not.toContain('"repositoryTargets":["."]');
      expect(state.run.repository).toMatchObject({
        classification: "unrelated",
        baseline_root: baseline.root,
        baseline_head: baseline.head,
        baseline_branch: baseline.branch,
        baseline_dirty: true,
        pre_existing: {
          changed: ["notes/untracked.txt", "src/target.txt"],
          untracked: ["notes/untracked.txt"],
        },
        baseline: baseline.head,
        baseline_snapshot: { status: baseline.status },
      });
      await expect(readFile(resolve(repositoryRoot, "src/target.txt"), "utf8")).resolves.toBe(
        "modified in the working tree\n",
      );
      await expect(readFile(resolve(repositoryRoot, "notes/untracked.txt"), "utf8")).resolves.toBe(
        "untracked working-tree file\n",
      );
      expect(state.run).toMatchObject({ status: "completed", finalized: true });
    });
  });

  it("rejects an out-of-scope Worker mutation before production completion", async () => {
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

    await withGoldenRepository("feature", { ".gitignore": ".pi/\n" }, async (repositoryRoot) => {
      const events = createEventBus();
      const requests: SubagentDelegationRequest[] = [];
      let mutated = false;
      events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
        const request = payload as SubagentDelegationRequest;
        requests.push(request);
        if (request.agent === "worker" && !mutated) {
          mutated = true;
          writeFileSync(resolve(repositoryRoot, "outside.txt"), "must be rejected\n", "utf8");
        }
        const writeScope = request.agent === "planner" ? ["src"] : undefined;
        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "completed",
          result: {
            kind: "structured",
            value: result(request, writeScope === undefined ? {} : { writeScope }),
          },
        } satisfies SubagentDelegationResponse);
      });

      const registrations = new Map<string, RegisteredCommand>();
      workflowExtension({
        registerCommand(name, options) {
          registrations.set(name, options);
        },
        events,
        getAllTools: tools,
      });
      const notifications: string[] = [];
      await registrations
        .get("wf-feature")!
        .handler(
          "production scope violation",
          commandContext(repositoryRoot, packageSkills, notifications),
        );

      const state = await new FileRunReader(repositoryRoot).load("run-001" as RunId);
      const worker = state.snapshot.steps.steps.find(({ agent }) => agent === "worker");
      expect(worker?.result).toMatchObject({
        finalization: {
          kind: "change-set",
          change_set: {
            status: "partial",
            accepted: false,
            violations: [
              expect.objectContaining({ code: "WRITE_SCOPE_VIOLATION", paths: ["outside.txt"] }),
            ],
          },
        },
      });
      expect(state.run).toMatchObject({ finalized: false });
      await expect(readFile(resolve(repositoryRoot, "outside.txt"), "utf8")).resolves.toBe(
        "must be rejected\n",
      );
    });
  });

  it("inserts a production re-plan for a Worker plan deviation before completion", async () => {
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

    await withGoldenRepository("feature", { ".gitignore": ".pi/\n" }, async (repositoryRoot) => {
      const events = createEventBus();
      const requests: SubagentDelegationRequest[] = [];
      let deviationReported = false;
      events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
        const request = payload as SubagentDelegationRequest;
        requests.push(request);
        const planDeviation = request.agent === "worker" && !deviationReported;
        deviationReported ||= planDeviation;
        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "completed",
          result: { kind: "structured", value: result(request, { planDeviation }) },
        } satisfies SubagentDelegationResponse);
      });

      const registrations = new Map<string, RegisteredCommand>();
      workflowExtension({
        registerCommand(name, options) {
          registrations.set(name, options);
        },
        events,
        getAllTools: tools,
      });
      const notifications: string[] = [];
      await registrations
        .get("wf-feature")!
        .handler(
          "production plan deviation",
          commandContext(repositoryRoot, packageSkills, notifications),
        );

      const state = await new FileRunReader(repositoryRoot).load("run-001" as RunId);
      expect(state.run).toMatchObject({ status: "completed", finalized: true });
      expect(state.run.current_plan).toMatchObject({
        version: 2,
        applicability: { status: "current" },
      });
      expect(state.snapshot.steps.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            origin: "dynamic",
            trigger: "plan deviation",
            objective: "re-plan after plan deviation",
            status: "completed",
          }),
        ]),
      );
    });
  });

  it("re-plans an amended Requirement through the production Orchestrator", async () => {
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

    await withGoldenRepository("feature", { ".gitignore": ".pi/\n" }, async (repositoryRoot) => {
      const events = createEventBus();
      const requests: SubagentDelegationRequest[] = [];
      let amendmentReported = false;
      events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
        const request = payload as SubagentDelegationRequest;
        requests.push(request);
        const requestAmendment = request.agent === "planner" && !amendmentReported;
        amendmentReported ||= requestAmendment;
        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "completed",
          result: { kind: "structured", value: result(request, { requestAmendment }) },
        } satisfies SubagentDelegationResponse);
      });

      const registrations = new Map<string, RegisteredCommand>();
      workflowExtension({
        registerCommand(name, options) {
          registrations.set(name, options);
        },
        events,
        getAllTools: tools,
      });
      const notifications: string[] = [];
      await registrations
        .get("wf-feature")!
        .handler(
          "production request amendment",
          commandContext(repositoryRoot, packageSkills, notifications),
        );

      const state = await new FileRunReader(repositoryRoot).load("run-001" as RunId);
      expect(state.run).toMatchObject({ status: "running", finalized: false });
      expect(notifications.join("\n")).toContain("max_dynamic_steps exceeded");
      expect(state.snapshot.requirement.revision).toBe(2);
      expect(state.snapshot.steps.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            origin: "dynamic",
            trigger: "request amendment",
            objective: "reanalyze amended requirement",
            status: "completed",
          }),
          expect.objectContaining({
            origin: "dynamic",
            trigger: "request amendment",
            objective: "re-plan amended requirement",
            status: "completed",
          }),
        ]),
      );
    });
  });

  it("routes verification failure through production fix, reverify, and rereview finalizers", async () => {
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

    await withGoldenRepository("feature", { ".gitignore": ".pi/\n" }, async (repositoryRoot) => {
      const events = createEventBus();
      const requests: SubagentDelegationRequest[] = [];
      let verifierCalls = 0;
      events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
        const request = payload as SubagentDelegationRequest;
        requests.push(request);
        const verificationFailed = request.agent === "verifier" && verifierCalls++ === 0;
        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "completed",
          result: {
            kind: "structured",
            value: result(request, { verificationFailed }),
          },
        } satisfies SubagentDelegationResponse);
      });

      const registrations = new Map<string, RegisteredCommand>();
      workflowExtension({
        registerCommand(name, options) {
          registrations.set(name, options);
        },
        events,
        getAllTools: tools,
      });
      const notifications: string[] = [];
      await registrations
        .get("wf-feature")!
        .handler(
          "production verification failure",
          commandContext(repositoryRoot, packageSkills, notifications),
        );

      const state = await new FileRunReader(repositoryRoot).load("run-001" as RunId);
      expect(state.run).toMatchObject({ status: "completed", finalized: true });
      expect(requests.map(({ agent }) => agent)).toEqual([
        "scout",
        "planner",
        "worker",
        "verifier",
        "worker",
        "verifier",
        "reviewer",
      ]);
      expect(state.snapshot.steps.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            origin: "dynamic",
            objective: "fix verification failure",
            status: "completed",
          }),
          expect.objectContaining({
            origin: "dynamic",
            objective: "reverify the fix",
            status: "completed",
          }),
          expect.objectContaining({
            origin: "dynamic",
            objective: "rereview the fix",
            status: "completed",
          }),
        ]),
      );
      expect(
        state.snapshot.steps.steps.filter((step) => step.type === "verification").at(-1)?.result,
      ).toMatchObject({
        finalization: { verification_run: { result: "passed", accepted: true } },
      });
      expect(state.run.outcome).toMatchObject({
        status: "completed",
        request_satisfied: true,
        artifact_path: "outcome.md",
      });
      expect(notifications.join("\n")).toContain("status=completed; finalized=true");
    });
  });

  it("persists runtime failure and resumes the same production Orchestrator path", async () => {
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

    await withGoldenRepository("feature", { ".gitignore": ".pi/\n" }, async (repositoryRoot) => {
      const events = createEventBus();
      const requests: SubagentDelegationRequest[] = [];
      let crashed = false;
      events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
        const request = payload as SubagentDelegationRequest;
        requests.push(request);
        if (!crashed && request.agent === "scout") {
          crashed = true;
          events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
            requestId: request.requestId,
            ownerRunId: request.ownerRunId,
            nodeId: request.nodeId,
            status: "failed",
            error: "production runtime failure",
          } satisfies SubagentDelegationResponse);
          return;
        }
        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "completed",
          result: { kind: "structured", value: result(request) },
        } satisfies SubagentDelegationResponse);
      });

      const registrations = new Map<string, RegisteredCommand>();
      workflowExtension({
        registerCommand(name, options) {
          registrations.set(name, options);
        },
        events,
        getAllTools: tools,
      });
      const notifications: string[] = [];
      const commandContextValue = commandContext(repositoryRoot, packageSkills, notifications);
      await registrations
        .get("wf-feature")!
        .handler("production runtime recovery", commandContextValue);
      await expect(
        new FileRunReader(repositoryRoot).load("run-001" as RunId),
      ).resolves.toMatchObject({
        run: { status: "failed", finalized: false, failure: { resumable: true } },
      });
      expect(notifications.join("\n")).toContain("production runtime failure");

      await registrations.get("wf-resume")!.handler("run-001", commandContextValue);
      await expect(
        new FileRunReader(repositoryRoot).load("run-001" as RunId),
      ).resolves.toMatchObject({
        run: { status: "completed", finalized: true, outcome: { request_satisfied: true } },
      });
      expect(requests.map(({ agent }) => agent)).toEqual([
        "scout",
        "scout",
        "planner",
        "worker",
        "verifier",
        "reviewer",
      ]);
    });
  });

  it("routes a production Review Finding through fix, reverify, and rereview normalization", async () => {
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

    await withGoldenRepository("feature", { ".gitignore": ".pi/\n" }, async (repositoryRoot) => {
      const events = createEventBus();
      const requests: SubagentDelegationRequest[] = [];
      let reviewerCalls = 0;
      events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
        const request = payload as SubagentDelegationRequest;
        requests.push(request);
        const finding = request.agent === "reviewer" && reviewerCalls++ === 0;
        const recheck = request.agent === "reviewer" && !finding;
        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "completed",
          result: { kind: "structured", value: result(request, { finding, recheck }) },
        } satisfies SubagentDelegationResponse);
      });

      const registrations = new Map<string, RegisteredCommand>();
      workflowExtension({
        registerCommand(name, options) {
          registrations.set(name, options);
        },
        events,
        getAllTools: tools,
      });
      const notifications: string[] = [];
      await registrations
        .get("wf-feature")!
        .handler(
          "production review finding",
          commandContext(repositoryRoot, packageSkills, notifications),
        );

      const state = await new FileRunReader(repositoryRoot).load("run-001" as RunId);
      expect(state.run).toMatchObject({ status: "completed", finalized: true });
      expect(state.snapshot.findings.findings).toMatchObject([
        { id: "F-001", state: "resolved", disposition: "fixed" },
      ]);
      expect(requests.map(({ agent }) => agent)).toEqual([
        "scout",
        "planner",
        "worker",
        "verifier",
        "reviewer",
        "worker",
        "verifier",
        "reviewer",
      ]);
      expect(state.snapshot.steps.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ objective: "fix blocking finding", origin: "dynamic" }),
          expect.objectContaining({ objective: "reverify the fix", origin: "dynamic" }),
          expect.objectContaining({ objective: "rereview the fix", origin: "dynamic" }),
        ]),
      );
      expect(notifications.join("\n")).toContain("status=completed; finalized=true");
    });
  });

  it("routes a production repository mutation into drift reconciliation instead of terminalizing", async () => {
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

    await withGoldenRepository("feature", { ".gitignore": ".pi/\n" }, async (repositoryRoot) => {
      const events = createEventBus();
      const requests: SubagentDelegationRequest[] = [];
      let mutated = false;
      events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
        const request = payload as SubagentDelegationRequest;
        requests.push(request);
        if (request.agent === "reviewer" && !mutated) {
          mutated = true;
          writeFileSync(
            resolve(repositoryRoot, "src", "reviewer-mutation.txt"),
            "mutation\n",
            "utf8",
          );
        }
        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "completed",
          result: { kind: "structured", value: result(request) },
        } satisfies SubagentDelegationResponse);
      });

      const registrations = new Map<string, RegisteredCommand>();
      workflowExtension({
        registerCommand(name, options) {
          registrations.set(name, options);
        },
        events,
        getAllTools: tools,
      });
      const notifications: string[] = [];
      await registrations
        .get("wf-feature")!
        .handler(
          "production repository drift",
          commandContext(repositoryRoot, packageSkills, notifications),
        );

      const state = await new FileRunReader(repositoryRoot).load("run-001" as RunId);
      expect(state.run).toMatchObject({
        status: "running",
        finalized: false,
        repository: { classification: "relevant", resolution: "reconciled" },
      });
      expect(state.snapshot.steps.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            objective: "reconcile repository drift",
            origin: "dynamic",
            status: "completed",
          }),
        ]),
      );
      expect(notifications.join("\n")).not.toContain("status=completed; finalized=true");
    });
  });

  it("does not terminalize a production Run from completed Agent results without verification evidence", async () => {
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

    await withGoldenRepository("feature", { ".gitignore": ".pi/\n" }, async (repositoryRoot) => {
      const events = createEventBus();
      events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
        const request = payload as SubagentDelegationRequest;
        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "completed",
          result: { kind: "structured", value: result(request, { verificationChecks: false }) },
        } satisfies SubagentDelegationResponse);
      });

      const registrations = new Map<string, RegisteredCommand>();
      workflowExtension({
        registerCommand(name, options) {
          registrations.set(name, options);
        },
        events,
        getAllTools: tools,
      });
      const notifications: string[] = [];
      await registrations
        .get("wf-feature")!
        .handler(
          "missing verification evidence",
          commandContext(repositoryRoot, packageSkills, notifications),
        );

      const state = await new FileRunReader(repositoryRoot).load("run-001" as RunId);
      expect(state.run).toMatchObject({ status: "running", finalized: false, outcome: null });
      expect(state.snapshot.steps.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agent: "verifier",
            status: "completed",
            result: expect.objectContaining({
              finalization: expect.objectContaining({
                verification_run: expect.objectContaining({
                  result: "incomplete",
                  accepted: false,
                }),
              }),
            }),
          }),
        ]),
      );
      expect(notifications.join("\n")).not.toContain("status=completed; finalized=true");
    });
  });
});
