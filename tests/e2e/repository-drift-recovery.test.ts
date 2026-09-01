import { execFile as nodeExecFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FileArtifactStore } from "../../src/adapters/persistence/write/file-artifact-store.js";
import { GitRepositoryAdapter } from "../../src/adapters/repository/git-repository-adapter.js";
import {
  RepositoryDriftRecovery,
  type RepositoryDriftCheckResult,
} from "../../src/application/recovery/repository-drift-recovery.js";
import type { AgentExecutionRequestV1 } from "../../src/contracts/execution/agent-execution.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const execFile = promisify(nodeExecFile);
const RUN_ID = "run-804" as RunId;

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

function workflowState(): WorkflowState {
  const header = { schema_version: 1, run_id: RUN_ID, state_revision: 1 } as const;
  return {
    run: {
      ...header,
      request: { id: "request-804", type: "feature" },
      status: "running",
      finalized: false,
      graph_revision: 1,
      playbook: { initial: {}, current: {} },
      current_step: {},
      current_plan: { id: "plan-1", applicability: { status: "current" } },
      current_changes: {
        relevant_change_sets: [{ id: "CS-001" }],
        external_reconciliation: null,
      },
      repository: { evidence: { freshness: "fresh" } },
      blocked: null,
      failure: null,
      cancellation: null,
      limits: {},
      counters: {},
      telemetry: { degraded: false },
      outcome: null,
      timestamps: {},
    },
    snapshot: {
      requirement: {
        ...header,
        revision: 1,
        goal: "implement",
        scope: { in: [], out: [] },
        constraints: [],
        acceptance_criteria: [],
        non_goals: [],
        supplied_evidence: [],
        assumptions: [],
        open_questions: [],
      },
      steps: { ...header, graph_revision: 1, steps: [] },
      uncertainties: { ...header, uncertainties: [] },
      decisions: { ...header, decisions: [] },
      gates: { ...header, gates: [] },
      findings: { ...header, findings: [] },
      manifest: {
        ...header,
        previous_state_revision: 0,
        created_at: "2026-08-30T03:02:10.123Z",
        files: [
          "requirement.yaml",
          "steps.yaml",
          "uncertainties.yaml",
          "decisions.yaml",
          "gates.yaml",
          "findings.yaml",
        ],
      },
    },
  };
}

