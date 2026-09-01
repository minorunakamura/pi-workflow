type MonitorRunSummary = Readonly<{
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

type JsonRecord = Record<string, unknown>;

type MonitorEvent = Readonly<{
  run_id: string | null;
  sequence: number | null;
  event_id: string | null;
  type: string | null;
  timestamp: string | null;
  state_revision: number | null;
  source: unknown;
  actor: unknown;
  correlation_id: string | null;
  caused_by: unknown;
  data: unknown;
}>;

type MonitorRunDetail = Readonly<{
  run: MonitorRunSummary;
  state: unknown;
  evaluation: unknown;
  warnings?: readonly string[];
}>;

export type MonitorPageData = Readonly<{
  runs: readonly MonitorRunSummary[];
  filters?: Readonly<{
    search?: string;
    status?: string;
  }>;
  selected?: Readonly<{
    detail: MonitorRunDetail;
    events: readonly MonitorEvent[];
  }>;
}>;

export type RunLifecycle =
  | "created"
  | "running"
  | "blocked"
  | "recoverable-failed"
  | "final-failed"
  | "completed"
  | "cancelled"
  | "failed-unknown"
  | "unavailable";

type LifecyclePresentation = Readonly<{
  kind: RunLifecycle;
  label: string;
  priority: number;
}>;

const LIFECYCLE_PRESENTATIONS: Readonly<Record<RunLifecycle, LifecyclePresentation>> = {
  blocked: { kind: "blocked", label: "Blocked", priority: 0 },
  "recoverable-failed": { kind: "recoverable-failed", label: "Recoverable Failed", priority: 1 },
  running: { kind: "running", label: "Running", priority: 2 },
  created: { kind: "created", label: "Created", priority: 3 },
  "final-failed": { kind: "final-failed", label: "Final Failed", priority: 4 },
  completed: { kind: "completed", label: "Completed", priority: 5 },
  cancelled: { kind: "cancelled", label: "Cancelled", priority: 6 },
  "failed-unknown": {
    kind: "failed-unknown",
    label: "Failed (details unavailable)",
    priority: 7,
  },
  unavailable: { kind: "unavailable", label: "Unavailable", priority: 8 },
};

const LIFECYCLE_LEGEND: readonly RunLifecycle[] = [
  "running",
  "blocked",
  "recoverable-failed",
  "final-failed",
  "completed",
  "cancelled",
];

const EVENT_LABELS: Readonly<Record<string, string>> = {
  "run.created": "Run created",
  "run.started": "Run started",
  "run.blocked": "Run blocked",
  "run.unblocked": "Run unblocked",
  "run.failed": "Run failed",
  "run.resumed": "Run resumed",
  "run.cancel-requested": "Run cancellation requested",
  "run.cancelled": "Run cancelled",
  "run.completed": "Run completed",
  "request.received": "Request received",
  "request.amended": "Request amended",
  "requirement.created": "Requirement created",
  "requirement.revised": "Requirement revised",
  "playbook.selected": "Playbook selected",
  "playbook.switched": "Playbook switched",
  "step.started": "Step started",
  "step.blocked": "Step blocked",
  "step.completed": "Step completed",
  "step.failed": "Step failed",
  "step.skipped": "Step skipped",
  "execution.started": "Execution started",
  "execution.completed": "Execution completed",
  "execution.blocked": "Execution blocked",
  "execution.failed": "Execution failed",
  "execution.interrupted": "Execution interrupted",
  "tool.started": "Tool started",
  "tool.completed": "Tool completed",
  "tool.failed": "Tool failed",
  "artifact.finalized": "Artifact finalized",
  "verification.completed": "Verification completed",
  "verification.invalidated": "Verification invalidated",
  "review.completed": "Review completed",
  "review.invalidated": "Review invalidated",
  "error.occurred": "Error occurred",
  "error.recovered": "Error recovered",
  "error.escalated": "Error escalated",
};

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character,
  );
}

function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? "-";
  } catch {
    return "[unavailable]";
  }
}

function valueMarkup(value: unknown): string {
  if (value === null || value === undefined) return '<span class="muted">-</span>';
  return `<code>${escapeHtml(jsonText(value))}</code>`;
}

