import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DomainEvent } from "../../contracts/events/event.js";
import type { RunYamlV1 } from "../../contracts/state/workflow-state.js";
import type { RunId } from "../../domain/primitives/ids.js";
import type { WorkflowState } from "../../ports/run-reader.js";
import {
  FileRunReader,
  JsonlEventReader,
  type ReadTextFile,
} from "../../read-model/run-store-readers.js";
import { RunDiscovery, type RunCandidate } from "./run-discovery.js";

export const DEFAULT_MONITOR_INDEX_PATH = [".pi", "monitor", "index.sqlite"] as const;
export const SQLITE_INDEX_SCHEMA_VERSION = 2 as const;

export type RunIndexerOptions = Readonly<{
  databasePath?: string;
  readFile?: ReadTextFile;
  discovery?: RunDiscovery;
}>;

type SqlValue = string | number | null;
type Row = Record<string, unknown>;
type ExistingRun = Row & {
  last_indexed_state_revision?: unknown;
  last_indexed_event_sequence?: unknown;
};

type EventRead = Readonly<{
  events: DomainEvent[];
  degraded: boolean;
}>;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  run_path TEXT NOT NULL,
  request_id TEXT,
  request_type TEXT,
  status TEXT,
  finalized INTEGER,
  resumable INTEGER,
  current_step TEXT,
  initial_playbook TEXT,
  current_playbook TEXT,
  state_revision INTEGER,
  graph_revision INTEGER,
  created_at TEXT,
  started_at TEXT,
  updated_at TEXT,
  finalized_at TEXT,
  request_satisfied INTEGER,
  telemetry_level TEXT,
  telemetry_quality TEXT,
  baseline_head TEXT,
  last_indexed_state_revision INTEGER,
  last_indexed_event_sequence INTEGER NOT NULL DEFAULT 0,
  index_status TEXT NOT NULL,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS steps (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  type TEXT,
  objective TEXT,
  agent TEXT,
  status TEXT,
  mandatory INTEGER,
  origin TEXT,
  depends_on_json TEXT,
  order_index INTEGER,
  current_execution_id TEXT,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (run_id, step_id)
);

CREATE TABLE IF NOT EXISTS executions (
  run_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  step_id TEXT,
  agent TEXT,
  attempt INTEGER,
  status TEXT,
  timing_json TEXT,
  provider TEXT,
  model TEXT,
  thinking TEXT,
  tokens_json TEXT,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (run_id, execution_id)
);

CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  state_revision INTEGER NOT NULL,
  source_json TEXT NOT NULL,
  actor_json TEXT,
  correlation_id TEXT,
  caused_by_json TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence),
  UNIQUE (run_id, event_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  run_id TEXT NOT NULL,
  path TEXT NOT NULL,
  type TEXT,
  subkind TEXT,
  status TEXT,
  step_id TEXT,
  execution_id TEXT,
  domain_id TEXT,
  handoff_summary TEXT,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (run_id, path)
);

CREATE TABLE IF NOT EXISTS findings (
  run_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  state TEXT,
  disposition TEXT,
  severity TEXT,
  confidence TEXT,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (run_id, finding_id)
);