function request(): AgentExecutionRequestV1 {
  return {
    identity: {
      runId: RUN_ID,
      stepId: "step-804" as StepId,
      executionId: "exec-804" as ExecutionId,
      agentId: "recovery",
      agentVersion: "1.0.0",
    },
    objective: { objective: "reconcile repository", type: "analysis", completionCriteria: [] },
    retry: { attempt: 1, context: null },
    execution: { mode: "read-only", timeoutMs: 1_000, cancellationPolicy: {} },
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

async function relevantCheck(
  root: string,
  path: string,
): Promise<{ recovery: RepositoryDriftRecovery; assessment: RepositoryDriftCheckResult }> {
  const repository = new GitRepositoryAdapter(root);
  const before = await repository.captureSnapshot();
  await writeFile(`${root}/${path}`, "workflow change\n", "utf8");
  const recovery = new RepositoryDriftRecovery({
    repository,
    artifactStore: new FileArtifactStore(root),
    now: () => new Date("2026-08-30T03:02:10.123Z"),
  });
  const assessment = await recovery.check({
    before,
    pathClassifications: { [path]: "relevant" },
  });
  return { recovery, assessment };
}

describe("RepositoryDriftRecovery", () => {
  it("clears unrelated drift without invalidating the current Plan or evidence", async () => {
    await withTempRepository({ "README.md": "before\n" }, async (root) => {
      await initializeGit(root);
      const repository = new GitRepositoryAdapter(root);
      const before = await repository.captureSnapshot();
      await writeFile(`${root}/README.md`, "manual change\n", "utf8");

      const recovery = new RepositoryDriftRecovery({ repository });
      const assessment = await recovery.check({
        before,
        pathClassifications: { "README.md": "unrelated" },
      });
      const next = recovery.apply(workflowState(), assessment);

      expect(assessment).toMatchObject({
        classification: "unrelated",
        resolution: "clear",
        blocking: false,
        changedFiles: ["README.md"],
      });
      expect(next.run.status).toBe("running");
      expect(next.run.current_plan?.applicability?.status).toBe("current");
      expect(next.run.repository.evidence).toEqual({ freshness: "fresh" });
    });
  });

  it("blocks relevant drift, invalidates Plan/evidence, and records reconciliation separately", async () => {
    await withTempRepository({ "src/target.txt": "before\n" }, async (root) => {
      await initializeGit(root);
      const { recovery, assessment } = await relevantCheck(root, "src/target.txt");
      const initial = workflowState();
      const blocked = recovery.apply(initial, assessment);

      expect(assessment.classification).toBe("relevant");
      expect(assessment.resolution).toBe("unresolved");
      expect(blocked.run.status).toBe("blocked");
      expect(blocked.run.blocked).toMatchObject({
        reason: "repository-drift",
        classification: "relevant",
      });
      expect(blocked.run.current_plan?.applicability?.status).toBe("replan-required");
      expect(blocked.run.repository.evidence).toMatchObject({
        freshness: "stale",
        invalidated_by: "repository-drift",
      });
      expect(blocked.run.current_changes.relevant_change_sets).toEqual([{ id: "CS-001" }]);

      const reconciliation = {
        execution_id: "exec-804",
        explanation: "The manual edit is accepted as the current implementation basis.",
      };
      const reconciled = recovery.apply(initial, assessment, reconciliation);
      expect(reconciled.run.status).toBe("running");
      expect(reconciled.run.repository).toMatchObject({
        classification: "relevant",
        resolution: "reconciled",
      });
      expect(reconciled.run.current_plan?.applicability?.status).toBe("replan-required");
      expect(reconciled.run.current_changes).toMatchObject({
        relevant_change_sets: [{ id: "CS-001" }],
        external_reconciliation: reconciliation,
      });

      const finalized = await recovery.finalizeReconciliation({
        request: request(),
        executionStateRevision: 2,
        assessment,
        reconciliation,
      });
      expect(finalized.artifact.path).toBe("implementation/reconciliation-exec-804.md");
      await expect(
        readFile(`${root}/.pi/runs/${RUN_ID}/implementation/reconciliation-exec-804.md`, "utf8"),
      ).resolves.toContain("Repository Reconciliation");
    });
  });

  it("fails closed for critical and unknown drift", async () => {
    await withTempRepository({ "critical.txt": "before\n" }, async (root) => {
      await initializeGit(root);
      const repository = new GitRepositoryAdapter(root);
      const before = await repository.captureSnapshot();
      await writeFile(`${root}/critical.txt`, "critical change\n", "utf8");
      const recovery = new RepositoryDriftRecovery({ repository });
      const critical = await recovery.check({
        before,
        pathClassifications: { "critical.txt": "critical" },
      });
      expect(critical.classification).toBe("critical");
      expect(recovery.apply(workflowState(), critical).run.status).toBe("blocked");
    });

    await withTempRepository({ "unknown.txt": "before\n" }, async (root) => {
      await initializeGit(root);
      const repository = new GitRepositoryAdapter(root);
      const before = await repository.captureSnapshot();
      await writeFile(`${root}/unknown.txt`, "unknown change\n", "utf8");
      const recovery = new RepositoryDriftRecovery({ repository });
      const unknown = await recovery.check({ before });
      expect(unknown).toMatchObject({
        classification: "unknown",
        resolution: "unresolved",
        blocking: true,
      });
      expect(recovery.apply(workflowState(), unknown).run.status).toBe("blocked");
    });
  });
});
