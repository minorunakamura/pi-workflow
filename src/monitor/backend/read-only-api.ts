import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import type { ArtifactStatus } from "../../contracts/artifacts/artifact.js";
import { ARTIFACT_STATUSES } from "../../contracts/artifacts/artifact.js";
import type { RunId } from "../../domain/primitives/ids.js";
import type { ArtifactReader, ArtifactContent } from "../../ports/artifact-store.js";
import type { RunReader, WorkflowState } from "../../ports/run-reader.js";
import {
  ArtifactPathSecurityError,
  artifactRunDirectory,
  assertNoSymlinkComponents,
  FileArtifactReader,
  FileRunReader,
  resolveRunRelativeArtifactPath,
} from "../../read-model/run-store-readers.js";
import { defaultMonitorIndexPath, type RunIndexer } from "../indexer/sqlite-run-indexer.js";
import { MonitorLiveUpdater, MonitorUpdateHub, type MonitorNotification } from "../live-updates.js";
import {
  renderMonitorPage,
  type MonitorArtifactView,
  type MonitorEvent,
  type MonitorGraph,
  type MonitorRunDetail,
  type MonitorPageData,
} from "../frontend/render-monitor.js";

export const DEFAULT_MONITOR_HOST = "127.0.0.1";
export const DEFAULT_MONITOR_PORT = 0;

export const READ_ONLY_MONITOR_ROUTES = [
  "GET /",
  "GET /api/v1/runs",
  "GET /api/v1/runs/:runId",
  "GET /api/v1/runs/:runId/state",
  "GET /api/v1/runs/:runId/graph",
  "GET /api/v1/runs/:runId/events",
  "GET /api/v1/runs/:runId/steps/:stepId",
  "GET /api/v1/runs/:runId/executions/:executionId",
  "GET /api/v1/runs/:runId/artifacts",
  "GET /api/v1/runs/:runId/artifact?path=<run-relative-path>",
  "GET /api/v1/runs/:runId/evaluation",
  "GET /api/v1/updates (SSE)",
  "GET /api/v1/compare?run=<A>&run=<B>",
] as const;

type Row = Record<string, unknown>;
type QueryValue = string | number | null;

type StoredJson = Readonly<{
  valid: boolean;
  value: unknown;
}>;

type MonitorComparability = Readonly<{
  same_request_requirement: boolean | null;
  same_repository_baseline: boolean | null;
  same_workflow_config: boolean | null;
  same_model: boolean | null;
  telemetry_comparable: boolean | null;
}>;

export type MonitorApiOptions = Readonly<{
  databasePath?: string;
  runReader?: Pick<RunReader, "load">;
  artifactReader?: ArtifactReader;
  updates?: MonitorUpdateHub;
}>;

export type MonitorServerOptions = Readonly<
  MonitorApiOptions & {
    host?: string;
    port?: number;
    indexer?: RunIndexer;
    liveUpdates?: boolean;
    reconciliationIntervalMs?: number;
    watch?: boolean;
  }
>;

export type MonitorRunSummary = Readonly<{
  run_id: string;
  request_id: string | null;
  request_type: string | null;
  status: string | null;
  finalized: boolean | null;
  resumable: boolean | null;
  current_step: unknown;
  initial_playbook: unknown;
  current_playbook: unknown;
  state_revision: number | null;
  graph_revision: number | null;
  created_at: string | null;
  started_at: string | null;
  updated_at: string | null;
  finalized_at: string | null;
  request_satisfied: boolean | null;
  telemetry_level: string | null;
  telemetry_quality: string | null;
  baseline_head: string | null;
  index_status: string | null;
  error_message: string | null;
}>;

export class MonitorApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "MonitorApiError";
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 0) return false;
  if (value === 1) return true;
  return null;
}

function storedJson(value: unknown): StoredJson {
  if (typeof value !== "string") return { valid: value === null, value };
  try {
    return { valid: true, value: JSON.parse(value) as unknown };
  } catch {
    return { valid: false, value: null };
  }
}

function jsonValue(value: unknown): unknown {
  return storedJson(value).value;
}

function jsonArray(value: unknown): unknown[] {
  const parsed = storedJson(value).value;
  return Array.isArray(parsed) ? parsed : [];
}

function rowMetadata(row: Row): unknown {
  return jsonValue(row.metadata_json);
}

function metadataValue(row: Row, name: string): unknown {
  const metadata = rowMetadata(row);
  return isRecord(metadata) ? metadata[name] : undefined;
}

function metadataArray(row: Row, name: string): unknown[] {
  const value = metadataValue(row, name);
  return Array.isArray(value) ? value : [];
}

function stepDependsOn(row: Row): unknown[] {
  return row.depends_on_json === null || row.depends_on_json === undefined
    ? metadataArray(row, "depends_on")
    : jsonArray(row.depends_on_json);
}

