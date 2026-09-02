import { readFile, rename as nodeRename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import { FileArtifactStore } from "../../src/adapters/persistence/write/file-artifact-store.js";
import { FileStateStore } from "../../src/adapters/persistence/write/file-state-store.js";
import {
  WorkerExecutionInterruptedError,
  WorkerExecutor,
  WorkerFinalizer,
} from "../../src/application/execution/worker-finalizer.js";
import { Orchestrator } from "../../src/application/orchestrator.js";
import { CancellationLifecycle } from "../../src/application/recovery/cancellation-lifecycle.js";
import { ResumeLifecycle } from "../../src/application/recovery/resume-lifecycle.js";
import { withNextRevision } from "../../src/application/state-revision.js";
import type {
  AgentExecutionRequestV1,
  StepResultV1,
} from "../../src/contracts/execution/agent-execution.js";
import { createStep } from "../../src/domain/graph/step-graph.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import type {
  RepositoryAdapter,
  RepositoryDiff,
  RepositorySnapshot,
} from "../../src/ports/repository.js";
import type { StateStore } from "../../src/ports/state-store.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const RUN_ID = "run-001" as RunId;
const STEP_ID = "step-001" as StepId;
const EXECUTION_ID = "exec-001" as ExecutionId;
const RUN_DIRECTORY = `.pi/runs/${RUN_ID}`;
const CREATED_AT = "2026-08-30T03:02:10.123Z";

