import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import { FileStateStore } from "../../src/adapters/persistence/write/file-state-store.js";
import {
  ResumeLifecycle,
  type ResumeFreshnessPhase,
} from "../../src/application/recovery/resume-lifecycle.js";
import type { RunStatus } from "../../src/contracts/state/workflow-state.js";
import type { RunId } from "../../src/domain/primitives/ids.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";
import type { RepositoryFixture } from "../fixtures/temp-repository.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const RUN_ID = "run-001" as RunId;
const RUN_DIRECTORY = `.pi/runs/${RUN_ID}`;

function workflowState(
  status: RunStatus,
  finalized: boolean,
  failure: WorkflowState["run"]["failure"] = null,
): WorkflowState {
  const stateRevision = 1;
  const header = { schema_version: 1, run_id: RUN_ID, state_revision: stateRevision } as const;
  return {
    run: {
      schema_version: 1,
      run_id: RUN_ID,
      request: { id: "request-001", type: "feature" },
      status,
      finalized,
      state_revision: stateRevision,
      graph_revision: 1,
      playbook: { initial: {}, current: {} },
      current_step: {},
      current_plan: null,
      current_changes: { relevant_change_sets: [], external_reconciliation: null },
      repository: { freshness: "unknown" },
      blocked: status === "blocked" ? { reason: "waiting" } : null,
      failure,
      cancellation: null,
      limits: { max_retries: 4 },
      counters: { retries: 2 },
      telemetry: { degraded: false },
      outcome: null,
      timestamps: {},
    },
    snapshot: {
      requirement: {
        ...header,
        revision: 1,
        goal: "resume",
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
        created_at: "2026-08-30T03:02:10.123+09:00",
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

function fixtureFor(state: WorkflowState): RepositoryFixture {
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

async function resumePersistedRun(
  initial: WorkflowState,
  recheck: ResumeFreshnessPhase,
): Promise<WorkflowState> {
  return withTempRepository(fixtureFor(initial), async (repositoryRoot) => {
    const reader = new FileRunReader(repositoryRoot);
    const lifecycle = new ResumeLifecycle({
      runReader: reader,
      stateStore: new FileStateStore(repositoryRoot),
      recheckRepositoryAndFreshness: recheck,
    });

    await lifecycle.resume(RUN_ID);
    return reader.load(RUN_ID);
  });
}

describe("ResumeLifecycle E2E", () => {
  it.each([
    ["blocked", workflowState("blocked", false)],
    ["resumable failed", workflowState("failed", false, { resumable: true })],
  ] as const)("resumes %s with budgets unchanged", async (_name, initial) => {
    let checks = 0;
    const state = await resumePersistedRun(initial, (current) => {
      checks += 1;
      return {
        ...current,
        run: { ...current.run, repository: { freshness: "fresh" } },
      };
    });

    expect(checks).toBe(1);
    expect(state.run).toMatchObject({
      status: "running",
      finalized: false,
      blocked: null,
      limits: { max_retries: 4 },
      counters: { retries: 2 },
      repository: { freshness: "fresh" },
    });
    expect(state.run.failure).toEqual(initial.run.failure);
    expect(state.run.state_revision).toBe(2);
  });

  it.each([
    ["completed", workflowState("completed", true)],
    ["cancelled", workflowState("cancelled", true)],
    ["final failed", workflowState("failed", true, { resumable: false })],
  ] as const)("does not resume %s", async (_name, initial) => {
    let checks = 0;
    await expect(
      resumePersistedRun(initial, (current) => {
        checks += 1;
        return current;
      }),
    ).rejects.toMatchObject({ code: "RUN_NOT_RESUMABLE" });

    expect(checks).toBe(0);
  });

  it("does not commit when the repository/freshness re-check fails", async () => {
    const initial = workflowState("blocked", false);

    await expect(
      resumePersistedRun(initial, async () => {
        throw new Error("repository is stale");
      }),
    ).rejects.toThrow("repository is stale");
  });
});
