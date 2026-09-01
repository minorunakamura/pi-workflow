import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { RunDiscovery } from "../../src/monitor/indexer/run-discovery.js";
import {
  defaultMonitorIndexPath,
  RunIndexer,
} from "../../src/monitor/indexer/sqlite-run-indexer.js";
import type { RunId } from "../../src/domain/primitives/ids.js";
import { withTempRepository, type RepositoryFixture } from "../fixtures/temp-repository.js";

const RUN_ID = "run-001" as RunId;
const RUN_DIRECTORY = `.pi/runs/${RUN_ID}`;
const TIMESTAMP = "2026-08-30T03:02:10.123+09:00";

function runYaml(stateRevision: number, runId: RunId = RUN_ID): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: runId,
    request: { id: "request-001", type: "feature" },
    status: "running",
    finalized: false,
    state_revision: stateRevision,
    graph_revision: 1,
    playbook: { initial: { version: 1 }, current: { version: 1 } },
    current_step: { id: "step-001" },
    current_plan: null,
    current_changes: { relevant_change_sets: [], external_reconciliation: null },
    repository: { baseline_head: "abc123" },
    blocked: null,
    failure: null,
    cancellation: null,
    limits: {},
    counters: {},
    telemetry: { degraded: false, level: "standard" },
    outcome: null,
    timestamps: {
      created_at: TIMESTAMP,
      started_at: TIMESTAMP,
      updated_at: TIMESTAMP,
    },
  };
}

