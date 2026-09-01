import { readFile, writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { FileArtifactStore } from "../../src/adapters/persistence/write/file-artifact-store.js";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import { JsonlEventReader } from "../../src/adapters/persistence/read/jsonl-event-reader.js";
import { FileStateStore } from "../../src/adapters/persistence/write/file-state-store.js";
import {
  WorkerExecutor,
  WorkerFinalizer,
} from "../../src/application/execution/worker-finalizer.js";
import { Orchestrator } from "../../src/application/orchestrator.js";
import { CancellationLifecycle } from "../../src/application/recovery/cancellation-lifecycle.js";
import { withNextRevision } from "../../src/application/state-revision.js";
import type { AgentExecutionRequestV1 } from "../../src/contracts/execution/agent-execution.js";
import type { DomainEventDraft } from "../../src/contracts/events/event.js";
import { createStep } from "../../src/domain/graph/step-graph.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import type {
  RepositoryAdapter,
  RepositoryDiff,
  RepositorySnapshot,
} from "../../src/ports/repository.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const RUN_ID = "run-001" as RunId;
const STEP_ID = "step-001" as StepId;
const EXECUTION_ID = "exec-001" as ExecutionId;
const RUN_DIRECTORY = `.pi/runs/${RUN_ID}`;
const CREATED_AT = "2026-08-30T03:02:10.123Z";

