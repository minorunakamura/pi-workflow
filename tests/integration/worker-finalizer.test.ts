import { execFile as nodeExecFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  WorkerFinalizer,
  WorkerExecutor,
} from "../../src/application/execution/worker-finalizer.js";
import type {
  AgentExecutionRequestV1,
  StepResultV1,
} from "../../src/contracts/execution/agent-execution.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import { FileArtifactStore } from "../../src/adapters/persistence/write/file-artifact-store.js";
import { GitRepositoryAdapter } from "../../src/adapters/repository/git-repository-adapter.js";
import type { AgentRuntime } from "../../src/ports/agent-runtime.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const execFile = promisify(nodeExecFile);
const RUN_ID = "run-703" as RunId;

async function git(root: string, args: readonly string[]): Promise<void> {
  await execFile("git", [...args], { cwd: root, encoding: "utf8" });
}

async function initializeGit(root: string): Promise<void> {
  await git(root, ["init", "--quiet"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Pi Workflow Test"]);
  await git(root, ["config", "commit.gpgSign", "false"]);
  await git(root, ["add", "--", "."]);
  await git(root, ["commit", "--quiet", "-m", "initial"]);
  await git(root, ["branch", "-M", "main"]);
}

function request(
  executionId: string,
  permissions: Partial<AgentExecutionRequestV1["permissions"]> = {},
): AgentExecutionRequestV1 {
  return {
    identity: {
      runId: RUN_ID,
      stepId: "step-001" as StepId,
      executionId: executionId as ExecutionId,
      agentId: "worker",
      agentVersion: "1.0.0",
    },
    objective: { objective: "implement", type: "implementation", completionCriteria: [] },
    retry: { attempt: 1, context: null },
    execution: { mode: "write", timeoutMs: 1_000, cancellationPolicy: {} },
    authority: { maximumDLevel: "D1", escalationRules: [] },
    permissions: {
      filesystem: [],
      shell: [],
      git: [],
      network: [],
      repositoryTargets: ["src"],
      ...permissions,
    },
    skills: { required: [], optional: [] },
    tools: { resolved: [], policy: {} },
    model: { requested: "test", actual: "test", thinkingLevel: "low", allowedFallback: [] },
    context: { pack: {}, manifest: {}, artifactRefs: [] },
    outputs: { expectedArtifactTypes: [], outputContract: {} },
  };
}

function resultFor(input: AgentExecutionRequestV1, outcome: StepResultV1["outcome"]): StepResultV1 {
  return {
    identity: input.identity,
    outcome,
    mode: "write",
    summary: `worker ${outcome}`,
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
    blocked: outcome === "blocked" ? { reason: "blocked" } : null,
    failure: outcome === "failed" ? { reason: "failed" } : null,
    runtime: {},
  };
}

function finalizer(repositoryRoot: string, now = "2026-08-30T03:02:10.123Z"): WorkerFinalizer {
  return new WorkerFinalizer({
    artifactStore: new FileArtifactStore(repositoryRoot),
    repository: new GitRepositoryAdapter(repositoryRoot),
    now: () => new Date(now),
  });
}

describe("WorkerExecutor and WorkerFinalizer integration", () => {
  it("captures the actual diff, preserves pre-existing changes, and finalizes a complete CS", async () => {
    await withTempRepository(
      { "src/target.txt": "before\n", "pre-existing.txt": "base\n" },
      async (repositoryRoot) => {
        await initializeGit(repositoryRoot);
        await writeFile(join(repositoryRoot, "pre-existing.txt"), "user change\n", "utf8");

        const input = request("exec-001");
        const runtime: AgentRuntime = {
          run: async () => {
            await writeFile(join(repositoryRoot, "src/target.txt"), "worker change\n", "utf8");
            return resultFor(input, "completed");
          },
        };
        const execution = await new WorkerExecutor({
          agentRuntime: runtime,
          repository: new GitRepositoryAdapter(repositoryRoot),
          finalizer: finalizer(repositoryRoot),
        }).run({ request: input, executionStateRevision: 4 });

        expect(execution.diff.changedFiles).toEqual(["src/target.txt"]);
        expect(execution.finalization.changeSet).toMatchObject({
          id: "CS-001",
          status: "complete",
          changed: true,
          accepted: true,
        });
        expect(execution.finalization.observation.workflowAttributedFiles).toEqual([
          "src/target.txt",
        ]);
        expect(execution.finalization.observation.preExistingFiles).toEqual(["pre-existing.txt"]);
        expect(execution.finalization.observation.preservedPreExistingFiles).toEqual([
          "pre-existing.txt",
        ]);
        expect(execution.finalization.observation.uncertainFiles).toEqual([]);
        expect(execution.finalization.artifact).toEqual({
          runId: RUN_ID,
          path: "implementation/change-set-CS-001.md",
          status: "complete",
        });

        const artifact = await new FileArtifactStore(repositoryRoot).read(
          execution.finalization.artifact,
        );
        expect(artifact.frontMatter).toMatchObject({
          change_set_id: "CS-001",
          execution_state_revision: 4,
          artifact: { type: "implementation", status: "complete" },
        });
        expect(artifact.body).toContain("src/target.txt");
        await expect(readFile(join(repositoryRoot, "pre-existing.txt"), "utf8")).resolves.toBe(
          "user change\n",
        );
      },
    );
  });

  it("marks same-file overlap with a pre-existing change as uncertain", async () => {
    await withTempRepository(
      { "src/target.txt": "before\n", "pre-existing.txt": "base\n" },
      async (repositoryRoot) => {
        await initializeGit(repositoryRoot);
        await writeFile(join(repositoryRoot, "pre-existing.txt"), "user change\n", "utf8");

        const input = request("exec-006");
        const repository = new GitRepositoryAdapter(repositoryRoot);
        const execution = await new WorkerExecutor({
          agentRuntime: {
            run: async () => {
              await writeFile(
                join(repositoryRoot, "pre-existing.txt"),
                "worker overwrite\n",
                "utf8",
              );
              return resultFor(input, "completed");
            },
          },
          repository,
          finalizer: finalizer(repositoryRoot),
        }).run({ request: input, executionStateRevision: 1 });

        expect(execution.finalization.changeSet.status).toBe("partial");
        expect(execution.finalization.changeSet.accepted).toBe(false);
        expect(execution.finalization.observation.uncertainFiles).toEqual(["pre-existing.txt"]);
        expect(execution.finalization.changeSet.violations).toEqual([
          {
            code: "WRITE_SCOPE_VIOLATION",
            paths: ["pre-existing.txt"],
            message: "Worker changed files outside the approved Write Scope",
          },
          {
            code: "PREEXISTING_CHANGE_LOST",
            paths: ["pre-existing.txt"],
            message: "Worker changed or removed pre-existing repository changes",
          },
        ]);
      },
    );
  });

  it("finalizes blocked and no-op Worker outcomes distinctly", async () => {
    await withTempRepository({ "src/target.txt": "before\n" }, async (repositoryRoot) => {
      await initializeGit(repositoryRoot);
      const artifactStore = new FileArtifactStore(repositoryRoot);
      const repository = new GitRepositoryAdapter(repositoryRoot);
      const workerFinalizer = new WorkerFinalizer({
        artifactStore,
        repository,
        now: () => new Date("2026-08-30T03:02:10.123Z"),
      });
      const input = request("exec-002");
      const before = await repository.captureSnapshot();
      const after = await repository.captureSnapshot();
      const blocked = await workerFinalizer.finalize({
        request: input,
        result: resultFor(input, "blocked"),
        before,
        after,
        executionStateRevision: 1,
      });

      expect(blocked.changeSet).toMatchObject({
        status: "partial",
        changed: false,
        accepted: false,
      });
      expect(blocked.artifact.status).toBe("partial");

      const noOpInput = request("exec-003");
      const noOp = await workerFinalizer.finalize({
        request: noOpInput,
        result: resultFor(noOpInput, "completed"),
        before: after,
        after,
        executionStateRevision: 2,
      });

      expect(noOp.changeSet).toMatchObject({ id: "CS-002", status: "complete", changed: false });
      expect(noOp.observation.changedFiles).toEqual([]);
      expect(noOp.artifact.status).toBe("complete");
    });
  });

  it("records a Git index mutation as denied even inside the Write Scope", async () => {
    await withTempRepository({ "src/target.txt": "before\n" }, async (repositoryRoot) => {
      await initializeGit(repositoryRoot);
      const input = request("exec-007");
      const repository = new GitRepositoryAdapter(repositoryRoot);
      const execution = await new WorkerExecutor({
        agentRuntime: {
          run: async () => {
            await writeFile(join(repositoryRoot, "src/target.txt"), "worker\n", "utf8");
            await git(repositoryRoot, ["add", "--", "src/target.txt"]);
            return resultFor(input, "completed");
          },
        },
        repository,
        finalizer: finalizer(repositoryRoot),
      }).run({ request: input, executionStateRevision: 1 });

      expect(execution.finalization.changeSet).toMatchObject({
        status: "partial",
        accepted: false,
      });
      expect(execution.finalization.changeSet.violations).toEqual([
        {
          code: "GIT_WRITE_DENIED",
          paths: [],
          message: "Worker changed Git control-plane state; Git write operations are denied",
        },
      ]);
    });
  });

  it("denies explicit Git writes before the Worker runs", async () => {
    const input = request("exec-004", { git: ["commit"] });
    let called = false;
    const runtime: AgentRuntime = {
      run: async () => {
        called = true;
        return resultFor(input, "completed");
      },
    };

    await expect(
      new WorkerExecutor({
        agentRuntime: runtime,
        repository: {
          captureSnapshot: async () => {
            throw new Error("snapshot must not be captured");
          },
          diff: async () => {
            throw new Error("diff must not be captured");
          },
          getRoot: async () => "",
          getHead: async () => "",
          getBranch: async () => null,
        },
        finalizer: finalizer("/tmp"),
      }).run({ request: input, executionStateRevision: 1 }),
    ).rejects.toMatchObject({ code: "GIT_WRITE_DENIED" });
    expect(called).toBe(false);
  });
});