function requireRunId(row: Row | undefined): string {
  const runId = text(row?.run_id);
  if (runId === null) throw new Error("Monitor index contains a Run without an ID");
  return runId;
}

function runSummary(row: Row): MonitorRunSummary {
  return {
    run_id: requireRunId(row),
    request_id: text(row.request_id),
    request_type: text(row.request_type),
    status: text(row.status),
    finalized: booleanValue(row.finalized),
    resumable: booleanValue(row.resumable),
    current_step: jsonValue(row.current_step),
    initial_playbook: jsonValue(row.initial_playbook),
    current_playbook: jsonValue(row.current_playbook),
    state_revision: numberValue(row.state_revision),
    graph_revision: numberValue(row.graph_revision),
    created_at: text(row.created_at),
    started_at: text(row.started_at),
    updated_at: text(row.updated_at),
    finalized_at: text(row.finalized_at),
    request_satisfied: booleanValue(row.request_satisfied),
    telemetry_level: text(row.telemetry_level),
    telemetry_quality: text(row.telemetry_quality),
    baseline_head: text(row.baseline_head),
    index_status: text(row.index_status),
    error_message: text(row.error_message),
  };
}

function decodePath(pathname: string): string[] {
  const rawSegments = pathname.split("/");
  if (rawSegments.at(-1) === "") rawSegments.pop();
  try {
    return rawSegments.filter((segment) => segment.length > 0).map(decodeURIComponent);
  } catch {
    throw new MonitorApiError(400, "INVALID_URL", "The request URL is invalid");
  }
}

function validRunId(value: string): RunId {
  if (!/^run-\d+$/.test(value)) {
    throw new MonitorApiError(400, "INVALID_RUN_ID", "Run ID is invalid");
  }
  return value as RunId;
}

function validEntityId(value: string, kind: "step" | "execution"): string {
  const prefix = kind === "step" ? "step" : "exec";
  if (!new RegExp(`^${prefix}-\\d+$`).test(value)) {
    throw new MonitorApiError(400, `INVALID_${kind.toUpperCase()}_ID`, `${kind} ID is invalid`);
  }
  return value;
}