function workflowState(stateRevision = 1): WorkflowState {
  const header = { schema_version: 1, run_id: RUN_ID, state_revision: stateRevision } as const;
  return {
    run: {
      schema_version: 1,
      run_id: RUN_ID,
      request: { id: "request-001", type: "feature" },
      status: "running",
      finalized: false,
      state_revision: stateRevision,
      graph_revision: 1,
      playbook: { initial: {}, current: {} },
      current_step: { id: STEP_ID },
      current_plan: null,
      current_changes: { relevant_change_sets: [], external_reconciliation: null },
      repository: {},
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
        previous_state_revision: Math.max(0, stateRevision - 1),
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
    execution: { mode: "write", timeoutMs: 10_000, cancellationPolicy: {} },
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

describe("CancellationLifecycle", () => {
  it("recovers a persisted intent after a crash and writes the Outcome before terminal state", async () => {
    const initial = workflowState();

    await withTempRepository(fixtureFor(initial), async (repositoryRoot) => {
      const runReader = new FileRunReader(repositoryRoot);
      const stateStore = new FileStateStore(repositoryRoot);
      const artifactStore = new FileArtifactStore(repositoryRoot);
      const persistedIntent = {
        requested: true,
        requested_at: CREATED_AT,
        requested_by: "user",
        reason: "stop",
      } as const;
      const candidate = withNextRevision(initial, {
        ...initial,
        run: { ...initial.run, cancellation: persistedIntent },
      });
      const intentEvent: DomainEventDraft = {
        schema_version: 1,
        type: "run.cancel-requested",
        timestamp: CREATED_AT,
        run_id: RUN_ID,
        source: { component: "cancellation" },
        actor: { type: "user" },
        state_revision: candidate.run.state_revision,
        data: { cancellation_requested: true },
      };
      await stateStore.commit({
        expectedRevision: initial.run.state_revision,
        next: candidate,
        events: [intentEvent],
      });

      const cancelled = await new CancellationLifecycle({
        runReader,
        stateStore,
        artifactStore,
        artifactReader: artifactStore,
        now: () => new Date(CREATED_AT),
      }).cancel(RUN_ID);

      expect(cancelled.run).toMatchObject({
        status: "cancelled",
        finalized: true,
        state_revision: 3,
        outcome: {
          status: "cancelled",
          request_satisfied: false,
          artifact_path: "outcome.md",
        },
      });
      const outcome = await artifactStore.read({
        runId: RUN_ID,
        path: "outcome.md",
        status: "complete",
      });
      expect(outcome.frontMatter.artifact).toEqual({ type: "outcome", status: "complete" });
      expect(outcome.body).toContain('"request_satisfied": false');

      const events = await new JsonlEventReader(repositoryRoot).readAfter(RUN_ID, 0);
      expect(events.map(({ type, state_revision }) => ({ type, state_revision }))).toEqual([
        { type: "run.cancel-requested", state_revision: 2 },
        { type: "run.cancelled", state_revision: 3 },
      ]);
    });
  });

  it("persists intent, aborts the Worker, preserves its mutation, and finalizes partial evidence", async () => {
    const initial = workflowState();

    await withTempRepository(
      { ...fixtureFor(initial), "src/target.txt": "before\n" },
      async (repositoryRoot) => {
        const runReader = new FileRunReader(repositoryRoot);
        const stateStore = new FileStateStore(repositoryRoot);
        const artifactStore = new FileArtifactStore(repositoryRoot);
        const before: RepositorySnapshot = {
          root: repositoryRoot,
          head: "head-1",
          branch: "main",
          status: { dirty: false, changed: [], untracked: [], entries: [] },
          fingerprints: { "src/target.txt": "before" },
          fingerprint: "repo-before",
        };
        const after: RepositorySnapshot = {
          ...before,
          status: { dirty: true, changed: ["src/target.txt"], untracked: [], entries: [] },
          fingerprints: { "src/target.txt": "partial" },
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
              afterFingerprint: "partial",
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
        let snapshots = 0;
        const repository: RepositoryAdapter = {
          getRoot: async () => repositoryRoot,
          getHead: async () => before.head,
          getBranch: async () => before.branch,
          captureSnapshot: async () => {
            snapshots += 1;
            return snapshots === 1 ? before : after;
          },
          diff: async () => diff,
        };
        const workerFinalizer = new WorkerFinalizer({
          artifactStore,
          repository,
          now: () => new Date(CREATED_AT),
        });
        let startedResolve!: () => void;
        const started = new Promise<void>((resolve) => {
          startedResolve = resolve;
        });
        const worker = new WorkerExecutor({
          repository,
          finalizer: workerFinalizer,
          agentRuntime: {
            run: async (_input, signal) => {
              await readFile(`${repositoryRoot}/src/target.txt`, "utf8");
              await writeFile(`${repositoryRoot}/src/target.txt`, "partial\n", "utf8");
              startedResolve();
              await new Promise<never>((_resolve, reject) => {
                if (signal?.aborted) {
                  reject(new Error("Worker aborted"));
                  return;
                }
                signal?.addEventListener("abort", () => reject(new Error("Worker aborted")), {
                  once: true,
                });
              });
            },
          },
        });
        const lifecycle = new CancellationLifecycle({
          runReader,
          stateStore,
          artifactStore,
          artifactReader: artifactStore,
          now: () => new Date(CREATED_AT),
        });
        const step = createStep({
          id: STEP_ID,
          type: "implementation",
          objective: "implement",
          agent: "worker",
          status: "ready",
        });
        let dispatches = 0;
        const orchestrator = new Orchestrator({
          runReader,
          stateStore,
          cancellation: lifecycle,
          agentRuntime: {
            run: async (input, signal) =>
              (
                await worker.run({
                  request: input,
                  executionStateRevision: 1,
                  ...(signal === undefined ? {} : { signal }),
                })
              ).result,
          },
          buildRequest: async () => request(),
          completion: async () => ({ eligible: false, blockers: ["STEP_INCOMPLETE"] }),
          schedule: async () => {
            dispatches += 1;
            return { kind: "dispatch", step };
          },
          fixCycle: false,
        });
        const orchestration = orchestrator.run(RUN_ID);
        await started;
        const cancelled = lifecycle.cancel(RUN_ID, { requestedBy: "user", reason: "stop" });
        const [runResult, finalState] = await Promise.all([orchestration, cancelled]);

        expect(runResult).toMatchObject({ kind: "idle", reason: "RUN_TERMINAL" });
        expect(dispatches).toBe(1);
        expect(finalState.run).toMatchObject({ status: "cancelled", finalized: true });
        await expect(readFile(`${repositoryRoot}/src/target.txt`, "utf8")).resolves.toBe(
          "partial\n",
        );
        const changeSet = await artifactStore.read({
          runId: RUN_ID,
          path: "implementation/change-set-CS-001.md",
          status: "partial",
        });
        expect(changeSet.frontMatter.artifact.status).toBe("partial");
        const outcome = await artifactStore.read({
          runId: RUN_ID,
          path: "outcome.md",
          status: "complete",
        });
        expect(outcome.body).toContain('"status": "cancelled"');
      },
    );
  });
});
