import { deepStrictEqual } from "node:assert/strict";
import { readFile as nodeReadFile, rename as nodeRename } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import {
  FileStateStore,
  RequirementRevisionConflictError,
  StateRevisionConflictError,
} from "../../src/adapters/persistence/write/file-state-store.js";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import type { RunId } from "../../src/domain/primitives/ids.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";
import { withTempRepository, type RepositoryFixture } from "../fixtures/temp-repository.js";

const RUN_ID = "run-001" as RunId;
const RUN_DIRECTORY = `.pi/runs/${RUN_ID}`;

function workflowState(
  stateRevision: number,
  requirementRevision = 1,
  goal = `goal-${stateRevision}`,
): WorkflowState {
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
      current_step: {},
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
        revision: requirementRevision,
        goal,
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
  const snapshotDirectory = `${RUN_DIRECTORY}/state/snapshots/${state.run.state_revision}`;
  const { snapshot } = state;

  return {
    [`${RUN_DIRECTORY}/run.yaml`]: stringify(state.run),
    [`${snapshotDirectory}/requirement.yaml`]: stringify(snapshot.requirement),
    [`${snapshotDirectory}/steps.yaml`]: stringify(snapshot.steps),
    [`${snapshotDirectory}/uncertainties.yaml`]: stringify(snapshot.uncertainties),
    [`${snapshotDirectory}/decisions.yaml`]: stringify(snapshot.decisions),
    [`${snapshotDirectory}/gates.yaml`]: stringify(snapshot.gates),
    [`${snapshotDirectory}/findings.yaml`]: stringify(snapshot.findings),
    [`${snapshotDirectory}/manifest.json`]: JSON.stringify(snapshot.manifest),
  };
}