function firstValue(...values: readonly unknown[]): unknown {
  return values.find((value) => value !== null && value !== undefined) ?? null;
}

function runLifecycle(
  run: Pick<MonitorRunSummary, "status" | "resumable" | "finalized">,
): LifecyclePresentation {
  if (run.status === "failed") {
    if (run.resumable === true && run.finalized === false) {
      return LIFECYCLE_PRESENTATIONS["recoverable-failed"];
    }
    if (run.resumable === false && run.finalized === true) {
      return LIFECYCLE_PRESENTATIONS["final-failed"];
    }
    return LIFECYCLE_PRESENTATIONS["failed-unknown"];
  }

  if (run.status === "created") return LIFECYCLE_PRESENTATIONS.created;
  if (run.status === "running") return LIFECYCLE_PRESENTATIONS.running;
  if (run.status === "blocked") return LIFECYCLE_PRESENTATIONS.blocked;
  if (run.status === "completed") return LIFECYCLE_PRESENTATIONS.completed;
  if (run.status === "cancelled") return LIFECYCLE_PRESENTATIONS.cancelled;
  return LIFECYCLE_PRESENTATIONS.unavailable;
}

export function getRunLifecycle(
  run: Pick<MonitorRunSummary, "status" | "resumable" | "finalized">,
): RunLifecycle {
  return runLifecycle(run).kind;
}

function timestamp(run: MonitorRunSummary): string {
  return run.created_at ?? "-";
}