function snapshotFiles(stateRevision: number): RepositoryFixture {
  const header = { schema_version: 1, run_id: RUN_ID, state_revision: stateRevision };
  const step = {
    id: "step-001",
    type: "implementation",
    objective: `objective-${stateRevision}`,
    agent: "worker",
    skills: [],
    inputs: [],
    outputs: [],
    depends_on: [],
    completion_criteria: [],
    status: stateRevision === 1 ? "running" : "completed",
    blocked_by: [],
    result: null,
    mandatory: true,
    origin: "initial",
  };

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
      steps: [step],
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
      created_at: TIMESTAMP,
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

function event(sequence: number, type: "step.started" | "step.completed" = "step.started") {
  return {
    schema_version: 1,
    event_id: `evt-${String(sequence).padStart(6, "0")}`,
    sequence,
    type,
    timestamp: TIMESTAMP,
    run_id: RUN_ID,
    source: { component: "orchestrator" },
    state_revision: sequence > 2 ? 2 : 1,
    data: { step_id: "step-001" },
  };
}

function runFiles(stateRevision = 1): RepositoryFixture {
  return {
    [`${RUN_DIRECTORY}/run.yaml`]: stringify(runYaml(stateRevision)),
    ...snapshotFiles(stateRevision),
    [`${RUN_DIRECTORY}/events/events.jsonl`]: `${JSON.stringify(event(1))}\n`,
  };
}

describe("Run discovery and SQLite index", () => {
  it("keeps valid, degraded, and unreadable Run candidates visible", async () => {
    await withTempRepository(
      {
        ...runFiles(),
        ".pi/runs/run-002/run.yaml": stringify(runYaml(1, "run-999" as RunId)),
        ".pi/runs/run-003/run.yaml": "schema_version: [",
      },
      async (repositoryRoot) => {
        await mkdir(join(repositoryRoot, ".pi/runs/run-004"), { recursive: true });
        await mkdir(join(repositoryRoot, ".pi/runs/no-run"), { recursive: true });
        const read = async (path: string): Promise<string> => {
          if (path.endsWith(join(".pi", "runs", "run-004", "run.yaml"))) {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          }
          return readFile(path, "utf8");
        };

        const candidates = await new RunDiscovery(repositoryRoot, { readFile: read }).scan();

        expect(candidates.map(({ runId, state }) => ({ runId, state }))).toEqual([
          { runId: "run-001", state: "valid" },
          { runId: "run-002", state: "degraded" },
          { runId: "run-003", state: "degraded" },
          { runId: "run-004", state: "unreadable" },
        ]);

        const indexer = new RunIndexer(repositoryRoot, { readFile: read });
        await indexer.index();
        indexer.close();
        const database = new DatabaseSync(defaultMonitorIndexPath(repositoryRoot));
        expect(
          database.prepare("SELECT run_id, index_status FROM runs ORDER BY run_id").all(),
        ).toEqual([
          { run_id: "run-001", index_status: "valid" },
          { run_id: "run-002", index_status: "degraded" },
          { run_id: "run-003", index_status: "degraded" },
          { run_id: "run-004", index_status: "unreadable" },
        ]);
        database.close();
      },
    );
  });

  it("rebuilds the derived SQLite index without changing Run files", async () => {
    await withTempRepository(runFiles(), async (repositoryRoot) => {
      const indexer = new RunIndexer(repositoryRoot);
      await indexer.index();
      indexer.close();

      const runPath = join(repositoryRoot, RUN_DIRECTORY, "run.yaml");
      const runBeforeRebuild = await readFile(runPath, "utf8");
      const indexPath = defaultMonitorIndexPath(repositoryRoot);
      const first = new DatabaseSync(indexPath);
      expect(first.prepare("SELECT run_id, state_revision FROM runs").all()).toEqual([
        { run_id: "run-001", state_revision: 1 },
      ]);
      expect(first.prepare("SELECT step_id FROM steps").all()).toEqual([{ step_id: "step-001" }]);
      expect(first.prepare("SELECT sequence FROM events").all()).toEqual([{ sequence: 1 }]);
      expect(
        first.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      ).toEqual([
        { name: "artifacts" },
        { name: "evaluations" },
        { name: "events" },
        { name: "executions" },
        { name: "findings" },
        { name: "runs" },
        { name: "steps" },
      ]);
      first.close();

      await rm(indexPath);
      const rebuilt = new RunIndexer(repositoryRoot);
      await rebuilt.index();
      rebuilt.close();

      const second = new DatabaseSync(indexPath);
      expect(second.prepare("SELECT run_id, state_revision FROM runs").all()).toEqual([
        { run_id: "run-001", state_revision: 1 },
      ]);
      expect(second.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 1 });
      second.close();
      await expect(readFile(runPath, "utf8")).resolves.toBe(runBeforeRebuild);
    });
  });

  it("tails new events and reparses snapshots only after state_revision changes", async () => {
    await withTempRepository(runFiles(), async (repositoryRoot) => {
      let snapshotReads = 0;
      const read = async (path: string): Promise<string> => {
        if (path.includes(join("state", "snapshots"))) {
          snapshotReads += 1;
        }
        return readFile(path, "utf8");
      };
      const indexer = new RunIndexer(repositoryRoot, { readFile: read });

      await indexer.index();
      const initialSnapshotReads = snapshotReads;
      expect(initialSnapshotReads).toBe(7);

      await appendFile(
        join(repositoryRoot, RUN_DIRECTORY, "events", "events.jsonl"),
        `${JSON.stringify(event(2, "step.completed"))}\n`,
        "utf8",
      );
      await indexer.index();
      expect(snapshotReads).toBe(initialSnapshotReads);

      const indexPath = defaultMonitorIndexPath(repositoryRoot);
      const incremental = new DatabaseSync(indexPath);
      expect(incremental.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({
        count: 2,
      });
      expect(incremental.prepare("SELECT last_indexed_event_sequence FROM runs").get()).toEqual({
        last_indexed_event_sequence: 2,
      });
      incremental.close();

      const revisionTwo = {
        [`${RUN_DIRECTORY}/run.yaml`]: stringify(runYaml(2)),
        ...snapshotFiles(2),
      };
      for (const [path, contents] of Object.entries(revisionTwo)) {
        const absolutePath = join(repositoryRoot, path);
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, contents, "utf8");
      }
      await appendFile(
        join(repositoryRoot, RUN_DIRECTORY, "events", "events.jsonl"),
        `${JSON.stringify(event(3, "step.completed"))}\n`,
        "utf8",
      );

      await indexer.index();
      expect(snapshotReads).toBeGreaterThan(initialSnapshotReads);

      const final = new DatabaseSync(indexPath);
      expect(
        final
          .prepare(
            "SELECT state_revision, last_indexed_state_revision, last_indexed_event_sequence FROM runs",
          )
          .get(),
      ).toEqual({
        state_revision: 2,
        last_indexed_state_revision: 2,
        last_indexed_event_sequence: 3,
      });
      expect(final.prepare("SELECT objective, status FROM steps").get()).toEqual({
        objective: "objective-2",
        status: "completed",
      });
      final.close();
      indexer.close();
    });
  });
});
