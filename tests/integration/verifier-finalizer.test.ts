import { execFile as nodeExecFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
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

function request(
  executionId: string,
  overrides: Partial<AgentExecutionRequestV1> = {},
): AgentExecutionRequestV1 {
  return {
    identity: {
      runId: RUN_ID,
      stepId: "step-001" as StepId,
      executionId: executionId as ExecutionId,
      agentId: "verifier",
      agentVersion: "1.0.0",
    },
    objective: { objective: "verify", type: "verification", completionCriteria: [] },
    retry: { attempt: 1, context: null },
    execution: { mode: "verify-only", timeoutMs: 1_000, cancellationPolicy: {} },
    authority: { maximumDLevel: "D0", escalationRules: [] },
    permissions: {
      filesystem: ["repository"],
      shell: [],
      git: [],
      network: [],
      repositoryTargets: ["src"],
    },
    skills: { required: [], optional: [] },
    tools: { resolved: ["read"], policy: {} },
    model: { requested: "test", actual: "test", thinkingLevel: "low", allowedFallback: [] },
    context: { pack: {}, manifest: {}, artifactRefs: [] },
    outputs: { expectedArtifactTypes: [], outputContract: {} },
    ...overrides,
  };
}

function resultFor(input: AgentExecutionRequestV1, checks: readonly JsonObject[]): StepResultV1 {
  return {
    identity: input.identity,
    outcome: "completed",
    mode: "verify-only",
    summary: "verification completed",
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

function check(
  status: "passed" | "failed" | "skipped" | "unavailable",
  required: boolean,
  type = "test",
): JsonObject {
  return {
    status,
    required,
    type,
    evidence: {
      source: "verification-tool",
      command: `check-${status}`,
      status,
      exit_code: status === "passed" ? 0 : status === "failed" ? 1 : null,
      ...(status === "unavailable" ? { reason: "not-run" } : {}),
    },
  };
}

function finalizer(repositoryRoot: string): VerifierFinalizer {
  return new VerifierFinalizer({
    artifactStore: new FileArtifactStore(repositoryRoot),
    repository: new GitRepositoryAdapter(repositoryRoot),
    now: () => new Date("2026-08-30T03:02:10.123Z"),
  });
}

describe("VerifierFinalizer integration", () => {
  it("finalizes a passed Verification Run with basis, strength, and evidence", async () => {
    await withTempRepository({ "src/target.txt": "unchanged\n" }, async (repositoryRoot) => {
      await initializeGit(repositoryRoot);
      const input = request("exec-001");
      const repository = new GitRepositoryAdapter(repositoryRoot);
      const before = await repository.captureSnapshot();
      const after = await repository.captureSnapshot();
      const finalized = await finalizer(repositoryRoot).finalize({
        request: input,
        result: resultFor(input, [check("passed", true)]),
        before,
        after,
        executionStateRevision: 3,
        basis: {
          requirement_revision: 2,
          plan_version: 1,
          change_sets: ["CS-001"],
        },
        evidence: [{ path: "verification/evidence/VR-001/V-001.stdout.log" }],
      });

      expect(finalized.verificationRun).toMatchObject({
        id: "VR-001",
        status: "complete",
        result: "passed",
        strength: "strong",
        accepted: true,
        basis: { requirement_revision: 2, plan_version: 1 },
      });
      expect(finalized.verificationRun.checks).toMatchObject([
        { check_index: 1, status: "passed", type: "test", required: true },
      ]);
      expect(finalized.verificationRun.evidence).toEqual([
        { path: "verification/evidence/VR-001/V-001.stdout.log" },
      ]);
      expect(finalized.artifact).toEqual({
        runId: RUN_ID,
        path: "verification/VR-001.md",
        status: "complete",
      });

      const artifact = await new FileArtifactStore(repositoryRoot).read(finalized.artifact);
      expect(artifact.frontMatter).toMatchObject({
        verification_run_id: "VR-001",
        execution_state_revision: 3,
        artifact: { type: "verification", status: "complete" },
      });
      expect(artifact.body).toContain('"result": "passed"');
      expect(artifact.body).toContain("requirement_revision");
    });
  });

  it("accepts sufficient inspection evidence without command execution", async () => {
    await withTempRepository({ "src/target.txt": "unchanged\\n" }, async (repositoryRoot) => {
      await initializeGit(repositoryRoot);
      const input = request("exec-006");
      const repository = new GitRepositoryAdapter(repositoryRoot);
      const snapshot = await repository.captureSnapshot();
      const inspection = {
        source: "repository-inspection",
        inspection_performed: true,
        evidence_refs: ["repository current snapshot", "src/target.txt"],
        observed: { changed_files: [], dependency_files_changed: [] },
      };
      const finalized = await finalizer(repositoryRoot).finalize({
        request: input,
        result: resultFor(input, [
          { type: "inspection", status: "passed", required: true, evidence: inspection },
        ]),
        before: snapshot,
        after: snapshot,
        executionStateRevision: 1,
      });

      expect(finalized.verificationRun).toMatchObject({
        result: "passed",
        strength: "weak",
        accepted: true,
        checks: [{ type: "inspection", status: "passed", required: true }],
      });
    });
  });

  it("rejects missing or unavailable evidence for a claimed passed check", async () => {
    await withTempRepository({ "src/target.txt": "unchanged\\n" }, async (repositoryRoot) => {
      await initializeGit(repositoryRoot);
      const input = request("exec-007");
      const repository = new GitRepositoryAdapter(repositoryRoot);
      const snapshot = await repository.captureSnapshot();
      for (const evidence of [
        undefined,
        { source: "verification-tool", command: null, status: "unavailable", reason: "not-run" },
      ]) {
        await expect(
          finalizer(repositoryRoot).finalize({
            request: input,
            result: resultFor(input, [
              {
                type: "inspection",
                status: "passed",
                required: true,
                ...(evidence === undefined ? {} : { evidence }),
              },
            ]),
            before: snapshot,
            after: snapshot,
            executionStateRevision: 1,
          }),
        ).rejects.toMatchObject({ code: "CHECK_INVALID" });
      }
    });
  });

  it("keeps required unavailable checks incomplete and optional unavailable checks acceptable", async () => {
    await withTempRepository({ "src/target.txt": "unchanged\\n" }, async (repositoryRoot) => {
      await initializeGit(repositoryRoot);
      const repository = new GitRepositoryAdapter(repositoryRoot);
      const snapshot = await repository.captureSnapshot();
      const verifierFinalizer = finalizer(repositoryRoot);
      const requiredInput = request("exec-008");
      const required = await verifierFinalizer.finalize({
        request: requiredInput,
        result: resultFor(requiredInput, [check("passed", true), check("unavailable", true)]),
        before: snapshot,
        after: snapshot,
        executionStateRevision: 1,
      });
      expect(required.verificationRun).toMatchObject({
        result: "incomplete",
        accepted: false,
        strength: "partial",
      });

      const optionalInput = request("exec-009");
      const optional = await verifierFinalizer.finalize({
        request: optionalInput,
        result: resultFor(optionalInput, [check("passed", true), check("unavailable", false)]),
        before: snapshot,
        after: snapshot,
        executionStateRevision: 1,
      });
      expect(optional.verificationRun).toMatchObject({
        result: "passed",
        accepted: true,
        strength: "partial",
      });
    });
  });

  it("preserves all check statuses and keeps a failed required check failed", async () => {
    await withTempRepository({ "src/target.txt": "unchanged\n" }, async (repositoryRoot) => {
      await initializeGit(repositoryRoot);
      const input = request("exec-002");
      const repository = new GitRepositoryAdapter(repositoryRoot);
      const snapshot = await repository.captureSnapshot();
      const checks = [
        check("passed", false, "build"),
        check("failed", true, "test"),
        check("skipped", true, "manual"),
        check("unavailable", true, "regression"),
      ];
      const finalized = await finalizer(repositoryRoot).finalize({
        request: input,
        result: resultFor(input, checks),
        before: snapshot,
        after: snapshot,
        executionStateRevision: 1,
      });

      expect(finalized.verificationRun.checks.map(({ status }) => status)).toEqual([
        "passed",
        "failed",
        "skipped",
        "unavailable",
      ]);
      expect(finalized.verificationRun).toMatchObject({
        status: "complete",
        result: "failed",
        strength: "partial",
        accepted: false,
      });
    });
  });

  it("detects Verifier source mutation and finalizes the VR as partial", async () => {
    await withTempRepository({ "src/target.txt": "before\n" }, async (repositoryRoot) => {
      await initializeGit(repositoryRoot);
      const input = request("exec-003");
      const repository = new GitRepositoryAdapter(repositoryRoot);
      const runtime: AgentRuntime = {
        run: async () => {
          await writeFile(join(repositoryRoot, "src/target.txt"), "verifier mutation\n", "utf8");
          return resultFor(input, [check("passed", true)]);
        },
      };
      const execution = await new VerifierExecutor({
        agentRuntime: runtime,
        repository,
        finalizer: finalizer(repositoryRoot),
      }).run({ request: input, executionStateRevision: 1 });

      expect(execution.finalization.verificationRun).toMatchObject({
        status: "partial",
        result: "incomplete",
        accepted: false,
        repository: { mutated: true, changedFiles: ["src/target.txt"] },
      });
      expect(execution.finalization.artifact.status).toBe("partial");
      expect(execution.finalization.contents).toContain(
        '"changed_files": [\n        "src/target.txt"',
      );
    });
  });

  it("rejects malformed checks and write-capable Verifier requests", async () => {
    await withTempRepository({ "src/target.txt": "unchanged\n" }, async (repositoryRoot) => {
      await initializeGit(repositoryRoot);
      const input = request("exec-004");
      const repository = new GitRepositoryAdapter(repositoryRoot);
      const snapshot = await repository.captureSnapshot();

      await expect(
        finalizer(repositoryRoot).finalize({
          request: input,
          result: resultFor(input, [{ status: "unknown", required: true, type: "test" }]),
          before: snapshot,
          after: snapshot,
          executionStateRevision: 1,
        }),
      ).rejects.toMatchObject({ code: "CHECK_INVALID" });

      await expect(
        finalizer(repositoryRoot).finalize({
          request: input,
          result: resultFor(input, [{ status: "passed", required: true, type: "test" }]),
          before: snapshot,
          after: snapshot,
          executionStateRevision: 1,
        }),
      ).rejects.toMatchObject({ code: "CHECK_INVALID" });

      const writeRequest = request("exec-005", {
        tools: { resolved: ["repository-write"], policy: {} },
      });
      let called = false;
      await expect(
        new VerifierExecutor({
          agentRuntime: {
            run: async () => {
              called = true;
              return resultFor(writeRequest, [check("passed", true)]);
            },
          },
          repository,
          finalizer: finalizer(repositoryRoot),
        }).run({ request: writeRequest, executionStateRevision: 1 }),
      ).rejects.toMatchObject({ code: "VERIFIER_REQUEST_INVALID" });
      expect(called).toBe(false);
    });
  });
});
