import { request, type IncomingHttpHeaders, type Server } from "node:http";
import { symlink } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import {
  defaultMonitorIndexPath,
  RunIndexer,
} from "../../src/monitor/indexer/sqlite-run-indexer.js";
import { startMonitorServer } from "../../src/monitor/backend/read-only-api.js";
import type { RunId } from "../../src/domain/primitives/ids.js";
import { withTempRepository, type RepositoryFixture } from "../fixtures/temp-repository.js";

const TIMESTAMP = "2026-08-30T03:02:10.123+09:00";
const RUN_ONE = "run-001" as RunId;
const RUN_TWO = "run-002" as RunId;
const ARTIFACT_PATH = "analysis/analysis-exec-1.md";
const SYMLINK_PATH = "analysis/link-exec-1.md";

type JsonResponse = Readonly<{
  status: number;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}>;

function runYaml(runId: RunId): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: runId,
    request: { id: "request-001", type: "feature" },
    status: "running",
    finalized: false,
    state_revision: 1,
    graph_revision: 1,
    playbook: { initial: { version: 1 }, current: { version: 1 } },
    current_step: { id: "step-001" },
    current_plan: null,
    current_changes: { relevant_change_sets: [], external_reconciliation: null },
    repository: { baseline_head: "baseline-001" },
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