CREATE TABLE IF NOT EXISTS evaluations (
  run_id TEXT PRIMARY KEY,
  state_revision INTEGER NOT NULL,
  last_event_sequence INTEGER NOT NULL,
  evaluator_version INTEGER NOT NULL,
  evaluation_json TEXT NOT NULL
);
`;

const INDEX_TABLES = [
  "evaluations",
  "findings",
  "artifacts",
  "events",
  "executions",
  "steps",
  "runs",
] as const;

function record(value: unknown): Row | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Row)
    : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function booleanValue(value: unknown): number | null {
  return typeof value === "boolean" ? (value ? 1 : 0) : null;
}

function json(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : serialized;
  } catch {
    return null;
  }
}

function scalar(value: unknown): SqlValue {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return json(value);
}

function field(source: Row | undefined, name: string): unknown {
  return source?.[name];
}

function rowString(row: ExistingRun | undefined, name: string): string | null {
  return text(row?.[name]);
}

function rowNumber(row: ExistingRun | undefined, name: string): number | null {
  return numberValue(row?.[name]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runTimestamp(run: RunYamlV1, name: string): string | null {
  return text(run.timestamps[name]);
}

function runRepositoryField(run: RunYamlV1, name: string): string | null {
  return text(run.repository[name]);
}

function runTelemetryField(run: RunYamlV1, name: string): string | null {
  return text(record(run.telemetry)?.[name]);
}

function isCompatibleSchema(database: DatabaseSync): boolean {
  const requiredColumns: Readonly<Record<string, readonly string[]>> = {
    runs: [
      "run_id",
      "resumable",
      "current_step",
      "last_indexed_state_revision",
      "last_indexed_event_sequence",
      "index_status",
    ],
    steps: ["run_id", "step_id", "metadata_json"],
    executions: ["run_id", "execution_id", "metadata_json"],
    events: ["run_id", "sequence", "payload_json"],
    artifacts: ["run_id", "path", "metadata_json"],
    findings: ["run_id", "finding_id", "metadata_json"],
    evaluations: ["run_id", "evaluation_json"],
  };

  try {
    return Object.entries(requiredColumns).every(([table, columns]) => {
      const actual = new Set(
        database
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => text(column.name))
          .filter((name): name is string => name !== null),
      );
      return columns.every((column) => actual.has(column));
    });
  } catch {
    return false;
  }
}

function resetSchema(database: DatabaseSync): void {
  database.exec(INDEX_TABLES.map((table) => `DROP TABLE IF EXISTS ${table}`).join(";"));
  database.exec(SCHEMA_SQL);
  database.exec(`PRAGMA user_version = ${SQLITE_INDEX_SCHEMA_VERSION}`);
}

function prepareDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  const versionValue = database.prepare("PRAGMA user_version").get()?.user_version;
  const version = typeof versionValue === "number" ? versionValue : 0;
  const hasUserTables =
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all().length > 0;

  if (
    (version !== 0 && version !== SQLITE_INDEX_SCHEMA_VERSION) ||
    (version === 0 && hasUserTables) ||
    (version === SQLITE_INDEX_SCHEMA_VERSION && !isCompatibleSchema(database))
  ) {
    resetSchema(database);
  } else {
    database.exec(SCHEMA_SQL);
    database.exec(`PRAGMA user_version = ${SQLITE_INDEX_SCHEMA_VERSION}`);
  }
  return database;
}

function runIdValue(value: unknown): string | null {
  return text(value);
}

function executionData(event: DomainEvent): Row {
  return record(event.data) ?? {};
}

function nestedExecution(data: Row): Row | undefined {
  return record(data.execution);
}

function executionId(data: Row): string | null {
  const nested = nestedExecution(data);
  return text(data.execution_id) ?? text(nested?.execution_id) ?? text(nested?.id);
}

function executionField(data: Row, name: string): unknown {
  return data[name] ?? nestedExecution(data)?.[name];
}

function artifactData(data: Row): Row {
  return record(data.artifact) ?? {};
}

function artifactField(data: Row, name: string): unknown {
  return data[name] ?? artifactData(data)[name];
}

export class RunIndexer {
  readonly databasePath: string;
  private readonly database: DatabaseSync;
  private readonly discovery: RunDiscovery;
  private readonly runReader: FileRunReader;
  private readonly eventReader: JsonlEventReader;

  constructor(repositoryRoot: string, options: RunIndexerOptions = {}) {
    const root = resolve(repositoryRoot);
    this.databasePath = resolve(root, options.databasePath ?? DEFAULT_MONITOR_INDEX_PATH.join("/"));
    this.database = prepareDatabase(this.databasePath);
    this.discovery =
      options.discovery ??
      new RunDiscovery(root, options.readFile === undefined ? {} : { readFile: options.readFile });
    this.runReader = new FileRunReader(
      root,
      options.readFile === undefined ? {} : { readFile: options.readFile },
    );
    this.eventReader = new JsonlEventReader(
      root,
      options.readFile === undefined ? {} : { readFile: options.readFile },
    );
  }

  async index(): Promise<RunCandidate[]> {
    const candidates = await this.discovery.scan();
    for (const candidate of candidates) {
      await this.indexCandidate(candidate);
    }
    this.removeMissingRuns(candidates);
    return candidates;
  }

  async rebuild(): Promise<RunCandidate[]> {
    resetSchema(this.database);
    return this.index();
  }

  close(): void {
    this.database.close();
  }

  private existingRun(runId: string): ExistingRun | undefined {
    return this.database.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as
      | ExistingRun
      | undefined;
  }

  private async indexCandidate(candidate: RunCandidate): Promise<void> {
    const existing = this.existingRun(candidate.runId);
    const currentRun = candidate.run;
    let state: WorkflowState | undefined;
    let stateError: string | undefined;

    if (candidate.state === "valid" && currentRun !== undefined) {
      const indexedRevision = rowNumber(existing, "last_indexed_state_revision");
      if (existing === undefined || indexedRevision !== currentRun.state_revision) {
        try {
          state = await this.runReader.load(candidate.runId as RunId);
        } catch (error) {
          stateError = errorMessage(error);
        }
      }
    }

    let eventRead: EventRead | undefined;
    let eventError: string | undefined;
    if (candidate.state === "valid") {
      try {
        eventRead = await this.eventReader.readAfterWithQuality(
          candidate.runId as RunId,
          rowNumber(existing, "last_indexed_event_sequence") ?? 0,
        );
      } catch (error) {
        eventError = errorMessage(error);
      }
    }

    const indexedStateRevision =
      state?.run.state_revision ?? rowNumber(existing, "last_indexed_state_revision");
    const indexedEventSequence = Math.max(
      rowNumber(existing, "last_indexed_event_sequence") ?? 0,
      ...(eventRead?.events.map((event) => event.sequence) ?? []),
    );
    const indexStatus =
      candidate.state === "unreadable"
        ? "unreadable"
        : candidate.state === "degraded" || stateError !== undefined || eventError !== undefined
          ? "degraded"
          : eventRead?.degraded === true
            ? "degraded"
            : "valid";
    const errors = [
      candidate.error,
      stateError === undefined ? undefined : `state: ${stateError}`,
      eventError === undefined ? undefined : `events: ${eventError}`,
      eventRead?.degraded === true && eventError === undefined ? "events: degraded" : undefined,
    ].filter((value): value is string => value !== undefined);
    const runError = errors.length === 0 ? null : errors.join("; ");

    this.transaction(() => {
      this.upsertRun(
        candidate,
        existing,
        indexedStateRevision,
        indexedEventSequence,
        indexStatus,
        runError,
      );
      if (state !== undefined) {
        this.replaceSnapshot(state);
      }
      for (const event of eventRead?.events ?? []) {
        this.upsertEvent(event);
      }
    });
  }

  private upsertRun(
    candidate: RunCandidate,
    existing: ExistingRun | undefined,
    indexedStateRevision: number | null,
    indexedEventSequence: number,
    indexStatus: string,
    error: string | null,
  ): void {
    const run = candidate.run;
    const request = run === undefined ? undefined : run.request;
    const outcome = run === undefined ? undefined : record(run.outcome);
    const failure = run === undefined ? undefined : record(run.failure);
    const telemetryQuality =
      run === undefined
        ? rowString(existing, "telemetry_quality")
        : run.telemetry.degraded
          ? "degraded"
          : "healthy";

    this.database
      .prepare(
        `INSERT INTO runs (
          run_id, run_path, request_id, request_type, status, finalized, resumable, current_step,
          initial_playbook, current_playbook, state_revision, graph_revision,
          created_at, started_at, updated_at, finalized_at, request_satisfied,
          telemetry_level, telemetry_quality, baseline_head,
          last_indexed_state_revision, last_indexed_event_sequence, index_status, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          run_path = excluded.run_path,
          request_id = excluded.request_id,
          request_type = excluded.request_type,
          status = excluded.status,
          finalized = excluded.finalized,
          resumable = excluded.resumable,
          current_step = excluded.current_step,
          initial_playbook = excluded.initial_playbook,
          current_playbook = excluded.current_playbook,
          state_revision = excluded.state_revision,
          graph_revision = excluded.graph_revision,
          created_at = excluded.created_at,
          started_at = excluded.started_at,
          updated_at = excluded.updated_at,
          finalized_at = excluded.finalized_at,
          request_satisfied = excluded.request_satisfied,
          telemetry_level = excluded.telemetry_level,
          telemetry_quality = excluded.telemetry_quality,
          baseline_head = excluded.baseline_head,
          last_indexed_state_revision = excluded.last_indexed_state_revision,
          last_indexed_event_sequence = excluded.last_indexed_event_sequence,
          index_status = excluded.index_status,
          error_message = excluded.error_message`,
      )
      .run(
        candidate.runId,
        candidate.path,
        request?.id ?? rowString(existing, "request_id"),
        request?.type ?? rowString(existing, "request_type"),
        run?.status ?? rowString(existing, "status"),
        run === undefined ? rowNumber(existing, "finalized") : booleanValue(run.finalized),
        run === undefined ? rowNumber(existing, "resumable") : booleanValue(failure?.resumable),
        run === undefined ? rowString(existing, "current_step") : json(run.current_step),
        run === undefined ? rowString(existing, "initial_playbook") : json(run.playbook.initial),
        run === undefined ? rowString(existing, "current_playbook") : json(run.playbook.current),
        run?.state_revision ?? rowNumber(existing, "state_revision"),
        run?.graph_revision ?? rowNumber(existing, "graph_revision"),
        run === undefined ? rowString(existing, "created_at") : runTimestamp(run, "created_at"),
        run === undefined ? rowString(existing, "started_at") : runTimestamp(run, "started_at"),
        run === undefined ? rowString(existing, "updated_at") : runTimestamp(run, "updated_at"),
        run === undefined ? rowString(existing, "finalized_at") : runTimestamp(run, "finalized_at"),
        run === undefined
          ? rowNumber(existing, "request_satisfied")
          : booleanValue(outcome?.request_satisfied),
        run === undefined
          ? rowString(existing, "telemetry_level")
          : runTelemetryField(run, "level"),
        telemetryQuality,
        run === undefined
          ? rowString(existing, "baseline_head")
          : runRepositoryField(run, "baseline_head"),
        indexedStateRevision,
        indexedEventSequence,
        indexStatus,
        error,
      );
  }

  private replaceSnapshot(state: WorkflowState): void {
    const runId = state.run.run_id;
    this.database.prepare("DELETE FROM steps WHERE run_id = ?").run(runId);
    this.database.prepare("DELETE FROM findings WHERE run_id = ?").run(runId);

    const stepInsert = this.database.prepare(
      `INSERT INTO steps (
        run_id, step_id, type, objective, agent, status, mandatory, origin,
        depends_on_json, order_index, current_execution_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    state.snapshot.steps.steps.forEach((step, orderIndex) => {
      const stepRecord = record(step) ?? {};
      const currentExecution = record(field(stepRecord, "current_execution"));
      stepInsert.run(
        runId,
        step.id,
        text(step.type),
        text(step.objective),
        text(step.agent),
        text(step.status),
        booleanValue(field(stepRecord, "mandatory")),
        scalar(field(stepRecord, "origin")),
        json(step.depends_on),
        numberValue(field(stepRecord, "order_index")) ??
          numberValue(field(stepRecord, "order")) ??
          orderIndex,
        text(field(stepRecord, "current_execution_id")) ??
          text(field(stepRecord, "execution_id")) ??
          text(currentExecution?.execution_id) ??
          text(currentExecution?.id),
        json(step) ?? "{}",
      );
    });

    const findingInsert = this.database.prepare(
      `INSERT INTO findings (
        run_id, finding_id, state, disposition, severity, confidence, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const finding of state.snapshot.findings.findings) {
      findingInsert.run(
        runId,
        finding.id,
        text(finding.state),
        text(finding.disposition),
        text(finding.severity),
        text(finding.confidence),
        json(finding) ?? "{}",
      );
    }
  }

  private upsertEvent(event: DomainEvent): void {
    this.database
      .prepare(
        `INSERT INTO events (
          run_id, sequence, event_id, type, timestamp, state_revision,
          source_json, actor_json, correlation_id, caused_by_json, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, sequence) DO UPDATE SET
          event_id = excluded.event_id,
          type = excluded.type,
          timestamp = excluded.timestamp,
          state_revision = excluded.state_revision,
          source_json = excluded.source_json,
          actor_json = excluded.actor_json,
          correlation_id = excluded.correlation_id,
          caused_by_json = excluded.caused_by_json,
          payload_json = excluded.payload_json`,
      )
      .run(
        event.run_id,
        event.sequence,
        event.event_id,
        event.type,
        event.timestamp,
        event.state_revision,
        json(event.source) ?? "{}",
        json(event.actor),
        text(event.correlation_id),
        json(event.caused_by),
        json(event.data) ?? "{}",
      );

    const data = executionData(event);
    if (event.type.startsWith("execution.")) {
      this.upsertExecution(event, data);
    }
    if (event.type === "artifact.finalized") {
      this.upsertArtifact(event, data);
    }
  }

  private upsertExecution(event: DomainEvent, data: Row): void {
    const id = executionId(data);
    if (id === null) return;
    const nested = nestedExecution(data);
    const status = text(executionField(data, "status")) ?? event.type.slice("execution.".length);
    this.database
      .prepare(
        `INSERT INTO executions (
          run_id, execution_id, step_id, agent, attempt, status, timing_json,
          provider, model, thinking, tokens_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, execution_id) DO UPDATE SET
          step_id = COALESCE(excluded.step_id, executions.step_id),
          agent = COALESCE(excluded.agent, executions.agent),
          attempt = COALESCE(excluded.attempt, executions.attempt),
          status = COALESCE(excluded.status, executions.status),
          timing_json = COALESCE(excluded.timing_json, executions.timing_json),
          provider = COALESCE(excluded.provider, executions.provider),
          model = COALESCE(excluded.model, executions.model),
          thinking = COALESCE(excluded.thinking, executions.thinking),
          tokens_json = COALESCE(excluded.tokens_json, executions.tokens_json),
          metadata_json = excluded.metadata_json`,
      )
      .run(
        event.run_id,
        id,
        text(executionField(data, "step_id")),
        text(executionField(data, "agent")) ?? text(record(executionField(data, "agent"))?.id),
        numberValue(executionField(data, "attempt")),
        status,
        json(executionField(data, "timing")),
        text(executionField(data, "provider")) ??
          text(record(executionField(data, "model"))?.provider),
        text(executionField(data, "model")) ?? text(record(executionField(data, "model"))?.id),
        text(executionField(data, "thinking")),
        json(executionField(data, "tokens")),
        json(nested ?? data) ?? "{}",
      );
  }

  private upsertArtifact(event: DomainEvent, data: Row): void {
    const path = text(artifactField(data, "path")) ?? text(artifactField(data, "artifact_path"));
    if (path === null) return;
    this.database
      .prepare(
        `INSERT INTO artifacts (
          run_id, path, type, subkind, status, step_id, execution_id,
          domain_id, handoff_summary, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, path) DO UPDATE SET
          type = excluded.type,
          subkind = excluded.subkind,
          status = excluded.status,
          step_id = excluded.step_id,
          execution_id = excluded.execution_id,
          domain_id = excluded.domain_id,
          handoff_summary = excluded.handoff_summary,
          metadata_json = excluded.metadata_json`,
      )
      .run(
        event.run_id,
        path,
        text(artifactField(data, "type")),
        text(artifactField(data, "subkind")),
        text(artifactField(data, "status")),
        text(artifactField(data, "step_id")),
        text(artifactField(data, "execution_id")),
        text(artifactField(data, "domain_id")),
        text(artifactField(data, "handoff_summary")),
        json(artifactData(data)) ?? "{}",
      );
  }

  private transaction(action: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      action();
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }

  private removeMissingRuns(candidates: readonly RunCandidate[]): void {
    const present = new Set(candidates.map((candidate) => candidate.runId));
    const indexed = this.database
      .prepare("SELECT run_id FROM runs")
      .all()
      .map((row) => runIdValue(row.run_id))
      .filter((runId): runId is string => runId !== null);
    const missing = indexed.filter((runId) => !present.has(runId));
    if (missing.length === 0) return;

    this.transaction(() => {
      for (const runId of missing) {
        for (const table of [
          "steps",
          "executions",
          "events",
          "artifacts",
          "findings",
          "evaluations",
        ]) {
          this.database.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(runId);
        }
        this.database.prepare("DELETE FROM runs WHERE run_id = ?").run(runId);
      }
    });
  }
}

export { RunIndexer as SqliteRunIndexer };

export async function indexRuns(
  repositoryRoot: string,
  options: RunIndexerOptions = {},
): Promise<RunCandidate[]> {
  const indexer = new RunIndexer(repositoryRoot, options);
  try {
    return await indexer.index();
  } finally {
    indexer.close();
  }
}

export function defaultMonitorIndexPath(repositoryRoot: string): string {
  return resolve(repositoryRoot, DEFAULT_MONITOR_INDEX_PATH.join("/"));
}

export type { RunCandidate, RunDiscoveryOptions } from "./run-discovery.js";
