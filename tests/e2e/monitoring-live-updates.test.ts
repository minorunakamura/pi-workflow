import { appendFile, readFile } from "node:fs/promises";
import { request, type ClientRequest, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { startMonitorServer } from "../../src/monitor/backend/read-only-api.js";
import type { RunId } from "../../src/domain/primitives/ids.js";
import { withTempRepository, type RepositoryFixture } from "../fixtures/temp-repository.js";

const TIMESTAMP = "2026-08-30T03:02:10.123+09:00";
const RUN_ID = "run-001" as RunId;
const CORRUPT_RUN_ID = "run-002" as RunId;
const MISSING_ARTIFACT_RUN_ID = "run-003" as RunId;
const INDEX_ERROR_RUN_ID = "run-004" as RunId;

type JsonResponse = Readonly<{
  status: number;
  body: Record<string, unknown>;
}>;

type SseUpdate = Readonly<{
  id: string;
  data: Record<string, unknown>;
}>;

type SseConnection = Readonly<{
  updates: Promise<SseUpdate>;
  close: () => void;
}>;

function runYaml(runId: RunId): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: runId,
    request: { id: `${runId}-request`, type: "feature" },
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
      goal: "Monitor live updates",
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
          objective: "Monitor live updates",
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
    [`${root}/state/snapshots/1/decisions.yaml`]: stringify({
      ...header,
      decisions: [],
    }),
    [`${root}/state/snapshots/1/gates.yaml`]: stringify({
      ...header,
      gates: [],
    }),
    [`${root}/state/snapshots/1/findings.yaml`]: stringify({
      ...header,
      findings: [],
    }),
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

function event(
  runId: RunId,
  sequence: number,
  type = "step.started",
  data: Record<string, unknown> = { step_id: "step-001" },
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

function runFiles(
  runId: RunId,
  events: readonly (Record<string, unknown> | string)[] = [event(runId, 1)],
  includeSnapshots = true,
): RepositoryFixture {
  const root = `.pi/runs/${runId}`;
  return {
    [`${root}/run.yaml`]: stringify(runYaml(runId)),
    ...(includeSnapshots ? snapshotFiles(runId) : {}),
    [`${root}/events/events.jsonl`]: `${events.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n")}\n`,
  };
}

function artifactFinalizedEvent(runId: RunId): Record<string, unknown> {
  return {
    ...event(runId, 1, "artifact.finalized"),
    data: {
      path: "analysis/analysis-exec-1.md",
      type: "analysis",
      status: "complete",
      step_id: "step-001",
      execution_id: "exec-001",
    },
  };
}

async function getJson(port: number, path: string): Promise<JsonResponse> {
  return new Promise((resolveResponse, reject) => {
    const req = request({ host: "127.0.0.1", method: "GET", path, port }, (response) => {
      let contents = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        contents += chunk;
      });
      response.on("end", () => {
        try {
          resolveResponse({
            status: response.statusCode ?? 0,
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

function openSse(port: number, path: string, lastEventId?: string): Promise<SseConnection> {
  return new Promise((resolveConnection, rejectConnection) => {
    let client: ClientRequest | undefined;
    client = request(
      {
        host: "127.0.0.1",
        method: "GET",
        path,
        port,
        headers: {
          accept: "text/event-stream",
          ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
        },
      },
      (response: IncomingMessage) => {
        let buffer = "";
        let resolveUpdate: (update: SseUpdate) => void = () => undefined;
        let rejectUpdate: (error: Error) => void = () => undefined;
        const updates = new Promise<SseUpdate>((resolve, reject) => {
          resolveUpdate = resolve;
          rejectUpdate = reject;
        });
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          const eventStart = buffer.indexOf("event: run-updated\n");
          if (eventStart < 0) return;
          const dataStart = buffer.indexOf("data: ", eventStart);
          const end = buffer.indexOf("\n\n", dataStart);
          if (dataStart < 0 || end < 0) return;
          const blockStart = buffer.lastIndexOf("\n\n", eventStart) + 2;
          const idLine = buffer.slice(blockStart, dataStart).match(/^id: ([^\n]+)/)?.[1];
          if (idLine === undefined) return;
          try {
            resolveUpdate({
              id: idLine,
              data: JSON.parse(buffer.slice(dataStart + 6, end)) as Record<string, unknown>,
            });
          } catch (error) {
            rejectUpdate(error instanceof Error ? error : new Error(String(error)));
          }
        });
        response.on("error", rejectUpdate);
        resolveConnection({
          updates,
          close: () => {
            client?.destroy();
            response.destroy();
          },
        });
      },
    );
    client.on("error", rejectConnection);
    client.end();
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

async function eventually(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("Condition was not reached before timeout");
}

describe("monitoring live updates and degraded handling", () => {
  it("recovers an appended Event through reconciliation and reconnects SSE safely", async () => {
    await withTempRepository(runFiles(RUN_ID), async (repositoryRoot) => {
      const server = await startMonitorServer(repositoryRoot, {
        reconciliationIntervalMs: 10,
        watch: true,
      });
      const eventPath = join(repositoryRoot, `.pi/runs/${RUN_ID}/events/events.jsonl`);
      try {
        const port = serverPort(server);
        const initialEvaluation = await getJson(port, `/api/v1/runs/${RUN_ID}/evaluation`);
        expect(initialEvaluation.body.evaluation).toEqual(
          expect.objectContaining({
            evaluation_status: "provisional",
            source: { state_revision: 1, last_event_sequence: 1, finalized: false },
            telemetry_quality: expect.objectContaining({ status: "insufficient" }),
          }),
        );
        const stream = await openSse(port, `/api/v1/runs/${RUN_ID}/events`);
        await appendFile(
          eventPath,
          `${JSON.stringify(
            event(RUN_ID, 2, "execution.completed", {
              execution_id: "exec-001",
              step_id: "step-001",
              telemetry: {
                telemetry_level: "standard",
                wall_clock_ms: 10,
                active_wall_ms: 10,
                execution_sum_ms: 10,
                input_tokens: 4,
                output_tokens: 2,
                tokens: 6,
                tool_calls: 1,
              },
            }),
          )}\n`,
          "utf8",
        );
        const update = await stream.updates;
        expect(update.data).toEqual(
          expect.objectContaining({
            type: "run-updated",
            run_id: RUN_ID,
            state_revision: 1,
            last_event_sequence: 2,
          }),
        );
        await eventually(async () => {
          const evaluation = await getJson(port, `/api/v1/runs/${RUN_ID}/evaluation`);
          const record = evaluation.body.evaluation as Record<string, unknown>;
          return (
            evaluation.status === 200 &&
            (record.telemetry_quality as Record<string, unknown>)?.status === "healthy"
          );
        });
        const evaluation = await getJson(port, `/api/v1/runs/${RUN_ID}/evaluation`);
        expect(evaluation.body.evaluation).toEqual(
          expect.objectContaining({
            evaluation_status: "provisional",
            source: { state_revision: 1, last_event_sequence: 2, finalized: false },
            metrics: expect.objectContaining({
              telemetry: expect.objectContaining({ wall_clock_ms: 10, tool_calls: 1 }),
            }),
          }),
        );
        stream.close();

        const reconnected = await openSse(port, `/api/v1/runs/${RUN_ID}/events`, update.id);
        await expect(reconnected.updates).resolves.toEqual(
          expect.objectContaining({
            data: expect.objectContaining({ run_id: RUN_ID, last_event_sequence: 2 }),
          }),
        );
        reconnected.close();
      } finally {
        await closeServer(server);
      }
    });
  });

  it("surfaces corrupt Events, missing Artifacts, and index errors without changing run.yaml", async () => {
    await withTempRepository(
      {
        ...runFiles(CORRUPT_RUN_ID, [event(CORRUPT_RUN_ID, 1), "not-json"]),
        ...runFiles(MISSING_ARTIFACT_RUN_ID, [artifactFinalizedEvent(MISSING_ARTIFACT_RUN_ID)]),
        ...runFiles(INDEX_ERROR_RUN_ID, [event(INDEX_ERROR_RUN_ID, 1)], false),
      },
      async (repositoryRoot) => {
        const runPaths = [CORRUPT_RUN_ID, MISSING_ARTIFACT_RUN_ID, INDEX_ERROR_RUN_ID].map(
          (runId) => join(repositoryRoot, `.pi/runs/${runId}/run.yaml`),
        );
        const before = await Promise.all(runPaths.map((path) => readFile(path, "utf8")));
        const server = await startMonitorServer(repositoryRoot, {
          reconciliationIntervalMs: 10,
          watch: false,
        });
        try {
          const port = serverPort(server);
          await eventually(async () => {
            const response = await getJson(port, "/api/v1/runs");
            const runs = response.body.runs as readonly Record<string, unknown>[];
            return runs.length === 3 && runs.every((run) => run.index_status === "degraded");
          });

          const response = await getJson(port, "/api/v1/runs");
          const runs = response.body.runs as readonly Record<string, unknown>[];
          expect(runs).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                run_id: CORRUPT_RUN_ID,
                index_status: "degraded",
                telemetry_quality: "degraded",
                error_message: expect.stringContaining("events: degraded"),
              }),
              expect.objectContaining({
                run_id: MISSING_ARTIFACT_RUN_ID,
                index_status: "degraded",
                error_message: expect.stringContaining("missing Artifact file"),
              }),
              expect.objectContaining({
                run_id: INDEX_ERROR_RUN_ID,
                index_status: "degraded",
                error_message: expect.stringContaining("state:"),
              }),
            ]),
          );
          const detail = await getJson(port, `/api/v1/runs/${MISSING_ARTIFACT_RUN_ID}`);
          expect(detail.body.warnings).toEqual(
            expect.arrayContaining([expect.stringContaining("missing Artifact file")]),
          );
        } finally {
          await closeServer(server);
        }
        await expect(Promise.all(runPaths.map((path) => readFile(path, "utf8")))).resolves.toEqual(
          before,
        );
      },
    );
  });
});
