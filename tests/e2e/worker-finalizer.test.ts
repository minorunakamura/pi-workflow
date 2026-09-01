import { execFile as nodeExecFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  WorkerExecutor,
  WorkerFinalizer,
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

function request(executionId: string): AgentExecutionRequestV1 {
  return {
    identity: {
      runId: RUN_ID,
      stepId: "step-002" as StepId,
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
    },
    skills: { required: [], optional: [] },
    tools: { resolved: [], policy: {} },
    model: { requested: "test", actual: "test", thinkingLevel: "low", allowedFallback: [] },
    context: { pack: {}, manifest: {}, artifactRefs: [] },
    outputs: { expectedArtifactTypes: [], outputContract: {} },
  };
}

function resultFor(input: AgentExecutionRequestV1): StepResultV1 {
  return {
    identity: input.identity,
    outcome: "completed",
    mode: "write",
    summary: "worker wrote outside the approved scope",
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
    runtime: {},
  };
}

describe("Worker finalization E2E", () => {
  it("blocks acceptance and writes a partial Change Set for an out-of-scope diff", async () => {
    await withTempRepository(
      { "src/allowed.txt": "before\n", "outside.txt": "before\n" },
      async (repositoryRoot) => {
        await initializeGit(repositoryRoot);
        const input = request("exec-005");
        const runtime: AgentRuntime = {
          run: async () => {
            await writeFile(join(repositoryRoot, "src/allowed.txt"), "worker\n", "utf8");
            await writeFile(join(repositoryRoot, "outside.txt"), "unapproved\n", "utf8");
            return resultFor(input);
          },
        };
        const repository = new GitRepositoryAdapter(repositoryRoot);
        const execution = await new WorkerExecutor({
          agentRuntime: runtime,
          repository,
          finalizer: new WorkerFinalizer({
            artifactStore: new FileArtifactStore(repositoryRoot),
            repository,
            now: () => new Date("2026-08-30T03:02:10.123Z"),
          }),
        }).run({ request: input, executionStateRevision: 1 });

        expect(execution.finalization.changeSet).toMatchObject({
          status: "partial",
          changed: true,
          accepted: false,
        });
        expect(execution.finalization.observation.outOfScopeFiles).toEqual(["outside.txt"]);
        expect(execution.finalization.changeSet.violations).toEqual([
          {
            code: "WRITE_SCOPE_VIOLATION",
            paths: ["outside.txt"],
            message: "Worker changed files outside the approved Write Scope",
          },
        ]);
        expect(execution.finalization.artifact).toMatchObject({
          path: "implementation/change-set-CS-001.md",
          status: "partial",
        });

        const artifact = await new FileArtifactStore(repositoryRoot).read(
          execution.finalization.artifact,
        );
        expect(artifact.frontMatter.artifact.status).toBe("partial");
        expect(artifact.body).toContain('"accepted": false');
        await expect(readFile(join(repositoryRoot, "outside.txt"), "utf8")).resolves.toBe(
          "unapproved\n",
        );
      },
    );
  });

  it("detects an external edit that occurs while the Worker is running", async () => {
    await withTempRepository(
      { "src/allowed.txt": "before\n", "outside.txt": "before\n" },
      async (repositoryRoot) => {
        await initializeGit(repositoryRoot);
        const input = request("exec-008");
        const runtime: AgentRuntime = {
          run: async () => {
            const externalEdit = new Promise<void>((resolve, reject) => {
              setImmediate(() => {
                writeFile(join(repositoryRoot, "outside.txt"), "external\n", "utf8")
                  .then(() => resolve())
                  .catch(reject);
              });
            });
            await writeFile(join(repositoryRoot, "src/allowed.txt"), "worker\n", "utf8");
            await externalEdit;
            return resultFor(input);
          },
        };
        const repository = new GitRepositoryAdapter(repositoryRoot);
        const execution = await new WorkerExecutor({
          agentRuntime: runtime,
          repository,
          finalizer: new WorkerFinalizer({
            artifactStore: new FileArtifactStore(repositoryRoot),
            repository,
            now: () => new Date("2026-08-30T03:02:10.123Z"),
          }),
        }).run({ request: input, executionStateRevision: 1 });

        expect(execution.diff.changedFiles).toEqual(["outside.txt", "src/allowed.txt"]);
        expect(execution.finalization.observation.outOfScopeFiles).toEqual(["outside.txt"]);
        expect(execution.finalization.changeSet).toMatchObject({
          status: "partial",
          accepted: false,
        });
      },
    );
  });
});