function snapshotFiles(runId: RunId): RepositoryFixture {
  const root = `.pi/runs/${runId}`;
  const header = { schema_version: 1, run_id: runId, state_revision: 1 };
  return {
    [`${root}/state/snapshots/1/requirement.yaml`]: stringify({
      ...header,
      revision: 1,
      goal: "Expose monitoring data",
      scope: { in: [], out: [] },
      constraints: [],
      acceptance_criteria: [],
      non_goals: [],
      supplied_evidence: [],
      assumptions: [],
      open_questions: [],
    }),
    [`${root}/state/snapshots/1/steps.yaml`]: stringify({
      ...header,
      graph_revision: 1,
      steps: [
        {
          id: "step-001",
          type: "implementation",
          objective: "Implement API",
          agent: "worker",
          skills: [],
          inputs: [],
          outputs: [],
          depends_on: [],
          completion_criteria: [],
          status: "running",
          blocked_by: [],
          result: null,
          mandatory: true,
          origin: "initial",
        },
      ],
    }),
    [`${root}/state/snapshots/1/uncertainties.yaml`]: stringify({
      ...header,
      uncertainties: [],
    }),
    [`${root}/state/snapshots/1/decisions.yaml`]: stringify({ ...header, decisions: [] }),
    [`${root}/state/snapshots/1/gates.yaml`]: stringify({
      ...header,
      gates: [{ id: "G-001", type: "completion", status: "passed" }],
    }),
    [`${root}/state/snapshots/1/findings.yaml`]: stringify({ ...header, findings: [] }),
    [`${root}/state/snapshots/1/manifest.json`]: JSON.stringify({
      ...header,
      previous_state_revision: 0,
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

function artifactContents(runId: RunId): string {
  return `---\n${stringify({
    schema_version: 1,
    run_id: runId,
    step_id: "step-001",
    execution_id: "exec-001",
    execution_state_revision: 1,
    agent: { id: "worker", version: 1 },
    artifact: { type: "analysis", status: "complete" },
    created_at: TIMESTAMP,
    skills: [],
  }).trimEnd()}\n---\nartifact body\n`;
}

function event(
  runId: RunId,
  sequence: number,
  type: "run.created" | "execution.completed" | "artifact.finalized",
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: `evt-${String(sequence).padStart(6, "0")}`,
    sequence,
    type,
    timestamp: TIMESTAMP,
    run_id: runId,
    source: { component: "test" },
    state_revision: 1,
    data,
  };
}

function runFiles(runId: RunId, model: string, includeSymlinkArtifact = false): RepositoryFixture {
  const root = `.pi/runs/${runId}`;
  const events = [
    event(runId, 1, "run.created", {}),
    event(runId, 2, "execution.completed", {
      execution_id: "exec-001",
      step_id: "step-001",
      agent: "worker",
      attempt: 1,
      status: "completed",
      provider: "test",
      model,
      thinking: "standard",
      timing: { wall_clock_ms: 100 },
      tokens: { input_tokens: 10, output_tokens: 5 },
    }),
    event(runId, 3, "artifact.finalized", {
      path: ARTIFACT_PATH,
      type: "analysis",
      status: "complete",
      step_id: "step-001",
      execution_id: "exec-001",
      handoff_summary: "summary",
    }),
  ];
  if (includeSymlinkArtifact) {
    events.push(
      event(runId, 4, "artifact.finalized", {
        path: SYMLINK_PATH,
        type: "analysis",
        status: "complete",
        step_id: "step-001",
        execution_id: "exec-001",
      }),
    );
  }

  return {
    [`${root}/run.yaml`]: stringify(runYaml(runId)),
    ...snapshotFiles(runId),
    [`${root}/events/events.jsonl`]: `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    [`${root}/${ARTIFACT_PATH}`]: artifactContents(runId),
  };
}

async function getJson(
  port: number,
  path: string,
  method: "GET" | "POST" = "GET",
): Promise<JsonResponse> {
  return new Promise((resolveResponse, reject) => {
    const req = request({ host: "127.0.0.1", method, path, port }, (response) => {
      let contents = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        contents += chunk;
      });
      response.on("end", () => {
        try {
          resolveResponse({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: JSON.parse(contents) as Record<string, unknown>,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
  });
}

function serverPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Server is not listening");
  return (address as AddressInfo).port;
}

describe("read-only monitoring API", () => {
  it("serves the required read projections and compare data", async () => {
    await withTempRepository(
      {
        ...runFiles(RUN_ONE, "model-a"),
        ...runFiles(RUN_TWO, "model-b"),
      },
      async (repositoryRoot) => {
        const indexer = new RunIndexer(repositoryRoot);
        await indexer.index();
        indexer.close();

        const database = new DatabaseSync(defaultMonitorIndexPath(repositoryRoot));
        for (const [runId, model, wallClock] of [
          [RUN_ONE, "model-a", 100],
          [RUN_TWO, "model-b", 150],
        ] as const) {
          database
            .prepare(
              "INSERT INTO evaluations (run_id, state_revision, last_event_sequence, evaluator_version, evaluation_json) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
              runId,
              1,
              3,
              1,
              JSON.stringify({
                evaluation_status: "provisional",
                comparison: {
                  workflow_version: 1,
                  model_provider_usage: [{ provider: "test", model }],
                },
                metrics: { telemetry: { wall_clock_ms: wallClock } },
              }),
            );
        }
        database.close();

        const server = await startMonitorServer(repositoryRoot);
        try {
          expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
          const port = serverPort(server);
          const [
            list,
            detail,
            state,
            graph,
            events,
            step,
            execution,
            artifacts,
            artifact,
            evaluation,
            compare,
          ] = await Promise.all([
            getJson(port, "/api/v1/runs"),
            getJson(port, `/api/v1/runs/${RUN_ONE}`),
            getJson(port, `/api/v1/runs/${RUN_ONE}/state`),
            getJson(port, `/api/v1/runs/${RUN_ONE}/graph`),
            getJson(port, `/api/v1/runs/${RUN_ONE}/events?after_sequence=1`),
            getJson(port, `/api/v1/runs/${RUN_ONE}/steps/step-001`),
            getJson(port, `/api/v1/runs/${RUN_ONE}/executions/exec-001`),
            getJson(port, `/api/v1/runs/${RUN_ONE}/artifacts`),
            getJson(
              port,
              `/api/v1/runs/${RUN_ONE}/artifact?path=${encodeURIComponent(ARTIFACT_PATH)}`,
            ),
            getJson(port, `/api/v1/runs/${RUN_ONE}/evaluation`),
            getJson(port, `/api/v1/compare?run=${RUN_ONE}&run=${RUN_TWO}`),
          ]);

          expect(list.status).toBe(200);
          expect(list.body.runs).toHaveLength(2);
          expect(detail.status).toBe(200);
          expect((detail.body.run as Record<string, unknown>).run_id).toBe(RUN_ONE);
          expect((detail.body.state as Record<string, unknown>).run).toBeDefined();
          expect(state.status).toBe(200);
          expect((state.body.run as Record<string, unknown>).run_id).toBe(RUN_ONE);
          expect(graph.status).toBe(200);
          expect(graph.body.nodes).toEqual([
            expect.objectContaining({ id: "step-001", status: "running" }),
          ]);
          expect(graph.body.gates).toEqual([
            expect.objectContaining({ id: "G-001", annotation: true }),
          ]);
          expect(events.status).toBe(200);
          expect(events.body.events).toHaveLength(2);
          expect(step.status).toBe(200);
          expect((step.body.step as Record<string, unknown>).id).toBe("step-001");
          expect(execution.status).toBe(200);
          expect((execution.body.execution as Record<string, unknown>).id).toBe("exec-001");
          expect(artifacts.status).toBe(200);
          expect(artifacts.body.artifacts).toEqual([
            expect.objectContaining({ path: ARTIFACT_PATH }),
          ]);
          expect(artifact.status).toBe(200);
          expect((artifact.body.content as Record<string, unknown>).body).toBe("artifact body\n");
          expect(evaluation.status).toBe(200);
          expect((evaluation.body.evaluation as Record<string, unknown>).metrics).toBeDefined();
          expect(compare.status).toBe(200);
          expect(compare.body.comparability).toEqual(
            expect.objectContaining({ same_request_requirement: true, same_model: false }),
          );
          expect(
            (compare.body.deltas as Record<string, unknown>)["telemetry.wall_clock_ms"],
          ).toEqual(expect.objectContaining({ absolute: 50, percentage: 50 }));
        } finally {
          await closeServer(server);
        }
      },
    );
  });

  it("rejects workflow mutations and unsafe Artifact paths", async () => {
    await withTempRepository(
      {
        ...runFiles(RUN_ONE, "model-a", true),
        "outside.md": artifactContents(RUN_ONE),
      },
      async (repositoryRoot) => {
        const link = join(repositoryRoot, `.pi/runs/${RUN_ONE}/${SYMLINK_PATH}`);
        await symlink(join(repositoryRoot, "outside.md"), link);

        const indexer = new RunIndexer(repositoryRoot);
        await indexer.index();
        indexer.close();

        const server = await startMonitorServer(repositoryRoot);
        try {
          const port = serverPort(server);
          const [mutation, traversal, absolute, symlinkEscape] = await Promise.all([
            getJson(port, `/api/v1/runs/${RUN_ONE}/cancel`, "POST"),
            getJson(
              port,
              `/api/v1/runs/${RUN_ONE}/artifact?path=${encodeURIComponent("../outside.md")}`,
            ),
            getJson(
              port,
              `/api/v1/runs/${RUN_ONE}/artifact?path=${encodeURIComponent("/etc/passwd")}`,
            ),
            getJson(
              port,
              `/api/v1/runs/${RUN_ONE}/artifact?path=${encodeURIComponent(SYMLINK_PATH)}`,
            ),
          ]);

          expect(mutation.status).toBe(405);
          expect((mutation.body.error as Record<string, unknown>).code).toBe("METHOD_NOT_ALLOWED");
          expect(traversal.status).toBe(400);
          expect(absolute.status).toBe(400);
          expect(symlinkEscape.status).toBe(400);
          expect((symlinkEscape.body.error as Record<string, unknown>).code).toBe(
            "INVALID_ARTIFACT_PATH",
          );
        } finally {
          await closeServer(server);
        }
      },
    );
  });
});
