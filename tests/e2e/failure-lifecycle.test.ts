import { join } from "node:path";
import { readFile, rename as nodeRename } from "node:fs/promises";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { FileArtifactStore } from "../../src/adapters/persistence/write/file-artifact-store.js";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import { JsonlEventReader } from "../../src/adapters/persistence/read/jsonl-event-reader.js";
import { FileStateStore } from "../../src/adapters/persistence/write/file-state-store.js";
import { FailureLifecycle } from "../../src/application/recovery/failure-lifecycle.js";
import { ResumeLifecycle } from "../../src/application/recovery/resume-lifecycle.js";
import type { RunId, StepId } from "../../src/domain/primitives/ids.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const RUN_ID = "run-001" as RunId;
const STEP_ID = "step-001" as StepId;
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
      steps: { ...header, graph_revision: 1, steps: [] },
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

describe("FailureLifecycle E2E", () => {
  it("persists a resumable Failure Record without an Outcome", async () => {
    await withTempRepository(fixtureFor(workflowState()), async (repositoryRoot) => {
      const reader = new FileRunReader(repositoryRoot);
      const artifactStore = new FileArtifactStore(repositoryRoot);
      const failed = await new FailureLifecycle({
        runReader: reader,
        stateStore: new FileStateStore(repositoryRoot),
        artifactStore,
        artifactReader: artifactStore,
        now: () => new Date(CREATED_AT),
      }).fail(RUN_ID, { resumable: true, reason: "retry later" });

      expect(failed.run).toMatchObject({
        status: "failed",
        finalized: false,
        failure: {
          artifact_path: "failures/failure-001.md",
          resumable: true,
        },
        outcome: null,
        counters: { failure_record_last_issued: 1 },
      });
      await expect(
        artifactStore.read({
          runId: RUN_ID,
          path: "failures/failure-001.md",
          status: "complete",
        }),
      ).resolves.toMatchObject({
        frontMatter: { artifact: { type: "failure", status: "complete" } },
        body: expect.stringContaining('"resumable": true'),
      });
      await expect(
        artifactStore.read({ runId: RUN_ID, path: "outcome.md", status: "complete" }),
      ).rejects.toThrow();

      const events = await new JsonlEventReader(repositoryRoot).readAfter(RUN_ID, 0);
      expect(events).toMatchObject([
        { type: "run.failed", state_revision: 2, data: { resumable: true, finalized: false } },
      ]);
    });
  });

  it("persists a Failure Record and Outcome before finalizing a final failure", async () => {
    await withTempRepository(fixtureFor(workflowState()), async (repositoryRoot) => {
      const reader = new FileRunReader(repositoryRoot);
      const artifactStore = new FileArtifactStore(repositoryRoot);
      const failed = await new FailureLifecycle({
        runReader: reader,
        stateStore: new FileStateStore(repositoryRoot),
        artifactStore,
        artifactReader: artifactStore,
        now: () => new Date(CREATED_AT),
      }).fail(RUN_ID, { resumable: false, reason: "budget exhausted" });

      expect(failed.run).toMatchObject({
        status: "failed",
        finalized: true,
        failure: {
          artifact_path: "failures/failure-001.md",
          resumable: false,
        },
        outcome: {
          status: "failed",
          artifact_path: "outcome.md",
          failure_artifact_path: "failures/failure-001.md",
        },
      });
      await expect(
        artifactStore.read({
          runId: RUN_ID,
          path: "failures/failure-001.md",
          status: "complete",
        }),
      ).resolves.toMatchObject({ frontMatter: { artifact: { type: "failure" } } });
      await expect(
        artifactStore.read({ runId: RUN_ID, path: "outcome.md", status: "complete" }),
      ).resolves.toMatchObject({
        frontMatter: { artifact: { type: "outcome", status: "complete" } },
        body: expect.stringContaining('"status": "failed"'),
      });
    });
  });

  it("leaves no missing state pointer across a crash and retries with immutable records", async () => {
    await withTempRepository(fixtureFor(workflowState()), async (repositoryRoot) => {
      const runPath = join(repositoryRoot, RUN_DIRECTORY, "run.yaml");
      const reader = new FileRunReader(repositoryRoot);
      const artifactStore = new FileArtifactStore(repositoryRoot);
      const crashingStore = new FileStateStore(repositoryRoot, {
        rename: async (source, destination) => {
          if (destination === runPath)
            throw new Error("simulated crash before pointer replacement");
          await nodeRename(source, destination);
        },
      });

      await expect(
        new FailureLifecycle({
          runReader: reader,
          stateStore: crashingStore,
          artifactStore,
          now: () => new Date(CREATED_AT),
        }).fail(RUN_ID, { resumable: false, reason: "crash" }),
      ).rejects.toThrow("simulated crash before pointer replacement");

      await expect(reader.load(RUN_ID)).resolves.toMatchObject({
        run: { status: "running", finalized: false, failure: null, outcome: null },
      });
      await expect(
        readFile(join(repositoryRoot, RUN_DIRECTORY, "failures/failure-001.md"), "utf8"),
      ).resolves.toContain('"status": "failed"');

      const retried = await new FailureLifecycle({
        runReader: reader,
        stateStore: new FileStateStore(repositoryRoot),
        artifactStore,
        artifactReader: artifactStore,
        now: () => new Date(CREATED_AT),
      }).fail(RUN_ID, { resumable: false, reason: "crash" });

      expect(retried.run).toMatchObject({
        status: "failed",
        finalized: true,
        failure: { artifact_path: "failures/failure-002.md" },
        outcome: { artifact_path: "outcome.md" },
      });
      await expect(
        artifactStore.read({
          runId: RUN_ID,
          path: "failures/failure-001.md",
          status: "complete",
        }),
      ).resolves.toBeDefined();
      await expect(
        artifactStore.read({
          runId: RUN_ID,
          path: "failures/failure-002.md",
          status: "complete",
        }),
      ).resolves.toBeDefined();
    });
  });

  it("clears only the current failure pointer after a successful resume", async () => {
    await withTempRepository(fixtureFor(workflowState()), async (repositoryRoot) => {
      const reader = new FileRunReader(repositoryRoot);
      const artifactStore = new FileArtifactStore(repositoryRoot);
      const stateStore = new FileStateStore(repositoryRoot);
      await new FailureLifecycle({
        runReader: reader,
        stateStore,
        artifactStore,
        now: () => new Date(CREATED_AT),
      }).fail(RUN_ID, { resumable: true, reason: "retry" });

      const resumed = await new ResumeLifecycle({
        runReader: reader,
        stateStore,
        recheckRepositoryAndFreshness: async (state) => state,
      }).resume(RUN_ID);

      expect(resumed.run).toMatchObject({ status: "running", finalized: false, outcome: null });
      expect(resumed.run.failure).toBeNull();
      await expect(
        artifactStore.read({
          runId: RUN_ID,
          path: "failures/failure-001.md",
          status: "complete",
        }),
      ).resolves.toBeDefined();
    });
  });
});