describe("FileStateStore", () => {
  it("validates and finalizes the snapshot before atomically replacing run.yaml", async () => {
    const current = workflowState(1);
    const next = workflowState(2, 2);

    await withTempRepository(fixtureFor(current), async (repositoryRoot) => {
      const renameTargets: string[] = [];
      const store = new FileStateStore(repositoryRoot, {
        rename: async (source, destination) => {
          renameTargets.push(destination);
          await nodeRename(source, destination);
        },
      });

      const committed = await store.commit({ expectedRevision: 1, next });

      deepStrictEqual(committed, next);
      expect(renameTargets).toEqual([
        join(repositoryRoot, RUN_DIRECTORY, "state", "snapshots", "2"),
        join(repositoryRoot, RUN_DIRECTORY, "run.yaml"),
      ]);
      await expect(new FileRunReader(repositoryRoot).load(RUN_ID)).resolves.toMatchObject({
        run: { state_revision: 2 },
        snapshot: { requirement: { goal: "goal-2" } },
      });
    });
  });

  it("persists immutable requirement revisions without rewriting the initial request", async () => {
    const current = workflowState(1);
    const next = workflowState(2, 2, "api_key: amended-secret");
    const requestPath = `${RUN_DIRECTORY}/request.md`;

    await withTempRepository(
      { ...fixtureFor(current), [requestPath]: "the initial request\n" },
      async (repositoryRoot) => {
        const store = new FileStateStore(repositoryRoot);
        const committed = await store.commit({ expectedRevision: 1, next });
        const requirementsDirectory = join(repositoryRoot, RUN_DIRECTORY, "requirements");
        const initialHistoryPath = join(requirementsDirectory, "requirement-v1.yaml");
        const amendedHistoryPath = join(requirementsDirectory, "requirement-v2.yaml");

        expect(committed.snapshot.requirement.revision).toBe(2);
        await expect(nodeReadFile(join(repositoryRoot, requestPath), "utf8")).resolves.toBe(
          "the initial request\n",
        );
        await expect(nodeReadFile(initialHistoryPath, "utf8")).resolves.not.toContain(
          "state_revision",
        );
        const amendedHistoryDocument = parseYaml(await nodeReadFile(amendedHistoryPath, "utf8"));
        expect(amendedHistoryDocument).toMatchObject({
          revision: 2,
          goal: "api_key: [REDACTED_SECRET]",
        });
        await expect(
          nodeReadFile(
            join(repositoryRoot, RUN_DIRECTORY, "state", "snapshots", "2", "requirement.yaml"),
            "utf8",
          ),
        ).resolves.not.toContain("amended-secret");

        const amendedHistory = await nodeReadFile(amendedHistoryPath, "utf8");
        const changed = workflowState(3, 2, "changed requirement");
        await expect(store.commit({ expectedRevision: 2, next: changed })).rejects.toBeInstanceOf(
          RequirementRevisionConflictError,
        );
        await expect(nodeReadFile(amendedHistoryPath, "utf8")).resolves.toBe(amendedHistory);
        await expect(store.load(RUN_ID)).resolves.toMatchObject({ run: { state_revision: 2 } });
      },
    );
  });

  it("rejects a requirement history entry that disagrees with its revision", async () => {
    const current = workflowState(1);
    const conflictingHistory = stringify({
      revision: 2,
      goal: "wrong revision",
      scope: { in: [], out: [] },
      constraints: [],
      acceptance_criteria: [],
      non_goals: [],
      supplied_evidence: [],
      assumptions: [],
      open_questions: [],
    });

    await withTempRepository(
      {
        ...fixtureFor(current),
        [`${RUN_DIRECTORY}/requirements/requirement-v1.yaml`]: conflictingHistory,
      },
      async (repositoryRoot) => {
        const store = new FileStateStore(repositoryRoot);

        await expect(
          store.commit({ expectedRevision: 1, next: workflowState(2) }),
        ).rejects.toBeInstanceOf(RequirementRevisionConflictError);
      },
    );
  });

  it("rejects an expected revision mismatch before writing anything", async () => {
    const current = workflowState(1);
    const next = workflowState(2);
    let renameCalled = false;

    await withTempRepository(fixtureFor(current), async (repositoryRoot) => {
      const store = new FileStateStore(repositoryRoot, {
        rename: async (source, destination) => {
          renameCalled = true;
          await nodeRename(source, destination);
        },
      });

      await expect(store.commit({ expectedRevision: 0, next })).rejects.toBeInstanceOf(
        StateRevisionConflictError,
      );
      expect(renameCalled).toBe(false);
      await expect(new FileRunReader(repositoryRoot).load(RUN_ID)).resolves.toMatchObject({
        run: { state_revision: 1 },
      });
    });
  });

  it("leaves the old state current when the pointer replacement fails", async () => {
    const current = workflowState(1);
    const next = workflowState(2, 2);

    await withTempRepository(fixtureFor(current), async (repositoryRoot) => {
      const runPath = join(repositoryRoot, RUN_DIRECTORY, "run.yaml");
      const store = new FileStateStore(repositoryRoot, {
        rename: async (source, destination) => {
          if (destination === runPath) {
            throw new Error("simulated crash before pointer replacement");
          }
          await nodeRename(source, destination);
        },
      });

      await expect(store.commit({ expectedRevision: 1, next })).rejects.toThrow(
        "simulated crash before pointer replacement",
      );
      await expect(new FileRunReader(repositoryRoot).load(RUN_ID)).resolves.toMatchObject({
        run: { state_revision: 1 },
        snapshot: { requirement: { goal: "goal-1" } },
      });
    });
  });

  it("does not replace the pointer when read-back validation fails", async () => {
    const current = workflowState(1);
    const next = workflowState(2, 2);
    let renameCalled = false;

    await withTempRepository(fixtureFor(current), async (repositoryRoot) => {
      const store = new FileStateStore(repositoryRoot, {
        readFile: async (path) => {
          const contents = await nodeReadFile(path, "utf8");
          if (path.includes(".2.tmp-") && path.endsWith("gates.yaml")) {
            return contents.replace("schema_version: 1", "schema_version: 2");
          }
          return contents;
        },
        rename: async (source, destination) => {
          renameCalled = true;
          await nodeRename(source, destination);
        },
      });

      await expect(store.commit({ expectedRevision: 1, next })).rejects.toThrow(/schema version 1/);
      expect(renameCalled).toBe(false);
      await expect(new FileRunReader(repositoryRoot).load(RUN_ID)).resolves.toMatchObject({
        run: { state_revision: 1 },
      });
    });
  });
});
