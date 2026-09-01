import { request, type IncomingHttpHeaders, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import type { RunId } from "../../src/domain/primitives/ids.js";
import {
  defaultMonitorIndexPath,
  RunIndexer,
} from "../../src/monitor/indexer/sqlite-run-indexer.js";
import { startMonitorServer } from "../../src/monitor/backend/read-only-api.js";
import { withTempRepository, type RepositoryFixture } from "../fixtures/temp-repository.js";

const TIMESTAMP = "2026-08-30T03:02:10.123+09:00";
const RUN_IDS = ["run-001", "run-002", "run-003", "run-004", "run-005", "run-006"] as const;

type LifecycleFixture = Readonly<{
  status: "running" | "blocked" | "failed" | "completed" | "cancelled";
  finalized: boolean;
  resumable?: boolean;
}>;

type TextResponse = Readonly<{
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}>;

function runYaml(runId: RunId, fixture: LifecycleFixture): Record<string, unknown> {
  const failure =
    fixture.status === "failed"
      ? { resumable: fixture.resumable ?? false, reason: `${runId} failure` }
      : null;
  const outcome = fixture.finalized
    ? {
        status: fixture.status,
        request_satisfied: fixture.status === "completed",
        summary: `${runId} outcome`,
      }
    : null;

  return {
    schema_version: 1,
    run_id: runId,
    request: { id: `${runId}-request`, type: "feature" },
    status: fixture.status,
    finalized: fixture.finalized,
    state_revision: 1,
    graph_revision: 1,
    playbook: { initial: { version: 1 }, current: { version: 2 } },
    current_step: { id: "step-001" },
    current_plan: { applicability: { status: "current" } },
    current_changes: { relevant_change_sets: [], external_reconciliation: null },
    repository: { baseline_head: "baseline-001", drift: null },
    blocked: fixture.status === "blocked" ? { reason: "approval required" } : null,
    failure,
    cancellation: fixture.status === "cancelled" ? { reason: "user requested" } : null,
    limits: {},
    counters: {},
    telemetry: { degraded: false, level: "standard" },
    outcome,
    timestamps: {
      created_at: TIMESTAMP,
      started_at: TIMESTAMP,
      updated_at: TIMESTAMP,
      ...(fixture.finalized ? { finalized_at: TIMESTAMP } : {}),
    },
  };
}

function snapshots(runId: RunId): RepositoryFixture {
  const root = `.pi/runs/${runId}`;
  const header = { schema_version: 1, run_id: runId, state_revision: 1 };
  return {
    [`${root}/state/snapshots/1/requirement.yaml`]: stringify({
      ...header,
      revision: 3,
      goal: "Monitor a Run",
      scope: { in: ["monitoring"], out: [] },
      constraints: ["read-only"],
      acceptance_criteria: ["show status"],
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
          objective: "Expose monitoring",
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
      uncertainties: [{ id: "U-001", status: "open", category: "design" }],
    }),
    [`${root}/state/snapshots/1/decisions.yaml`]: stringify({
      ...header,
      decisions: [{ id: "D-001", class: "D1", status: "pending" }],
    }),
    [`${root}/state/snapshots/1/gates.yaml`]: stringify({
      ...header,
      gates: [{ id: "G-001", type: "completion", status: "passed" }],
    }),
    [`${root}/state/snapshots/1/findings.yaml`]: stringify({
      ...header,
      findings: [
        {
          id: "F-001",
          state: "open",
          disposition: "pending",
          severity: "high",
          confidence: "high",
        },
      ],
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

function event(runId: RunId, sequence: number, type: string, data: Record<string, unknown>) {
  return {
    schema_version: 1,
    event_id: `evt-${String(sequence).padStart(6, "0")}`,
    sequence,
    type,
    timestamp: TIMESTAMP,
    run_id: runId,
    source: { component: "e2e" },
    state_revision: 1,
    ...(type.startsWith("tool.") || type.startsWith("error.")
      ? { correlation_id: "exec-001" }
      : {}),
    data,
  };
}

function runFiles(runId: RunId, fixture: LifecycleFixture): RepositoryFixture {
  const root = `.pi/runs/${runId}`;
  const events = [
    event(runId, 1, "run.created", {}),
    event(runId, 2, "execution.started", {
      execution_id: "exec-001",
      step_id: "step-001",
      agent: "worker",
      attempt: 1,
    }),
    event(runId, 3, "tool.started", {
      execution_id: "exec-001",
      tool: "git status",
    }),
    event(runId, 4, "tool.completed", {
      execution_id: "exec-001",
      tool: "git status",
    }),
    event(runId, 5, "error.occurred", {
      execution_id: "exec-001",
      reason: "transient provider error",
    }),
    event(runId, 6, "error.recovered", {
      execution_id: "exec-001",
      reason: "retry succeeded",
    }),
    event(runId, 7, "execution.completed", {
      execution_id: "exec-001",
      step_id: "step-001",
      agent: "worker",
      attempt: 1,
      status: "completed",
    }),
  ];

  return {
    [`${root}/run.yaml`]: stringify(runYaml(runId, fixture)),
    ...snapshots(runId),
    [`${root}/events/events.jsonl`]: `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  };
}

async function getText(port: number, path: string): Promise<TextResponse> {
  return new Promise((resolveResponse, reject) => {
    const req = request({ host: "127.0.0.1", method: "GET", path, port }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () =>
        resolveResponse({ status: response.statusCode ?? 0, headers: response.headers, body }),
      );
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

describe("monitoring Run overview and timeline", () => {
  it("renders lifecycle variants, correctness-first overview, and ordered timeline", async () => {
    const lifecycleFixtures: readonly LifecycleFixture[] = [
      { status: "running", finalized: false },
      { status: "blocked", finalized: false },
      { status: "failed", finalized: false, resumable: true },
      { status: "failed", finalized: true, resumable: false },
      { status: "completed", finalized: true },
      { status: "cancelled", finalized: true },
    ];
    const fixtures: RepositoryFixture = Object.assign(
      {},
      ...RUN_IDS.map((runId, index) => runFiles(runId as RunId, lifecycleFixtures[index]!)),
    );

    await withTempRepository(fixtures, async (repositoryRoot) => {
      const indexer = new RunIndexer(repositoryRoot);
      await indexer.index();
      indexer.close();

      const database = new DatabaseSync(defaultMonitorIndexPath(repositoryRoot));
      database
        .prepare(
          "INSERT INTO evaluations (run_id, state_revision, last_event_sequence, evaluator_version, evaluation_json) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          "run-005",
          1,
          7,
          1,
          JSON.stringify({
            correctness: {
              outcome: { request_satisfied: true },
              verification: { result: "passed", limitations: ["fixture limitation"] },
              review: { result: "clean" },
            },
            efficiency: {
              telemetry: { tokens: 42 },
              orchestration: { steps: 1 },
            },
            metrics: { telemetry: { tokens: 42 } },
          }),
        );
      database.close();

      const server = await startMonitorServer(repositoryRoot);
      try {
        const port = serverPort(server);
        const list = await getText(port, "/");
        expect(list.status).toBe(200);
        expect(list.headers["content-type"]).toMatch(/text\/html/);
        for (const [kind, label] of [
          ["running", "Running"],
          ["blocked", "Blocked"],
          ["recoverable-failed", "Recoverable Failed"],
          ["final-failed", "Final Failed"],
          ["completed", "Completed"],
          ["cancelled", "Cancelled"],
        ] as const) {
          expect(list.body).toContain(`lifecycle-${kind}`);
          expect(list.body).toContain(label);
        }
        expect(list.body).toContain("Current Step");
        expect(list.body).toContain("Telemetry health");

        const failedOnly = await getText(port, "/?status=failed");
        expect(failedOnly.body).toContain("run-003");
        expect(failedOnly.body).toContain("run-004");
        expect(failedOnly.body).not.toContain("run-001-request");

        const completed = await getText(port, "/?run=run-005");
        expect(completed.status).toBe(200);
        const correctnessPosition = completed.body.indexOf('data-section="correctness"');
        const efficiencyPosition = completed.body.indexOf('data-section="efficiency"');
        expect(correctnessPosition).toBeGreaterThan(-1);
        expect(efficiencyPosition).toBeGreaterThan(correctnessPosition);
        expect(completed.body).toContain("request_satisfied");
        expect(completed.body).toContain("Final Verification");
        expect(completed.body).toContain("Final Review");
        expect(completed.body).toContain("Accepted risks / limitations");
        expect(completed.body).toContain("Current Plan/applicability");
        expect(completed.body).toContain("Open Decisions/Uncertainties");

        const recoverable = await getText(port, "/?run=run-003");
        expect(recoverable.body).toContain("Recovery available: this Run can be resumed.");
        expect(recoverable.body).toContain("run-003 failure");

        const timeline = await getText(port, "/?run=run-005");
        const sequencePositions = [1, 2, 3, 4, 5, 6, 7].map((sequence) =>
          timeline.body.indexOf(`data-sequence="#${sequence}"`),
        );
        expect(sequencePositions.every((position) => position >= 0)).toBe(true);
        expect(sequencePositions).toEqual(
          [...sequencePositions].sort((left, right) => left - right),
        );
        expect(timeline.body).toContain("Worker · exec-001");
        expect(timeline.body).toContain("Error occurred");
        expect(timeline.body).toContain("Error recovered");
        expect(timeline.body).toContain("Raw event details");
        expect(timeline.body).toContain("evt-000003");
        expect(timeline.body).toContain("Tool detail is collapsed by default");
        expect(timeline.body).toMatch(/<details class="timeline-tool" data-sequence="#3">/);
        expect(timeline.body).not.toMatch(/<details class="timeline-tool"[^>]*\bopen\b/);
      } finally {
        await closeServer(server);
      }
    });
  });
});
