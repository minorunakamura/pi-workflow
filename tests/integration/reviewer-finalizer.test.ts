import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ReviewerFinalizer,
  type ReviewerFinalizerInput,
} from "../../src/application/execution/reviewer-finalizer.js";
import type {
  AgentExecutionRequestV1,
  StepResultV1,
} from "../../src/contracts/execution/agent-execution.js";
import type { ExecutionId, FindingId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import { FileArtifactStore } from "../../src/adapters/persistence/write/file-artifact-store.js";
import { GitRepositoryAdapter } from "../../src/adapters/repository/git-repository-adapter.js";
import { createFinding, type Finding } from "../../src/domain/findings/finding.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const execFile = promisify(nodeExecFile);
const RUN_ID = "run-705" as RunId;

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
      stepId: "step-001" as StepId,
      executionId: executionId as ExecutionId,
      agentId: "reviewer",
      agentVersion: "1.0.0",
    },
    objective: {
      objective: "review current implementation",
      type: "review",
      completionCriteria: [],
    },
    retry: { attempt: 1, context: null },
    execution: { mode: "read-only", timeoutMs: 1_000, cancellationPolicy: {} },
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

function finding(
  id: string,
  state: "open" | "resolved",
  disposition: "pending" | "fixed",
): Finding {
  return createFinding({
    id: id as FindingId,
    state,
    disposition,
    severity: "high",
    confidence: "high",
  });
}

function resultFor(input: AgentExecutionRequestV1): StepResultV1 {
  return {
    identity: input.identity,
    outcome: "completed",
    mode: "read-only",
    summary: "review completed",
    artifacts: [],
    uncertainty_candidates: [],
    decision_requests: [],
    requirement_candidates: { acceptance_criteria: [], constraints: [], assumptions: [] },
    finding_candidates: [{ localId: "new-finding", severity: "medium", confidence: "high" }],
    finding_rechecks: [
      { finding_id: "F-001", state: "resolved", disposition: "fixed" },
      { finding_id: "F-002", action: "dismiss" },
      { finding_id: "F-003", action: "reopen" },
    ],
    plan_deviations: [],
    skill_requests: [],
    execution_checks: [],
    observations: [],
    blocked: null,
    failure: null,
    runtime: {},
  };
}

function finalizer(repositoryRoot: string): ReviewerFinalizer {
  return new ReviewerFinalizer({
    artifactStore: new FileArtifactStore(repositoryRoot),
    repository: new GitRepositoryAdapter(repositoryRoot),
    now: () => new Date("2026-08-30T03:02:10.123Z"),
  });
}

describe("ReviewerFinalizer integration", () => {
  it("normalizes RR/F identities and Finding fix, dismiss, and reopen rechecks", async () => {
    await withTempRepository({ "src/target.txt": "unchanged\n" }, async (repositoryRoot) => {
      await initializeGit(repositoryRoot);
      const input = request("exec-001");
      const repository = new GitRepositoryAdapter(repositoryRoot);
      const snapshot = await repository.captureSnapshot();
      const finalized = await finalizer(repositoryRoot).finalize({
        request: input,
        result: resultFor(input),
        before: snapshot,
        after: snapshot,
        executionStateRevision: 3,
        kind: "change",
        findings: [
          finding("F-001", "open", "pending"),
          finding("F-002", "open", "pending"),
          finding("F-003", "resolved", "fixed"),
        ],
        basis: { requirement_revision: 2, plan_version: 1 },
      });

      expect(finalized.reviewRun).toMatchObject({
        id: "RR-001",
        status: "complete",
        result: "findings",
        kind: "change",
        basis: { requirement_revision: 2, plan_version: 1 },
      });
      expect(finalized.findings[0]).toMatchObject({ id: "F-004", severity: "medium" });
      expect(finalized.rechecks).toMatchObject([
        { id: "F-001", state: "resolved", disposition: "fixed" },
        { id: "F-002", state: "resolved", disposition: "dismissed" },
        { id: "F-003", state: "open", disposition: "pending" },
      ]);
      expect(finalized.rechecks.map(({ id }) => id)).toEqual(["F-001", "F-002", "F-003"]);
      expect(finalized.artifact).toEqual({
        runId: RUN_ID,
        path: "reviews/RR-001.md",
        status: "complete",
      });

      const artifact = await new FileArtifactStore(repositoryRoot).read(finalized.artifact);
      expect(artifact.frontMatter).toMatchObject({
        review_run_id: "RR-001",
        execution_state_revision: 3,
        artifact: { type: "review", status: "complete" },
      });
      expect(artifact.body).toContain('"id": "F-004"');
      expect(artifact.body).toContain('"disposition": "dismissed"');
    });
  });

  it("rejects an unknown Finding recheck without creating an Artifact", async () => {
    await withTempRepository({ "src/target.txt": "unchanged\n" }, async (repositoryRoot) => {
      await initializeGit(repositoryRoot);
      const input = request("exec-002");
      const repository = new GitRepositoryAdapter(repositoryRoot);
      const snapshot = await repository.captureSnapshot();
      const invalid = {
        ...resultFor(input),
        finding_candidates: [],
        finding_rechecks: [{ finding_id: "F-999", action: "fix" }],
      } as StepResultV1;

      const finalizationInput: ReviewerFinalizerInput = {
        request: input,
        result: invalid,
        before: snapshot,
        after: snapshot,
        executionStateRevision: 1,
        findings: [finding("F-001", "open", "pending")],
      };
      await expect(finalizer(repositoryRoot).finalize(finalizationInput)).rejects.toMatchObject({
        code: "RECHECK_INVALID",
      });
    });
  });
});
