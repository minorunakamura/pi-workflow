import { execFile as nodeExecFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  VerifierExecutor,
  VerifierFinalizer,
} from "../../src/application/execution/verifier-finalizer.js";
import type {
  AgentExecutionRequestV1,
  JsonObject,
  StepResultV1,
} from "../../src/contracts/execution/agent-execution.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import { FileArtifactStore } from "../../src/adapters/persistence/write/file-artifact-store.js";
import { GitRepositoryAdapter } from "../../src/adapters/repository/git-repository-adapter.js";
import type { AgentRuntime } from "../../src/ports/agent-runtime.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const execFile = promisify(nodeExecFile);
const RUN_ID = "run-704" as RunId;

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
      agentId: "verifier",
      agentVersion: "1.0.0",
    },
    objective: {
      objective: "verify current implementation",
      type: "verification",
      completionCriteria: [],
    },
    retry: { attempt: 1, context: null },
    execution: { mode: "verify-only", timeoutMs: 1_000, cancellationPolicy: {} },
    authority: { maximumDLevel: "D0", escalationRules: [] },
    permissions: {
      filesystem: ["repository"],
      shell: [],
      git: ["status", "diff"],
      network: [],
      repositoryTargets: ["src"],
    },
    skills: { required: [], optional: [] },
    tools: { resolved: ["read"], policy: {} },
    model: { requested: "test", actual: "test", thinkingLevel: "low", allowedFallback: [] },
    context: { pack: {}, manifest: {}, artifactRefs: [] },
    outputs: { expectedArtifactTypes: [], outputContract: {} },
  };
}

function resultFor(input: AgentExecutionRequestV1): StepResultV1 {
  const checks: JsonObject[] = [
    {
      type: "regression",
      status: "passed",
      required: true,
      evidence: { command: "pnpm check", exit_code: 0 },
    },
  ];
  return {
    identity: input.identity,
    outcome: "completed",
    mode: "verify-only",
    summary: "regression verification completed",
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
    execution_checks: checks,
    observations: [],
    blocked: null,
    failure: null,
    runtime: {},
  };
}

describe("Verifier finalization E2E", () => {
  it("finalizes a partial Verification Run when a Verifier mutates the repository", async () => {
    await withTempRepository({ "src/target.txt": "before\n" }, async (repositoryRoot) => {
      await initializeGit(repositoryRoot);
      const input = request("exec-006");
      const repository = new GitRepositoryAdapter(repositoryRoot);
      const runtime: AgentRuntime = {
        run: async () => {
          await writeFile(join(repositoryRoot, "src/target.txt"), "forbidden mutation\n", "utf8");
          return resultFor(input);
        },
      };
      const execution = await new VerifierExecutor({
        agentRuntime: runtime,
        repository,
        finalizer: new VerifierFinalizer({
          artifactStore: new FileArtifactStore(repositoryRoot),
          repository,
          now: () => new Date("2026-08-30T03:02:10.123Z"),
        }),
      }).run({
        request: input,
        executionStateRevision: 1,
        basis: { requirement_revision: 1, plan_version: 1 },
      });

      expect(execution.finalization.verificationRun).toMatchObject({
        id: "VR-001",
        status: "partial",
        result: "incomplete",
        accepted: false,
        repository: { mutated: true, changedFiles: ["src/target.txt"] },
      });
      expect(execution.finalization.artifact).toEqual({
        runId: RUN_ID,
        path: "verification/VR-001.md",
        status: "partial",
      });
      const artifact = await new FileArtifactStore(repositoryRoot).read(
        execution.finalization.artifact,
      );
      expect(artifact.frontMatter.artifact).toMatchObject({
        type: "verification",
        status: "partial",
      });
      expect(artifact.body).toContain("src/target.txt");
      await expect(readFile(join(repositoryRoot, "src/target.txt"), "utf8")).resolves.toBe(
        "forbidden mutation\n",
      );
    });
  });
});