function integerParameter(value: string | null, name: string, defaultValue: number): number {
  if (value === null) return defaultValue;
  if (!/^\d+$/.test(value)) {
    throw new MonitorApiError(400, "INVALID_QUERY", `${name} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new MonitorApiError(400, "INVALID_QUERY", `${name} is too large`);
  }
  return parsed;
}

function limitParameter(value: string | null): number {
  const limit = integerParameter(value, "limit", 100);
  if (limit < 1 || limit > 200) {
    throw new MonitorApiError(400, "INVALID_QUERY", "limit must be between 1 and 200");
  }
  return limit;
}

function booleanParameter(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  if (value === "true" || value === "1") return 1;
  if (value === "false" || value === "0") return 0;
  throw new MonitorApiError(400, "INVALID_QUERY", `${name} must be true or false`);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return "null";
}

function equalityIfKnown(left: unknown, right: unknown): boolean | null {
  if (left === null || left === undefined || right === null || right === undefined) return null;
  return canonicalJson(left) === canonicalJson(right);
}

function evaluationComparison(evaluation: unknown): Row | undefined {
  const root = isRecord(evaluation) ? evaluation : undefined;
  const comparison = root?.comparison;
  return isRecord(comparison) ? comparison : undefined;
}

function numericLeaves(value: unknown, prefix = ""): Record<string, number> {
  if (typeof value === "number" && Number.isFinite(value) && prefix.length > 0) {
    return { [prefix]: value };
  }
  if (!isRecord(value)) return {};

  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    Object.assign(result, numericLeaves(entry, prefix ? `${prefix}.${key}` : key));
  }
  return result;
}

function telemetryComparability(left: MonitorRunSummary, right: MonitorRunSummary): boolean | null {
  if (left.telemetry_quality === null || right.telemetry_quality === null) return null;
  if (left.telemetry_quality !== "healthy" || right.telemetry_quality !== "healthy") return false;
  if (left.telemetry_level === null || right.telemetry_level === null) return null;
  return left.telemetry_level === right.telemetry_level;
}

function comparisonWarnings(comparability: MonitorComparability): readonly string[] {
  const warnings: string[] = [];
  if (comparability.same_request_requirement !== true) {
    warnings.push(
      comparability.same_request_requirement === false
        ? "different request/requirement fingerprint"
        : "request/requirement fingerprint unavailable",
    );
  }
  if (comparability.same_repository_baseline !== true) {
    warnings.push(
      comparability.same_repository_baseline === false
        ? "different repository baseline"
        : "repository baseline unavailable",
    );
  }
  if (comparability.same_workflow_config !== true) {
    warnings.push(
      comparability.same_workflow_config === false
        ? "different workflow/config version"
        : "workflow/config version unavailable",
    );
  }
  if (comparability.same_model !== true) {
    warnings.push(
      comparability.same_model === false
        ? "different model/provider/thinking"
        : "model/provider/thinking unavailable",
    );
  }
  if (comparability.telemetry_comparable !== true) {
    warnings.push(
      comparability.telemetry_comparable === false
        ? "different telemetry level/quality"
        : "telemetry quality unavailable",
    );
  }
  return warnings;
}

function metricDeltas(
  left: unknown,
  right: unknown,
  telemetryIsComparable: boolean,
): Record<string, Readonly<{ absolute: number; percentage?: number }>> {
  const leftLeaves = numericLeaves(left);
  const rightLeaves = numericLeaves(right);
  const deltas: Record<string, Readonly<{ absolute: number; percentage?: number }>> = {};

  for (const key of Object.keys(leftLeaves)) {
    if (key.startsWith("telemetry.") && !telemetryIsComparable) continue;
    const leftValue = leftLeaves[key];
    const rightValue = rightLeaves[key];
    if (leftValue === undefined || rightValue === undefined) continue;
    const absolute = rightValue - leftValue;
    deltas[key] =
      leftValue === 0 ? { absolute } : { absolute, percentage: (absolute / leftValue) * 100 };
  }
  return deltas;
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function artifactStatus(value: unknown): ArtifactStatus | undefined {
  return typeof value === "string" && (ARTIFACT_STATUSES as readonly string[]).includes(value)
    ? (value as ArtifactStatus)
    : undefined;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof MonitorApiError) {
    sendJson(response, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  sendJson(response, 500, {
    error: { code: "INTERNAL_ERROR", message: "Monitoring API request failed" },
  });
}

export class ReadOnlyMonitorApi {
  readonly databasePath: string;
  private readonly database: DatabaseSync;
  private readonly repositoryRoot: string;
  private readonly runReader: Pick<RunReader, "load">;
  private readonly artifactReader: ArtifactReader;
  private readonly updates: MonitorUpdateHub | undefined;
  private closed = false;

  constructor(repositoryRoot: string, options: MonitorApiOptions = {}) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.databasePath = resolve(
      this.repositoryRoot,
      options.databasePath ?? defaultMonitorIndexPath(this.repositoryRoot),
    );
    this.database = new DatabaseSync(this.databasePath, { readOnly: true });
    this.runReader = options.runReader ?? new FileRunReader(this.repositoryRoot);
    this.artifactReader = options.artifactReader ?? new FileArtifactReader(this.repositoryRoot);
    this.updates = options.updates;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "GET") {
      request.resume();
      response.setHeader("allow", "GET");
      sendJson(response, 405, {
        error: { code: "METHOD_NOT_ALLOWED", message: "Monitoring API is read-only" },
      });
      return;
    }

    try {
      const url = new URL(request.url ?? "", "http://127.0.0.1");
      if (url.pathname === "/") {
        sendHtml(response, 200, await this.frontend(url.searchParams));
        return;
      }
      if (url.pathname === "/api/v1/updates") {
        this.streamUpdates(request, response, url);
        return;
      }
      if (this.wantsEventStream(request)) {
        const segments = decodePath(url.pathname);
        if (
          segments[0] === "api" &&
          segments[1] === "v1" &&
          segments[2] === "runs" &&
          segments.length === 5 &&
          segments[4] === "events"
        ) {
          this.streamUpdates(request, response, url, validRunId(segments[3] ?? ""));
          return;
        }
      }
      const body = await this.route(url);
      sendJson(response, 200, body);
    } catch (error) {
      sendError(response, error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private wantsEventStream(request: IncomingMessage): boolean {
    const accept = request.headers.accept;
    return (
      typeof accept === "string" &&
      accept
        .split(",")
        .some((value) => value.trim().toLowerCase().split(";", 1)[0] === "text/event-stream")
    );
  }

  private currentUpdates(runId?: RunId): MonitorNotification[] {
    const rows =
      runId === undefined
        ? this.query("SELECT * FROM runs ORDER BY run_id ASC")
        : [this.requireRun(runId)];
    return rows.map((row) => ({
      type: "run-updated" as const,
      run_id: requireRunId(row),
      state_revision: numberValue(row.state_revision),
      last_event_sequence: numberValue(row.last_indexed_event_sequence) ?? 0,
      index_status: text(row.index_status) ?? "unknown",
      error_message: text(row.error_message),
    }));
  }

  private streamUpdates(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    runId?: RunId,
  ): void {
    if (runId !== undefined) this.requireRun(runId);
    const afterValue = url.searchParams.get("after_sequence");
    const afterSequence =
      afterValue === null ? undefined : integerParameter(afterValue, "after_sequence", 0);
    const reconnecting = request.headers["last-event-id"] !== undefined;
    let closed = false;
    let unsubscribe = (): void => undefined;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      unsubscribe();
      request.off("close", cleanup);
      response.off("close", cleanup);
    };
    const send = (notification: MonitorNotification): void => {
      if (closed || response.destroyed) return;
      if (
        runId !== undefined &&
        notification.type === "run-updated" &&
        notification.run_id !== runId
      ) {
        return;
      }
      const id =
        notification.type === "run-updated"
          ? `${notification.state_revision ?? 0}-${notification.last_event_sequence}`
          : String(Date.now());
      try {
        response.write(
          `id: ${id}\nevent: ${notification.type}\ndata: ${JSON.stringify(notification)}\n\n`,
        );
      } catch {
        cleanup();
      }
    };

    response.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-content-type-options": "nosniff",
    });
    unsubscribe = this.updates?.subscribe(send) ?? (() => undefined);
    request.once("close", cleanup);
    response.once("close", cleanup);
    response.write(": connected\n\n");

    const current = this.currentUpdates(runId);
    if (
      reconnecting ||
      (afterSequence !== undefined &&
        current.some(
          (notification) =>
            notification.type === "run-updated" && notification.last_event_sequence > afterSequence,
        ))
    ) {
      current.forEach(send);
    }
  }

  private async route(url: URL): Promise<unknown> {
    const segments = decodePath(url.pathname);
    if (segments[0] !== "api" || segments[1] !== "v1") {
      throw new MonitorApiError(404, "NOT_FOUND", "Monitoring API endpoint was not found");
    }

    if (segments[2] === "compare" && segments.length === 3) {
      return this.compare(url.searchParams.getAll("run"));
    }
    if (segments[2] !== "runs") {
      throw new MonitorApiError(404, "NOT_FOUND", "Monitoring API endpoint was not found");
    }
    if (segments.length === 3) return this.listRuns(url.searchParams);

    const runId = validRunId(segments[3] ?? "");
    if (segments.length === 4) return this.detail(runId);

    const resource = segments[4];
    if (resource === "state" && segments.length === 5) return this.state(runId);
    if (resource === "graph" && segments.length === 5) return this.graph(runId);
    if (resource === "events" && segments.length === 5) return this.events(runId, url.searchParams);
    if (resource === "artifacts" && segments.length === 5) return this.artifacts(runId);
    if (resource === "artifact" && segments.length === 5) {
      return this.artifact(runId, url.searchParams.get("path"));
    }
    if (resource === "evaluation" && segments.length === 5) return this.evaluation(runId);
    if (resource === "steps" && segments.length === 6) {
      return this.step(runId, validEntityId(segments[5] ?? "", "step"));
    }
    if (resource === "executions" && segments.length === 6) {
      return this.execution(runId, validEntityId(segments[5] ?? "", "execution"));
    }

    throw new MonitorApiError(404, "NOT_FOUND", "Monitoring API endpoint was not found");
  }

  private async frontend(search: URLSearchParams): Promise<string> {
    const listSearch = new URLSearchParams(search);
    listSearch.delete("run");
    const list = this.listRuns(listSearch) as Readonly<{
      runs: readonly MonitorRunSummary[];
    }>;
    const compareRunIds = search.getAll("compare");
    const comparison =
      compareRunIds.length === 0
        ? undefined
        : (this.compare(compareRunIds) as MonitorPageData["compare"]);
    const page: MonitorPageData = {
      runs: list.runs,
      filters: {
        ...(search.get("search") === null ? {} : { search: search.get("search") ?? "" }),
        ...(search.get("status") === null ? {} : { status: search.get("status") ?? "" }),
      },
      ...(comparison === undefined ? {} : { compare: comparison }),
    };

    const selectedRunId = search.get("run");
    if (selectedRunId === null) return renderMonitorPage(page);

    const runId = validRunId(selectedRunId);
    const detail = (await this.detail(runId)) as MonitorRunDetail;
    const events = this.events(runId, new URLSearchParams("limit=200")) as Readonly<{
      events: readonly MonitorEvent[];
    }>;
    const graph = (await this.graph(runId)) as MonitorGraph;
    const artifactListing = this.artifacts(runId) as Readonly<{
      artifacts: readonly MonitorArtifactView["artifact"][];
    }>;
    const artifactPath = search.get("artifact");
    const selected = {
      detail,
      events: events.events,
      graph,
      artifacts: artifactListing.artifacts,
      ...(artifactPath === null
        ? {}
        : { artifact: (await this.artifact(runId, artifactPath)) as MonitorArtifactView }),
    };
    return renderMonitorPage({ ...page, selected });
  }

  private query(sql: string, ...parameters: QueryValue[]): Row[] {
    return this.database.prepare(sql).all(...parameters) as Row[];
  }

  private one(sql: string, ...parameters: QueryValue[]): Row | undefined {
    return this.database.prepare(sql).get(...parameters) as Row | undefined;
  }

  private requireRun(runId: RunId): Row {
    const row = this.one("SELECT * FROM runs WHERE run_id = ?", runId);
    if (row === undefined) {
      throw new MonitorApiError(404, "RUN_NOT_FOUND", "Run was not found");
    }
    return row;
  }

  private listRuns(search: URLSearchParams): unknown {
    const where: string[] = [];
    const parameters: QueryValue[] = [];
    const add = (condition: string, ...values: QueryValue[]): void => {
      where.push(condition);
      parameters.push(...values);
    };

    for (const name of ["status", "request_type", "telemetry_quality"] as const) {
      const value = search.get(name);
      if (value !== null) add(`${name} = ?`, value);
    }

    const finalized = booleanParameter(search.get("finalized"), "finalized");
    if (finalized !== undefined) add("finalized = ?", finalized);

    const playbook = search.get("playbook");
    if (playbook !== null)
      add("(initial_playbook LIKE ? OR current_playbook LIKE ?)", `%${playbook}%`, `%${playbook}%`);

    const query = search.get("search");
    if (query !== null) {
      const pattern = `%${query}%`;
      add("(run_id LIKE ? OR request_id LIKE ? OR request_type LIKE ?)", pattern, pattern, pattern);
    }

    const createdAfter = search.get("created_after");
    if (createdAfter !== null) add("created_at >= ?", createdAfter);
    const createdBefore = search.get("created_before");
    if (createdBefore !== null) add("created_at <= ?", createdBefore);

    const cursor = search.get("cursor");
    if (cursor !== null) add("run_id > ?", cursor);

    const limit = limitParameter(search.get("limit"));
    const rows = this.query(
      `SELECT * FROM runs${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY run_id ASC LIMIT ?`,
      ...parameters,
      limit,
    );
    return {
      runs: rows.map(runSummary),
      next_cursor: rows.length === limit ? requireRunId(rows.at(-1)) : null,
    };
  }

  private async detail(runId: RunId): Promise<unknown> {
    const row = this.requireRun(runId);
    const state = await this.tryLoadState(runId);
    const evaluation = this.one(
      "SELECT state_revision, last_event_sequence, evaluator_version, evaluation_json FROM evaluations WHERE run_id = ?",
      runId,
    );
    const evaluationRecord =
      evaluation === undefined ? undefined : storedJson(evaluation.evaluation_json);

    const warnings = [
      ...(state === undefined ? ["current state is unavailable"] : []),
      ...(text(row.error_message) === null ? [] : [`index: ${text(row.error_message)}`]),
    ];
    return {
      run: runSummary(row),
      state: state ?? null,
      evaluation:
        evaluation === undefined
          ? null
          : {
              state_revision: numberValue(evaluation.state_revision),
              last_event_sequence: numberValue(evaluation.last_event_sequence),
              evaluator_version: numberValue(evaluation.evaluator_version),
              evaluation: evaluationRecord?.valid ? evaluationRecord.value : null,
            },
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  }

  private async state(runId: RunId): Promise<unknown> {
    this.requireRun(runId);
    const state = await this.tryLoadState(runId);
    if (state === undefined) {
      throw new MonitorApiError(503, "STATE_UNAVAILABLE", "Current Run state is unavailable");
    }
    return state;
  }

  private async tryLoadState(runId: RunId): Promise<WorkflowState | undefined> {
    try {
      return await this.runReader.load(runId);
    } catch {
      return undefined;
    }
  }

  private async graph(runId: RunId): Promise<unknown> {
    const row = this.requireRun(runId);
    const stepRows = this.query(
      "SELECT * FROM steps WHERE run_id = ? ORDER BY order_index ASC, step_id ASC",
      runId,
    );
    const executionRows = this.query(
      "SELECT * FROM executions WHERE run_id = ? ORDER BY attempt ASC, execution_id ASC",
      runId,
    );
    const artifactRows = this.query(
      "SELECT * FROM artifacts WHERE run_id = ? ORDER BY path ASC",
      runId,
    );
    const nodes = stepRows.map((step) =>
      this.stepView(
        step,
        executionRows.filter((execution) => execution.step_id === step.step_id),
        artifactRows.filter((artifact) => artifact.step_id === step.step_id),
      ),
    );
    const edges = nodes.flatMap((node) =>
      (Array.isArray(node.depends_on) ? node.depends_on : [])
        .filter((dependency): dependency is string => typeof dependency === "string")
        .map((dependency) => ({ source: dependency, target: node.id })),
    );
    const state = await this.tryLoadState(runId);
    const gates = state?.snapshot.gates.gates.map((gate) => ({ ...gate, annotation: true })) ?? [];

    return {
      run_id: runId,
      graph_revision: numberValue(row.graph_revision),
      nodes,
      edges,
      gates,
      ...(state === undefined ? { warnings: ["gate annotations are unavailable"] } : {}),
    };
  }

  private events(runId: RunId, search: URLSearchParams): unknown {
    this.requireRun(runId);
    const afterSequence = integerParameter(search.get("after_sequence"), "after_sequence", 0);
    const limit = limitParameter(search.get("limit"));
    const where = ["run_id = ?", "sequence > ?"];
    const parameters: QueryValue[] = [runId, afterSequence];

    const type = search.get("type");
    if (type !== null) {
      where.push("type = ?");
      parameters.push(type);
    }
    const category = search.get("category");
    if (category !== null) {
      where.push("type LIKE ?");
      parameters.push(`${category}.%`);
    }

    const rows = this.query(
      `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY sequence ASC LIMIT ?`,
      ...parameters,
      limit,
    );
    return {
      run_id: runId,
      events: rows.map((event) => ({
        run_id: text(event.run_id),
        sequence: numberValue(event.sequence),
        event_id: text(event.event_id),
        type: text(event.type),
        timestamp: text(event.timestamp),
        state_revision: numberValue(event.state_revision),
        source: jsonValue(event.source_json),
        actor: jsonValue(event.actor_json),
        correlation_id: text(event.correlation_id),
        caused_by: jsonValue(event.caused_by_json),
        data: jsonValue(event.payload_json),
      })),
    };
  }

  private stepView(
    row: Row,
    executionRows: readonly Row[],
    artifactRows: readonly Row[],
  ): Record<string, unknown> {
    const metadata = rowMetadata(row);
    const metadataRecord = isRecord(metadata) ? metadata : undefined;
    return {
      id: text(row.step_id),
      type: text(row.type),
      objective: text(row.objective),
      agent: text(row.agent),
      skills: metadataArray(row, "skills"),
      inputs: metadataArray(row, "inputs"),
      outputs: metadataArray(row, "outputs"),
      depends_on: stepDependsOn(row),
      completion_criteria: metadataArray(row, "completion_criteria"),
      status: text(row.status),
      blocked_by: metadataArray(row, "blocked_by"),
      result: metadataRecord?.result ?? null,
      mandatory: booleanValue(row.mandatory),
      origin: text(row.origin) ?? text(metadataRecord?.origin),
      trigger: text(metadataRecord?.trigger),
      skip_reason: text(metadataRecord?.skip_reason),
      obsolete: booleanValue(metadataRecord?.obsolete),
      order_index: numberValue(row.order_index),
      current_execution_id: text(row.current_execution_id),
      attempts: executionRows.map((execution) => this.executionSummary(execution)),
      artifacts: artifactRows.map((artifact) => this.artifactSummary(artifact)),
      related: metadataRecord?.related ?? metadataRecord?.related_ids ?? null,
      metadata,
    };
  }

  private executionSummary(row: Row): Record<string, unknown> {
    return {
      id: text(row.execution_id),
      step_id: text(row.step_id),
      agent: text(row.agent),
      attempt: numberValue(row.attempt),
      status: text(row.status),
      timing: jsonValue(row.timing_json),
      provider: text(row.provider),
      model: text(row.model),
      thinking: text(row.thinking),
      tokens: jsonValue(row.tokens_json),
      metadata: rowMetadata(row),
    };
  }

  private step(runId: RunId, stepId: string): unknown {
    this.requireRun(runId);
    const row = this.one("SELECT * FROM steps WHERE run_id = ? AND step_id = ?", runId, stepId);
    if (row === undefined) {
      throw new MonitorApiError(404, "STEP_NOT_FOUND", "Step was not found");
    }
    const executions = this.query(
      "SELECT * FROM executions WHERE run_id = ? AND step_id = ? ORDER BY attempt ASC, execution_id ASC",
      runId,
      stepId,
    );
    const artifacts = this.query(
      "SELECT * FROM artifacts WHERE run_id = ? AND step_id = ? ORDER BY path ASC",
      runId,
      stepId,
    );
    return { run_id: runId, step: this.stepView(row, executions, artifacts) };
  }

  private execution(runId: RunId, executionId: string): unknown {
    this.requireRun(runId);
    const row = this.one(
      "SELECT * FROM executions WHERE run_id = ? AND execution_id = ?",
      runId,
      executionId,
    );
    if (row === undefined) {
      throw new MonitorApiError(404, "EXECUTION_NOT_FOUND", "Execution was not found");
    }
    return { run_id: runId, execution: this.executionSummary(row) };
  }

  private artifacts(runId: RunId): unknown {
    this.requireRun(runId);
    const rows = this.query("SELECT * FROM artifacts WHERE run_id = ? ORDER BY path ASC", runId);
    return { run_id: runId, artifacts: rows.map((row) => this.artifactSummary(row)) };
  }

  private artifactSummary(row: Row): unknown {
    return {
      path: text(row.path),
      type: text(row.type),
      subkind: text(row.subkind),
      status: text(row.status),
      step_id: text(row.step_id),
      execution_id: text(row.execution_id),
      domain_id: text(row.domain_id),
      handoff_summary: text(row.handoff_summary),
      metadata: rowMetadata(row),
    };
  }

  private async artifact(runId: RunId, requestedPath: string | null): Promise<unknown> {
    this.requireRun(runId);
    if (requestedPath === null || requestedPath.length === 0) {
      throw new MonitorApiError(400, "INVALID_ARTIFACT_PATH", "Artifact path is required");
    }

    let resolvedPath: ReturnType<typeof resolveRunRelativeArtifactPath>;
    try {
      resolvedPath = resolveRunRelativeArtifactPath(
        artifactRunDirectory(this.repositoryRoot, runId),
        requestedPath,
      );
    } catch (error) {
      if (error instanceof ArtifactPathSecurityError) {
        throw new MonitorApiError(
          400,
          "INVALID_ARTIFACT_PATH",
          "Artifact path must remain inside the Run artifact root",
        );
      }
      throw error;
    }

    try {
      await assertNoSymlinkComponents(this.repositoryRoot, resolvedPath.path);
    } catch (error) {
      if (error instanceof ArtifactPathSecurityError) {
        throw new MonitorApiError(
          400,
          "INVALID_ARTIFACT_PATH",
          "Artifact path must remain inside the Run artifact root",
        );
      }
      throw error;
    }

    const row = this.one(
      "SELECT * FROM artifacts WHERE run_id = ? AND path = ?",
      runId,
      resolvedPath.relativePath,
    );
    if (row === undefined) {
      throw new MonitorApiError(404, "ARTIFACT_NOT_FOUND", "Artifact was not found");
    }

    const status = artifactStatus(row.status);
    if (status === undefined) {
      throw new MonitorApiError(503, "ARTIFACT_UNAVAILABLE", "Artifact metadata is invalid");
    }

    let content: ArtifactContent;
    try {
      content = await this.artifactReader.read({
        runId,
        path: resolvedPath.relativePath,
        status,
      });
    } catch (error) {
      if (error instanceof ArtifactPathSecurityError) {
        throw new MonitorApiError(
          400,
          "INVALID_ARTIFACT_PATH",
          "Artifact path must remain inside the Run artifact root",
        );
      }
      if (isNotFound(error)) {
        throw new MonitorApiError(404, "ARTIFACT_NOT_FOUND", "Artifact file was not found");
      }
      if (error instanceof Error && error.name === "ArtifactValidationError") {
        throw new MonitorApiError(422, "ARTIFACT_INVALID", "Artifact content is invalid");
      }
      throw new MonitorApiError(503, "ARTIFACT_UNAVAILABLE", "Artifact content is unavailable");
    }

    return {
      run_id: runId,
      artifact: this.artifactSummary(row),
      content: {
        front_matter: content.frontMatter,
        body: content.body,
      },
    };
  }

  private evaluationRow(runId: RunId): Row | undefined {
    return this.one(
      "SELECT state_revision, last_event_sequence, evaluator_version, evaluation_json FROM evaluations WHERE run_id = ?",
      runId,
    );
  }

  private evaluation(runId: RunId): unknown {
    this.requireRun(runId);
    const row = this.evaluationRow(runId);
    if (row === undefined) {
      throw new MonitorApiError(404, "EVALUATION_NOT_FOUND", "Evaluation was not found");
    }
    const evaluation = storedJson(row.evaluation_json);
    if (!evaluation.valid) {
      throw new MonitorApiError(503, "EVALUATION_UNAVAILABLE", "Evaluation data is invalid");
    }
    return {
      run_id: runId,
      state_revision: numberValue(row.state_revision),
      last_event_sequence: numberValue(row.last_event_sequence),
      evaluator_version: numberValue(row.evaluator_version),
      evaluation: evaluation.value,
    };
  }

  private compare(runIds: readonly string[]): unknown {
    if (runIds.length !== 2) {
      throw new MonitorApiError(
        400,
        "INVALID_QUERY",
        "compare requires exactly two run parameters",
      );
    }
    const leftId = validRunId(runIds[0] ?? "");
    const rightId = validRunId(runIds[1] ?? "");
    const leftRow = this.requireRun(leftId);
    const rightRow = this.requireRun(rightId);
    const leftSummary = runSummary(leftRow);
    const rightSummary = runSummary(rightRow);
    const leftEvaluationRow = this.evaluationRow(leftId);
    const rightEvaluationRow = this.evaluationRow(rightId);
    const leftEvaluation =
      leftEvaluationRow === undefined ? null : storedJson(leftEvaluationRow.evaluation_json).value;
    const rightEvaluation =
      rightEvaluationRow === undefined
        ? null
        : storedJson(rightEvaluationRow.evaluation_json).value;
    const leftComparison = evaluationComparison(leftEvaluation);
    const rightComparison = evaluationComparison(rightEvaluation);
    const leftModels = this.models(leftId, leftComparison);
    const rightModels = this.models(rightId, rightComparison);
    const leftMetrics = isRecord(leftEvaluation) ? (leftEvaluation.metrics ?? null) : null;
    const rightMetrics = isRecord(rightEvaluation) ? (rightEvaluation.metrics ?? null) : null;
    const comparability: MonitorComparability = {
      same_request_requirement:
        leftSummary.request_id === null ||
        rightSummary.request_id === null ||
        leftSummary.request_type === null ||
        rightSummary.request_type === null
          ? null
          : leftSummary.request_id === rightSummary.request_id &&
            leftSummary.request_type === rightSummary.request_type,
      same_repository_baseline: equalityIfKnown(
        leftSummary.baseline_head,
        rightSummary.baseline_head,
      ),
      same_workflow_config: equalityIfKnown(
        leftComparison?.workflow_version ?? leftSummary.current_playbook,
        rightComparison?.workflow_version ?? rightSummary.current_playbook,
      ),
      same_model: equalityIfKnown(leftModels, rightModels),
      telemetry_comparable: telemetryComparability(leftSummary, rightSummary),
    };

    return {
      runs: [leftSummary, rightSummary],
      comparability,
      warnings: comparisonWarnings(comparability),
      evaluations: {
        [leftId]: leftEvaluation,
        [rightId]: rightEvaluation,
      },
      metrics: {
        [leftId]: leftMetrics,
        [rightId]: rightMetrics,
      },
      deltas: metricDeltas(leftMetrics, rightMetrics, comparability.telemetry_comparable === true),
    };
  }

  private models(runId: RunId, comparison: Row | undefined): unknown {
    if (Array.isArray(comparison?.model_provider_usage)) {
      return comparison.model_provider_usage.length === 0
        ? undefined
        : comparison.model_provider_usage;
    }
    const models = this.query(
      "SELECT provider, model FROM executions WHERE run_id = ? AND (provider IS NOT NULL OR model IS NOT NULL) ORDER BY execution_id ASC",
      runId,
    ).map((row) => ({ provider: text(row.provider), model: text(row.model) }));
    return models.length === 0 ? undefined : models;
  }
}

export function createMonitorServer(
  repositoryRoot: string,
  options: MonitorApiOptions = {},
): Server {
  const api = new ReadOnlyMonitorApi(repositoryRoot, options);
  const server = createServer((request, response) => {
    void api.handle(request, response);
  });
  server.once("close", () => api.close());
  return server;
}

export const createReadOnlyMonitorServer = createMonitorServer;

export async function startMonitorServer(
  repositoryRoot: string,
  options: MonitorServerOptions = {},
): Promise<Server> {
  const liveUpdater =
    options.liveUpdates === false
      ? undefined
      : new MonitorLiveUpdater(repositoryRoot, {
          ...(options.updates === undefined ? {} : { hub: options.updates }),
          ...(options.indexer === undefined ? {} : { indexer: options.indexer }),
          ...(options.reconciliationIntervalMs === undefined
            ? {}
            : { reconciliationIntervalMs: options.reconciliationIntervalMs }),
          ...(options.watch === undefined ? {} : { watch: options.watch }),
        });
  if (liveUpdater !== undefined) await liveUpdater.start();

  const server = createMonitorServer(repositoryRoot, {
    ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
    ...(options.runReader === undefined ? {} : { runReader: options.runReader }),
    ...(options.artifactReader === undefined ? {} : { artifactReader: options.artifactReader }),
    ...((liveUpdater?.hub ?? options.updates) === undefined
      ? {}
      : { updates: liveUpdater?.hub ?? options.updates }),
  });
  if (liveUpdater !== undefined) server.once("close", () => liveUpdater.stop());

  const host = options.host ?? DEFAULT_MONITOR_HOST;
  const port = options.port ?? DEFAULT_MONITOR_PORT;

  return new Promise<Server>((resolveServer, reject) => {
    const onError = (error: Error): void => {
      server.off("error", onError);
      liveUpdater?.stop();
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolveServer(server);
    });
  });
}