function dateMilliseconds(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function duration(run: MonitorRunSummary): string {
  const start = dateMilliseconds(run.started_at ?? run.created_at);
  const end = dateMilliseconds(run.finalized_at ?? run.updated_at) ?? Date.now();
  if (start === null || end < start) return "-";

  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function playbookLabel(value: unknown): string {
  const version = record(value)?.version;
  return version === undefined ? jsonText(value) : `version ${jsonText(version)}`;
}

function currentStepLabel(run: MonitorRunSummary): string {
  return text(record(run.current_step)?.id) ?? "-";
}

function requestLabel(run: MonitorRunSummary): string {
  return (
    [run.request_type, run.request_id]
      .filter((value): value is string => value !== null)
      .join(" · ") || "-"
  );
}

function sortRuns(left: MonitorRunSummary, right: MonitorRunSummary): number {
  const priority = runLifecycle(left).priority - runLifecycle(right).priority;
  if (priority !== 0) return priority;
  return (dateMilliseconds(right.created_at) ?? 0) - (dateMilliseconds(left.created_at) ?? 0);
}

function option(value: string, label: string, selected: string): string {
  return `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function renderLifecycleLegend(): string {
  return `<ul class="lifecycle-legend" aria-label="Run lifecycle legend">${LIFECYCLE_LEGEND.map(
    (kind) => {
      const presentation = LIFECYCLE_PRESENTATIONS[kind];
      return `<li><span class="lifecycle-badge lifecycle-${kind}" data-lifecycle="${kind}">${presentation.label}</span></li>`;
    },
  ).join("")}</ul>`;
}

function renderRunList(data: MonitorPageData): string {
  const search = data.filters?.search ?? "";
  const status = data.filters?.status ?? "";
  const rows = [...data.runs].sort(sortRuns);
  const selectedId = data.selected?.detail.run.run_id;

  return `<section class="panel" id="run-list" data-section="run-list" aria-labelledby="run-list-heading">
    <div class="section-heading">
      <div>
        <p class="eyebrow">Monitoring</p>
        <h2 id="run-list-heading">Runs</h2>
      </div>
      <form class="filters" method="get" action="/">
        <label>Search <input name="search" type="search" value="${escapeHtml(search)}" placeholder="Run or request ID"></label>
        <label>Status <select name="status">
          ${option("", "All", status)}
          ${option("running", "Running", status)}
          ${option("blocked", "Blocked", status)}
          ${option("failed", "Failed", status)}
          ${option("completed", "Completed", status)}
          ${option("cancelled", "Cancelled", status)}
        </select></label>
        <button type="submit">Filter</button>
      </form>
    </div>
    ${renderLifecycleLegend()}
    <div class="table-scroll">
      <table>
        <thead><tr>
          <th scope="col">Run ID</th>
          <th scope="col">Request ID/type</th>
          <th scope="col">Status</th>
          <th scope="col">Playbook</th>
          <th scope="col">Current Step</th>
          <th scope="col">Created / duration</th>
          <th scope="col">Telemetry health</th>
        </tr></thead>
        <tbody>${
          rows.length === 0
            ? '<tr><td colspan="7" class="empty">No Runs match the current filter.</td></tr>'
            : rows
                .map((run) => {
                  const presentation = runLifecycle(run);
                  const selected = run.run_id === selectedId;
                  const telemetryKind =
                    run.telemetry_quality === "healthy"
                      ? "healthy"
                      : run.telemetry_quality === "degraded"
                        ? "degraded"
                        : "unknown";
                  return `<tr class="run-row lifecycle-row-${presentation.kind}" data-lifecycle="${presentation.kind}"${selected ? ' aria-current="true"' : ""}>
                    <td><a href="/?run=${encodeURIComponent(run.run_id)}">${escapeHtml(run.run_id)}</a></td>
                    <td>${escapeHtml(requestLabel(run))}</td>
                    <td><span class="lifecycle-badge lifecycle-${presentation.kind}" data-lifecycle="${presentation.kind}">${presentation.label}</span></td>
                    <td>${escapeHtml(playbookLabel(run.current_playbook))}</td>
                    <td>${escapeHtml(currentStepLabel(run))}</td>
                    <td><time datetime="${escapeHtml(timestamp(run))}">${escapeHtml(timestamp(run))}</time><br><span class="muted">${escapeHtml(duration(run))}</span></td>
                    <td><span class="telemetry telemetry-${telemetryKind}">${escapeHtml(run.telemetry_quality ?? "unknown")}</span>${run.telemetry_level === null ? "" : `<br><span class="muted">${escapeHtml(run.telemetry_level)}</span>`}</td>
                  </tr>`;
                })
                .join("")
        }</tbody>
      </table>
    </div>
  </section>`;
}

function issueText(value: unknown): string {
  const issue = record(value);
  if (issue === undefined) return jsonText(value);
  return (
    text(issue.reason) ??
    text(issue.message) ??
    text(issue.code) ??
    text(issue.kind) ??
    jsonText(value)
  );
}

function openCount(value: unknown, field: string): number {
  if (!Array.isArray(value)) return 0;
  return value.filter((entry) => {
    const status = record(entry)?.[field];
    return status === "open" || status === "pending";
  }).length;
}

function fieldRow(label: string, value: unknown): string {
  return `<div class="fact"><dt>${escapeHtml(label)}</dt><dd>${valueMarkup(value)}</dd></div>`;
}

function renderOverviewFacts(
  run: MonitorRunSummary,
  stateRun: JsonRecord,
  snapshot: JsonRecord | undefined,
  verification: unknown,
  review: unknown,
): string {
  const requirement = record(snapshot?.requirement);
  const currentChanges = stateRun.current_changes;
  const repository = record(stateRun.repository);
  const drift = record(currentChanges)?.external_reconciliation ?? null;
  const decisions = record(snapshot?.decisions)?.decisions;
  const uncertainties = record(snapshot?.uncertainties)?.uncertainties;

  return `<dl class="facts">
    ${fieldRow("Status / blocker", runLifecycle(run).label)}
    ${fieldRow("Current Step", firstValue(record(stateRun.current_step)?.id, currentStepLabel(run)))}
    ${fieldRow("Playbook", { initial: run.initial_playbook, current: run.current_playbook })}
    ${fieldRow("Requirement revision", requirement?.revision ?? null)}
    ${fieldRow("Current Plan/applicability", stateRun.current_plan ?? null)}
    ${fieldRow("Current Changes", currentChanges ?? null)}
    ${fieldRow("Repository drift", firstValue(drift, repository?.drift))}
    ${fieldRow("Verification", verification)}
    ${fieldRow("Review", review)}
    ${fieldRow("Open Findings", openCount(record(snapshot?.findings)?.findings, "state"))}
    ${fieldRow("Open Decisions/Uncertainties", `${openCount(decisions, "status")} / ${openCount(uncertainties, "status")}`)}
  </dl>`;
}

function renderCorrectness(
  run: MonitorRunSummary,
  outcome: JsonRecord | undefined,
  correctness: JsonRecord | undefined,
  verification: unknown,
  review: unknown,
): string {
  const verificationRecord = record(verification);
  const reviewRecord = record(review);
  const accepted = firstValue(
    outcome?.accepted_risks,
    outcome?.accepted_limitations,
    correctness?.accepted_risks,
    correctness?.accepted_limitations,
    verificationRecord?.accepted_risks,
    verificationRecord?.accepted_limitations,
    reviewRecord?.accepted_limitations,
  );
  const acceptedCount = firstValue(
    verificationRecord?.accepted_limitations_count,
    reviewRecord?.accepted_limitations_count,
  );

  return `<section class="priority-panel correctness" data-section="correctness" aria-labelledby="correctness-heading">
    <p class="eyebrow">Correctness first</p>
    <h3 id="correctness-heading">Correctness evidence</h3>
    <dl class="facts">
      ${fieldRow("request_satisfied", firstValue(run.request_satisfied, outcome?.request_satisfied))}
      ${fieldRow("Final Verification", verification)}
      ${fieldRow("Final Review", review)}
      ${fieldRow("Accepted risks / limitations", accepted)}
      ${fieldRow("Accepted limitation count", acceptedCount)}
    </dl>
  </section>`;
}

function renderEfficiency(
  run: MonitorRunSummary,
  evaluation: JsonRecord | undefined,
  metrics: JsonRecord | undefined,
): string {
  const efficiency = record(evaluation?.efficiency) ?? metrics;
  return `<section class="priority-panel efficiency" data-section="efficiency" aria-labelledby="efficiency-heading">
    <p class="eyebrow">After correctness</p>
    <h3 id="efficiency-heading">Efficiency</h3>
    <dl class="facts">
      ${fieldRow("Duration", duration(run))}
      ${fieldRow("Telemetry", efficiency?.telemetry ?? metrics?.telemetry ?? null)}
      ${fieldRow("Orchestration", efficiency?.orchestration ?? metrics?.orchestration ?? null)}
    </dl>
  </section>`;
}

function eventData(event: MonitorEvent): JsonRecord {
  return record(event.data) ?? {};
}

function eventExecutionId(event: MonitorEvent): string | null {
  const data = eventData(event);
  const nested = record(data.execution);
  return (
    text(event.correlation_id) ??
    text(data.execution_id) ??
    text(nested?.execution_id) ??
    text(nested?.id)
  );
}

function eventGroupKey(event: MonitorEvent): string | null {
  const type = text(event.type) ?? "";
  const data = eventData(event);
  const nested = record(data.execution);
  const executionId = eventExecutionId(event);
  if (
    !type.startsWith("execution.") &&
    !type.startsWith("tool.") &&
    data.execution_id === undefined &&
    nested === undefined
  ) {
    return null;
  }
  return executionId;
}

function eventSequence(event: MonitorEvent): number {
  return numberValue(event.sequence) ?? Number.MAX_SAFE_INTEGER;
}

function eventDescription(event: MonitorEvent): string {
  const type = text(event.type) ?? "unknown.event";
  const data = eventData(event);
  const nested = record(data.execution);
  const identifier = type.startsWith("tool.")
    ? (text(data.tool) ?? text(data.tool_name) ?? text(data.execution_id))
    : (text(data.step_id) ??
      text(data.execution_id) ??
      text(nested?.id) ??
      text(nested?.execution_id));
  const label = EVENT_LABELS[type] ?? type.replace(/[.-]/g, " ");
  return identifier === null ? label : `${label} · ${identifier}`;
}

function isToolEvent(event: MonitorEvent): boolean {
  return (text(event.type) ?? "").startsWith("tool.");
}

function isAlertEvent(event: MonitorEvent): boolean {
  const type = text(event.type) ?? "";
  return (
    type.startsWith("error.") ||
    type.endsWith(".failed") ||
    type === "run.blocked" ||
    type === "run.unblocked" ||
    type === "run.resumed"
  );
}

function eventDetails(event: MonitorEvent): string {
  const raw = [
    fieldRow("type", event.type),
    fieldRow("event_id", event.event_id),
    fieldRow("state_revision", event.state_revision),
    fieldRow("source", event.source),
    fieldRow("actor", event.actor),
    fieldRow("correlation_id", event.correlation_id),
    fieldRow("caused_by", event.caused_by),
    fieldRow("data", event.data),
  ].join("");
  return `<details class="event-details"><summary>Raw event details</summary><dl class="facts">${raw}</dl></details>`;
}

function renderTimelineEvent(event: MonitorEvent): string {
  const sequence = numberValue(event.sequence);
  const sequenceLabel = sequence === null ? "—" : `#${sequence}`;
  const type = text(event.type) ?? "unknown.event";
  const alert = isAlertEvent(event);
  const heading = `<span class="timeline-event-head"><span class="event-sequence">${sequenceLabel}</span><time datetime="${escapeHtml(event.timestamp ?? "")}">${escapeHtml(event.timestamp ?? "-")}</time><strong>${escapeHtml(eventDescription(event))}</strong></span>`;
  const contents = `${heading}${eventDetails(event)}`;

  if (isToolEvent(event) && !alert) {
    return `<details class="timeline-tool" data-sequence="${sequenceLabel}"><summary>${heading}</summary>${eventDetails(event)}</details>`;
  }
  return `<article class="timeline-event${alert ? " timeline-event-alert" : ""}" data-event-type="${escapeHtml(type)}" data-sequence="${sequenceLabel}">${contents}</article>`;
}

type TimelineItem =
  | Readonly<{ kind: "event"; event: MonitorEvent }>
  | Readonly<{ kind: "group"; key: string; events: readonly MonitorEvent[] }>;

function timelineItems(events: readonly MonitorEvent[]): TimelineItem[] {
  const sorted = [...events].sort((left, right) => eventSequence(left) - eventSequence(right));
  const items: TimelineItem[] = [];
  for (const event of sorted) {
    const key = eventGroupKey(event);
    const previous = items.at(-1);
    if (key !== null && previous?.kind === "group" && previous.key === key) {
      items[items.length - 1] = { ...previous, events: [...previous.events, event] };
    } else if (key !== null) {
      items.push({ kind: "group", key, events: [event] });
    } else {
      items.push({ kind: "event", event });
    }
  }
  return items;
}

function groupLabel(key: string, events: readonly MonitorEvent[]): string {
  const firstEvent = events[0];
  const first = firstEvent === undefined ? {} : eventData(firstEvent);
  const nested = record(first.execution);
  const rawAgent = text(first.agent) ?? text(nested?.agent) ?? "Worker";
  const agent = `${rawAgent.slice(0, 1).toUpperCase()}${rawAgent.slice(1)}`;
  return `${agent} · ${key}`;
}

function renderTimeline(events: readonly MonitorEvent[]): string {
  const items = timelineItems(events);
  return `<section class="panel" data-section="timeline" aria-labelledby="timeline-heading">
    <div class="section-heading"><div><p class="eyebrow">Event sequence</p><h3 id="timeline-heading">Timeline</h3></div><p class="muted">Tool detail is collapsed by default. Errors and recovery stay visible.</p></div>
    ${
      items.length === 0
        ? '<p class="empty">No Events indexed for this Run.</p>'
        : `<div class="timeline">${items
            .map((item) => {
              if (item.kind === "event") return renderTimelineEvent(item.event);
              const alert = item.events.some(isAlertEvent);
              const body = item.events.map(renderTimelineEvent).join("");
              const label = groupLabel(item.key, item.events);
              return alert
                ? `<section class="timeline-group timeline-group-alert"><h4>${escapeHtml(label)}</h4>${body}</section>`
                : `<details class="timeline-group"><summary><span class="group-marker">▶</span>${escapeHtml(label)} <span class="muted">(${item.events.length} Events)</span></summary>${body}</details>`;
            })
            .join("")}</div>`
    }
  </section>`;
}

function renderSelectedRun(selected: NonNullable<MonitorPageData["selected"]>): string {
  const { detail, events } = selected;
  const run = detail.run;
  const state = record(detail.state);
  const stateRun = record(state?.run) ?? {};
  const snapshot = record(state?.snapshot);
  const evaluationEnvelope = record(detail.evaluation);
  const evaluation = record(evaluationEnvelope?.evaluation);
  const metrics = record(evaluation?.metrics);
  const correctness = record(evaluation?.correctness);
  const outcome = record(firstValue(stateRun.outcome, correctness?.outcome));
  const verification = firstValue(
    correctness?.verification,
    evaluation?.verification,
    metrics?.verification,
  );
  const review = firstValue(correctness?.review, evaluation?.review, metrics?.review);
  const presentation = runLifecycle(run);
  const blocker = firstValue(stateRun.blocked, stateRun.failure);
  const prominentBlocker =
    presentation.kind === "blocked" || presentation.kind === "recoverable-failed"
      ? `<aside class="blocker-banner" role="alert"><strong>${presentation.label}</strong><span>${escapeHtml(issueText(blocker ?? "A blocker is recorded for this Run."))}</span>${presentation.kind === "recoverable-failed" ? '<span class="recovery">Recovery available: this Run can be resumed.</span>' : ""}</aside>`
      : "";
  const warnings = detail.warnings ?? [];

  return `<section class="run-detail" data-section="run-detail" aria-labelledby="run-detail-heading">
    <p><a href="/">← Back to Runs</a></p>
    <div class="detail-heading"><div><p class="eyebrow">Run Overview</p><h2 id="run-detail-heading">${escapeHtml(run.run_id)}</h2></div><span class="lifecycle-badge lifecycle-${presentation.kind}" data-lifecycle="${presentation.kind}">${presentation.label}</span></div>
    ${prominentBlocker}
    ${warnings.map((warning) => `<p class="warning">${escapeHtml(warning)}</p>`).join("")}
    <section class="panel" data-section="overview-facts" aria-labelledby="overview-facts-heading"><h3 id="overview-facts-heading">Current information</h3>${renderOverviewFacts(run, stateRun, snapshot, verification, review)}</section>
    ${renderCorrectness(run, outcome, correctness, verification, review)}
    ${renderEfficiency(run, evaluation, metrics)}
    ${renderTimeline(events)}
  </section>`;
}

const PAGE_STYLE = `
:root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; background: #f4f6f8; color: #17202a; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; }
a { color: #1257a6; }
main { max-width: 1440px; margin: 0 auto; padding: 24px; }
.site-header { background: #17202a; color: #fff; padding: 24px max(24px, calc((100% - 1440px) / 2 + 24px)); }
.site-header h1 { margin: 0 0 4px; font-size: 1.75rem; }
.site-header p { margin: 0; color: #c9d2dc; }
.panel, .priority-panel { background: #fff; border: 1px solid #d8dee5; border-radius: 10px; padding: 20px; margin: 0 0 20px; box-shadow: 0 2px 8px #17202a0d; }
.section-heading, .detail-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.section-heading h2, .section-heading h3, .detail-heading h2, .panel h3, .priority-panel h3 { margin: 0; }
.eyebrow { margin: 0 0 4px; color: #637282; font-size: .75rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.filters { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; }
.filters label { display: grid; gap: 4px; color: #536170; font-size: .8rem; }
input, select, button { border: 1px solid #b8c2cc; border-radius: 6px; padding: 7px 9px; background: #fff; color: inherit; font: inherit; }
button { cursor: pointer; background: #1257a6; border-color: #1257a6; color: #fff; font-weight: 700; }
.lifecycle-legend { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; margin: 16px 0; padding: 0; }
.lifecycle-badge { display: inline-block; border: 1px solid; border-radius: 999px; padding: 3px 9px; font-size: .78rem; font-weight: 700; white-space: nowrap; }
.lifecycle-running { background: #e5f1ff; border-color: #4b91d1; color: #124c80; }
.lifecycle-blocked { background: #fff3d7; border-color: #d99200; color: #754900; }
.lifecycle-recoverable-failed { background: #ffe8c7; border-color: #df6f00; color: #783400; }
.lifecycle-final-failed { background: #ffe0e0; border-color: #cf3f3f; color: #851d1d; }
.lifecycle-completed { background: #e0f5e8; border-color: #36945c; color: #176235; }
.lifecycle-cancelled { background: #edf0f3; border-color: #87929e; color: #48535f; }
.lifecycle-created { background: #eee8ff; border-color: #8068c7; color: #4a348b; }
.lifecycle-failed-unknown, .lifecycle-unavailable { background: #f2f2f2; border-color: #777; color: #333; }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th, td { border-bottom: 1px solid #e2e7ec; padding: 10px 8px; text-align: left; vertical-align: top; }
th { color: #536170; font-size: .78rem; white-space: nowrap; }
.run-row:hover, .run-row[aria-current="true"] { background: #f4f8fc; }
.telemetry { font-weight: 700; }
.telemetry-healthy { color: #176235; }
.telemetry-degraded, .telemetry-unknown { color: #9a5700; }
.muted { color: #687582; font-size: .88em; }
.empty { padding: 18px 0; color: #687582; }
.run-detail { max-width: 1100px; margin: 0 auto; }
.detail-heading { align-items: center; margin-bottom: 16px; }
.blocker-banner { display: grid; gap: 4px; border: 2px solid #d99200; border-radius: 8px; background: #fff3d7; color: #754900; margin: 0 0 20px; padding: 14px 16px; }
.blocker-banner .recovery { font-weight: 700; }
.warning { border-left: 4px solid #d99200; background: #fff8e9; margin: 12px 0; padding: 10px 12px; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 14px 0 0; }
.fact { min-width: 0; border: 1px solid #e2e7ec; border-radius: 7px; padding: 10px; }
.fact dt { color: #536170; font-size: .78rem; font-weight: 700; }
.fact dd { margin: 5px 0 0; overflow-wrap: anywhere; }
code { white-space: pre-wrap; word-break: break-word; }
.correctness { border-top: 5px solid #176235; }
.efficiency { border-top: 5px solid #536170; }
.timeline { border-left: 3px solid #cbd4dc; margin: 16px 0 0 8px; padding-left: 16px; }
.timeline-event, .timeline-tool, .timeline-group { margin: 0 0 10px; }
.timeline-event, .timeline-tool, .timeline-group > summary { border: 1px solid #d8dee5; border-radius: 7px; background: #fbfcfd; padding: 10px 12px; }
.timeline-event-alert { border-color: #cf3f3f; background: #fff1f1; }
.timeline-event-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 9px; }
.event-sequence { min-width: 32px; color: #1257a6; font-family: ui-monospace, monospace; font-weight: 700; }
.timeline-event-head time { color: #687582; font-size: .8rem; }
.event-details { margin-top: 8px; }
.event-details summary, .timeline-tool summary, .timeline-group summary { cursor: pointer; }
.timeline-tool { padding: 0; }
.timeline-tool summary { list-style: none; padding: 10px 12px; }
.timeline-tool summary::-webkit-details-marker { display: none; }
.timeline-tool .event-details { border-top: 1px solid #d8dee5; margin: 0; padding: 0 12px 10px; }
.timeline-group { padding: 0; }
.timeline-group > summary { list-style: none; font-weight: 700; }
.timeline-group > summary::-webkit-details-marker { display: none; }
.group-marker { display: inline-block; margin-right: 6px; }
.timeline-group-alert { border-left: 4px solid #cf3f3f; padding-left: 10px; }
.timeline-group-alert h4 { margin: 0 0 8px; }
@media (max-width: 760px) { main { padding: 14px; } .section-heading, .detail-heading { display: block; } .filters { margin-top: 14px; } .filters label, .filters input, .filters select, .filters button { width: 100%; } }
`;

export function renderMonitorPage(data: MonitorPageData): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Workflow Monitor</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <header class="site-header"><h1>Workflow Monitor</h1><p>Read-only Run monitoring</p></header>
  <main>
    ${renderRunList(data)}
    ${data.selected === undefined ? "" : renderSelectedRun(data.selected)}
  </main>
</body>
</html>`;
}

export type { MonitorEvent, MonitorRunDetail };