function workflowState(status: "running" | "blocked" = "running"): WorkflowState {
  const stateRevision = 1;
  const header = { schema_version: 1, run_id: RUN_ID, state_revision: stateRevision } as const;
  return {
    run: {
      schema_version: 1,
      run_id: RUN_ID,
      request: { id: "request-001", type: "feature" },
      status,
      finalized: false,
      state_revision: stateRevision,
      graph_revision: 1,
      playbook: { initial: {}, current: {} },
      current_step: { id: STEP_ID },
      current_plan: null,
      current_changes: { relevant_change_sets: [], external_reconciliation: null },
      repository: {},
      blocked: status === "blocked" ? { reason: "waiting" } : null,
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
        goal: "goal",
        scope: { in: [], out: [] },
        constraints: [],
        acceptance_criteria: [],
        non_goals: [],
        supplied_evidence: [],
        assumptions: [],
        open_questions: [],
      },
      steps: {
        ...header,
        graph_revision: 1,
        steps: [
          {
            id: STEP_ID,
            type: "implementation",
            objective: "implement",
            agent: "worker",
            skills: [],
            inputs: [],
            outputs: [],
            depends_on: [],
            completion_criteria: [],
            status: "ready",
            blocked_by: [],
            result: null,
          },
        ],
      },
      uncertainties: { ...header, uncertainties: [] },
      decisions: { ...header, decisions: [] },
      gates: { ...header, gates: [] },
      findings: { ...header, findings: [] },
      manifest: {
        ...header,
        previous_state_revision: 0,
        created_at: CREATED_AT,
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

function fixtureFor(state: WorkflowState): Record<string, string> {
  const directory = `${RUN_DIRECTORY}/state/snapshots/${state.run.state_revision}`;
  return {
    [`${RUN_DIRECTORY}/run.yaml`]: stringify(state.run),
    [`${directory}/requirement.yaml`]: stringify(state.snapshot.requirement),
    [`${directory}/steps.yaml`]: stringify(state.snapshot.steps),
    [`${directory}/uncertainties.yaml`]: stringify(state.snapshot.uncertainties),
    [`${directory}/decisions.yaml`]: stringify(state.snapshot.decisions),
    [`${directory}/gates.yaml`]: stringify(state.snapshot.gates),
    [`${directory}/findings.yaml`]: stringify(state.snapshot.findings),
    [`${directory}/manifest.json`]: JSON.stringify(state.snapshot.manifest),
  };
}

function request(): AgentExecutionRequestV1 {
  return {
    identity: {
      runId: RUN_ID,
      stepId: STEP_ID,
      executionId: EXECUTION_ID,
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

function result(): StepResultV1 {
  return {
    identity: { runId: RUN_ID, stepId: STEP_ID, executionId: EXECUTION_ID },
    outcome: "completed",
    summary: "done",
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

function mutationEvidence(root: string): {
  before: RepositorySnapshot;
  after: RepositorySnapshot;
  diff: RepositoryDiff;
} {
  const before: RepositorySnapshot = {
    root,
    head: "head-1",
    branch: "main",
    status: { dirty: false, changed: [], untracked: [], entries: [] },
    fingerprints: { "src/target.txt": "before" },
    fingerprint: "repo-before",
  };
  const after: RepositorySnapshot = {
    ...before,
    status: { dirty: true, changed: ["src/target.txt"], untracked: [], entries: [] },
    fingerprints: { "src/target.txt": "after" },
    fingerprint: "repo-after",
  };
  const diff: RepositoryDiff = {
    before,
    after,
    files: [
      {
        path: "src/target.txt",
        change: "modified",
        beforeFingerprint: "before",
        afterFingerprint: "after",
      },
    ],
    changedFiles: ["src/target.txt"],
    addedFiles: [],
    modifiedFiles: ["src/target.txt"],
    deletedFiles: [],
    beforeFingerprint: before.fingerprint,
    afterFingerprint: after.fingerprint,
    headChanged: false,
    branchChanged: false,
    statusChanged: true,
    fingerprintChanged: true,
  };
  return { before, after, diff };
}

async function loadCompleteState(
  repositoryRoot: string,
  expectedRevisions: readonly number[],
): Promise<WorkflowState> {
  const state = await new FileRunReader(repositoryRoot).load(RUN_ID);
  expect(expectedRevisions).toContain(state.run.state_revision);
  const documents = [
    state.snapshot.requirement,
    state.snapshot.steps,
    state.snapshot.uncertainties,
    state.snapshot.decisions,
    state.snapshot.gates,
    state.snapshot.findings,
    state.snapshot.manifest,
  ];
  for (const document of documents) {
    expect(document.state_revision).toBe(state.run.state_revision);
  }
  return state;
}

describe("Workflow Runtime crash matrix", () => {
  it.each(["before Agent", "during Agent"] as const)(
    "keeps the old complete State when a crash occurs %s",
    async (phase) => {
      const initial = workflowState();
      await withTempRepository(fixtureFor(initial), async (repositoryRoot) => {
        let agentCalls = 0;
        const step = createStep({
          id: STEP_ID,
          type: "implementation",
          objective: "implement",
          agent: "worker",
          status: "ready",
        });
        const orchestrator = new Orchestrator({
          runReader: new FileRunReader(repositoryRoot),
          stateStore: new FileStateStore(repositoryRoot),
          agentRuntime: {
            run: async () => {
              agentCalls += 1;
              await Promise.resolve();
              throw new Error("simulated Agent crash");
            },
          },
          buildRequest: async () => {
            if (phase === "before Agent") throw new Error("simulated crash before Agent");
            return request();
          },
          completion: async () => ({ eligible: false, blockers: ["STEP_INCOMPLETE"] }),
          schedule: async () => ({ kind: "dispatch", step }),
          fixCycle: false,
        });

        await expect(orchestrator.run(RUN_ID)).rejects.toThrow(
          /simulated (?:crash before Agent|Agent crash)/,
        );
        expect(agentCalls).toBe(phase === "before Agent" ? 0 : 1);
        const state = await loadCompleteState(repositoryRoot, [1]);
        expect(state.run.status).toBe("running");
      });
    },
  );

  it("keeps the old complete State and finalizes partial evidence when Worker crashes", async () => {
    const initial = workflowState();
    await withTempRepository(
      { ...fixtureFor(initial), "src/target.txt": "before\n" },
      async (repositoryRoot) => {
        const artifactStore = new FileArtifactStore(repositoryRoot);
        const evidence = mutationEvidence(repositoryRoot);
        let snapshots = 0;
        const repository: RepositoryAdapter = {
          getRoot: async () => repositoryRoot,
          getHead: async () => evidence.before.head,
          getBranch: async () => evidence.before.branch,
          captureSnapshot: async () => {
            snapshots += 1;
            return snapshots === 1 ? evidence.before : evidence.after;
          },
          diff: async () => evidence.diff,
        };
        const executor = new WorkerExecutor({
          repository,
          finalizer: new WorkerFinalizer({ artifactStore, now: () => new Date(CREATED_AT) }),
          agentRuntime: {
            run: async () => {
              await writeFile(join(repositoryRoot, "src/target.txt"), "partial\n", "utf8");
              throw new Error("simulated Worker crash");
            },
          },
        });

        const error = await executor.run({ request: request(), executionStateRevision: 1 }).then(
          () => undefined,
          (failure: unknown) => failure,
        );
        expect(error).toBeInstanceOf(WorkerExecutionInterruptedError);
        if (!(error instanceof WorkerExecutionInterruptedError)) throw new Error("missing crash");
        expect(error.recovery).toMatchObject({
          kind: "partial",
          finalization: { changeSet: { status: "partial", accepted: false } },
        });
        const artifact = error.recovery.finalization?.artifact;
        expect(artifact).toBeDefined();
        if (artifact === undefined) throw new Error("missing partial artifact");
        await expect(artifactStore.read(artifact)).resolves.toMatchObject({
          frontMatter: { artifact: { status: "partial" } },
        });
        await expect(readFile(join(repositoryRoot, "src/target.txt"), "utf8")).resolves.toBe(
          "partial\n",
        );
        expect((await loadCompleteState(repositoryRoot, [1])).run.state_revision).toBe(1);
      },
    );
  });

  it("keeps the old complete State when a crash occurs after Artifact finalization", async () => {
    const initial = workflowState();
    await withTempRepository(
      { ...fixtureFor(initial), "src/target.txt": "before\n" },
      async (repositoryRoot) => {
        const artifactStore = new FileArtifactStore(repositoryRoot);
        const evidence = mutationEvidence(repositoryRoot);
        const finalization = await new WorkerFinalizer({
          artifactStore,
          now: () => new Date(CREATED_AT),
        }).finalize({
          request: request(),
          result: result(),
          before: evidence.before,
          after: evidence.after,
          diff: evidence.diff,
          writeScope: ["src"],
          executionStateRevision: 1,
        });
        await expect(artifactStore.read(finalization.artifact)).resolves.toMatchObject({
          frontMatter: { artifact: { status: "complete" } },
        });

        const runPath = join(repositoryRoot, RUN_DIRECTORY, "run.yaml");
        const stateStore = new FileStateStore(repositoryRoot, {
          rename: async (source, destination) => {
            if (destination === runPath) throw new Error("simulated crash before State pointer");
            await nodeRename(source, destination);
          },
        });
        await expect(
          stateStore.commit({
            expectedRevision: 1,
            next: withNextRevision(initial, initial),
          }),
        ).rejects.toThrow("simulated crash before State pointer");

        const state = await loadCompleteState(repositoryRoot, [1]);
        expect(state.run.state_revision).toBe(1);
        await expect(artifactStore.read(finalization.artifact)).resolves.toMatchObject({
          frontMatter: { artifact: { status: "complete" } },
        });
      },
    );
  });

  it("keeps a complete new State when a crash occurs after the State commit", async () => {
    const initial = workflowState();
    await withTempRepository(fixtureFor(initial), async (repositoryRoot) => {
      const base = new FileStateStore(repositoryRoot);
      const crashingStore: StateStore = {
        load: (runId) => base.load(runId),
        commit: async (input) => {
          await base.commit(input);
          throw new Error("simulated crash after State commit");
        },
      };

      await expect(
        crashingStore.commit({
          expectedRevision: 1,
          next: withNextRevision(initial, initial),
        }),
      ).rejects.toThrow("simulated crash after State commit");
      const state = await loadCompleteState(repositoryRoot, [2]);
      expect(state.run.state_revision).toBe(2);
    });
  });

  it("leaves a complete new State when resume crashes after its commit", async () => {
    const initial = workflowState("blocked");
    await withTempRepository(fixtureFor(initial), async (repositoryRoot) => {
      const base = new FileStateStore(repositoryRoot);
      const crashingStore: StateStore = {
        load: (runId) => base.load(runId),
        commit: async (input) => {
          await base.commit(input);
          throw new Error("simulated resume crash");
        },
      };
      const lifecycle = new ResumeLifecycle({
        runReader: new FileRunReader(repositoryRoot),
        stateStore: crashingStore,
        recheckRepositoryAndFreshness: async (state) => state,
        now: () => new Date(CREATED_AT),
      });

      await expect(lifecycle.resume(RUN_ID)).rejects.toThrow("simulated resume crash");
      const state = await loadCompleteState(repositoryRoot, [2]);
      expect(state.run).toMatchObject({ status: "running", finalized: false, blocked: null });
    });
  });

  it("recovers a cancellation crash with a complete intent State and immutable Outcome", async () => {
    const initial = workflowState();
    await withTempRepository(fixtureFor(initial), async (repositoryRoot) => {
      const artifactStore = new FileArtifactStore(repositoryRoot);
      const base = new FileStateStore(repositoryRoot);
      let commitCalls = 0;
      const crashingStore: StateStore = {
        load: (runId) => base.load(runId),
        commit: async (input) => {
          commitCalls += 1;
          if (commitCalls > 1) throw new Error("simulated cancellation crash");
          return base.commit(input);
        },
      };
      const lifecycle = new CancellationLifecycle({
        runReader: new FileRunReader(repositoryRoot),
        stateStore: crashingStore,
        artifactStore,
        artifactReader: artifactStore,
        now: () => new Date(CREATED_AT),
      });

      await expect(
        lifecycle.cancel(RUN_ID, { requestedBy: "user", reason: "stop" }),
      ).rejects.toThrow("simulated cancellation crash");
      expect(commitCalls).toBe(3);
      const intentState = await loadCompleteState(repositoryRoot, [2]);
      expect(intentState.run.cancellation).toMatchObject({ requested: true, reason: "stop" });
      await expect(
        artifactStore.read({ runId: RUN_ID, path: "outcome.md", status: "complete" }),
      ).resolves.toMatchObject({ frontMatter: { artifact: { status: "complete" } } });

      const recovered = await new CancellationLifecycle({
        runReader: new FileRunReader(repositoryRoot),
        stateStore: base,
        artifactStore,
        artifactReader: artifactStore,
        now: () => new Date(CREATED_AT),
      }).cancel(RUN_ID);
      expect(recovered.run).toMatchObject({ status: "cancelled", finalized: true });
      expect((await loadCompleteState(repositoryRoot, [3])).run.status).toBe("cancelled");
    });
  });
});
