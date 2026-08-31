import { readFile as nodeReadFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import type { RunId } from "../../src/domain/primitives/ids.js";
import { withTempRepository, type RepositoryFixture } from "../fixtures/temp-repository.js";

const RUN_ID = "run-001" as RunId;
const RUN_DIRECTORY = `.pi/runs/${RUN_ID}`;

function runYaml(stateRevision: number) {
  return {
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
  };
}

function snapshotFiles(stateRevision: number): RepositoryFixture {
  const header = { schema_version: 1, run_id: RUN_ID, state_revision: stateRevision };

  return {
    [`${RUN_DIRECTORY}/state/snapshots/${stateRevision}/requirement.yaml`]: stringify({
      ...header,
      revision: 1,
      goal: `goal-${stateRevision}`,
      scope: { in: [], out: [] },
      constraints: [],
      acceptance_criteria: [],
      non_goals: [],
      supplied_evidence: [],
      assumptions: [],
      open_questions: [],
    }),
    [`${RUN_DIRECTORY}/state/snapshots/${stateRevision}/steps.yaml`]: stringify({
      ...header,
      graph_revision: 1,
      steps: [],
    }),
    [`${RUN_DIRECTORY}/state/snapshots/${stateRevision}/uncertainties.yaml`]: stringify({
      ...header,
      uncertainties: [],
    }),
    [`${RUN_DIRECTORY}/state/snapshots/${stateRevision}/decisions.yaml`]: stringify({
      ...header,
      decisions: [],
    }),
    [`${RUN_DIRECTORY}/state/snapshots/${stateRevision}/gates.yaml`]: stringify({
      ...header,
      gates: [],
    }),
    [`${RUN_DIRECTORY}/state/snapshots/${stateRevision}/findings.yaml`]: stringify({
      ...header,
      findings: [],
    }),
    [`${RUN_DIRECTORY}/state/snapshots/${stateRevision}/manifest.json`]: JSON.stringify({
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
    }),
  };
}

function runFile(stateRevision: number): RepositoryFixture {
  return { [`${RUN_DIRECTORY}/run.yaml`]: stringify(runYaml(stateRevision)) };
}

describe("FileRunReader", () => {
  it("loads run.yaml and exactly the snapshot selected by state_revision", async () => {
    await withTempRepository(
      {
        ...runFile(2),
        ...snapshotFiles(1),
        ...snapshotFiles(2),
      },
      async (repositoryRoot) => {
        const state = await new FileRunReader(repositoryRoot).load(RUN_ID);

        expect(state.run.state_revision).toBe(2);
        expect(state.snapshot.requirement.goal).toBe("goal-2");
        expect(state.snapshot.steps.state_revision).toBe(2);
        expect(state.snapshot.manifest.state_revision).toBe(2);
      },
    );
  });

  it("does not fall back to an older snapshot when the current snapshot is missing", async () => {
    await withTempRepository(
      {
        ...runFile(2),
        ...snapshotFiles(1),
      },
      async (repositoryRoot) => {
        await expect(new FileRunReader(repositoryRoot).load(RUN_ID)).rejects.toThrow(
          /state[/\\]snapshots[/\\]2/,
        );
      },
    );
  });

  it("does not fall back to an older snapshot when the current snapshot is corrupt", async () => {
    const files = {
      ...runFile(2),
      ...snapshotFiles(1),
      ...snapshotFiles(2),
    };
    files[`${RUN_DIRECTORY}/state/snapshots/2/requirement.yaml`] = "schema_version: [";

    await withTempRepository(files, async (repositoryRoot) => {
      await expect(new FileRunReader(repositoryRoot).load(RUN_ID)).rejects.toThrow();
    });
  });

  it("rejects a snapshot whose header does not match the current pointer", async () => {
    const files = {
      ...runFile(2),
      ...snapshotFiles(2),
    };
    files[`${RUN_DIRECTORY}/state/snapshots/2/steps.yaml`] = stringify({
      schema_version: 1,
      run_id: RUN_ID,
      state_revision: 1,
      graph_revision: 1,
      steps: [],
    });

    await withTempRepository(files, async (repositoryRoot) => {
      await expect(new FileRunReader(repositoryRoot).load(RUN_ID)).rejects.toThrow(
        /steps\.state_revision.*state revision 2/,
      );
    });
  });

  it("rejects a future schema in the referenced snapshot", async () => {
    const files = {
      ...runFile(1),
      ...snapshotFiles(1),
    };
    files[`${RUN_DIRECTORY}/state/snapshots/1/steps.yaml`] = stringify({
      ...runYaml(1),
      schema_version: 2,
      steps: [],
    });

    await withTempRepository(files, async (repositoryRoot) => {
      await expect(new FileRunReader(repositoryRoot).load(RUN_ID)).rejects.toThrow(
        /schema version 1/,
      );
    });
  });

  it("retries when run.yaml changes its pointer during the read", async () => {
    await withTempRepository(
      {
        ...runFile(2),
        ...snapshotFiles(1),
        ...snapshotFiles(2),
      },
      async (repositoryRoot) => {
        let runReads = 0;
        const runPathSuffix = join(".pi", "runs", RUN_ID, "run.yaml");
        const reader = new FileRunReader(repositoryRoot, {
          readFile: async (path) => {
            const contents = await nodeReadFile(path, "utf8");
            if (path.endsWith(runPathSuffix) && runReads++ === 0) {
              return stringify(runYaml(1));
            }
            return contents;
          },
        });

        const state = await reader.load(RUN_ID);

        expect(state.run.state_revision).toBe(2);
        expect(state.snapshot.requirement.goal).toBe("goal-2");
        expect(runReads).toBe(4);
      },
    );
  });
});
