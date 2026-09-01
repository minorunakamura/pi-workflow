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

export type MonitorGraph = Readonly<{
  run_id: string;
  graph_revision: number | null;
  nodes: readonly JsonRecord[];
  edges: readonly JsonRecord[];
  gates: readonly JsonRecord[];
  warnings?: readonly string[];
}>;

export type MonitorArtifactView = Readonly<{
  artifact: JsonRecord;
  content: Readonly<{
    front_matter: unknown;
    body: string;
  }>;
}>;

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
    graph?: MonitorGraph;
    artifacts?: readonly JsonRecord[];
    artifact?: MonitorArtifactView;
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
  "finding.created": "Finding created",
  "finding.disposition-changed": "Finding disposition changed",
  "finding.severity-changed": "Finding severity changed",
  "finding.reopened": "Finding reopened",
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

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
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

function htmlFieldRow(label: string, markup: string): string {
  return `<div class="fact"><dt>${escapeHtml(label)}</dt><dd>${markup}</dd></div>`;
}

function apiStepHref(runId: string, stepId: string): string {
  return `/api/v1/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}`;
}

function apiExecutionHref(runId: string, executionId: string): string {
  return `/api/v1/runs/${encodeURIComponent(runId)}/executions/${encodeURIComponent(executionId)}`;
}

function artifactPageHref(runId: string, path: string): string {
  return `/?run=${encodeURIComponent(runId)}&artifact=${encodeURIComponent(path)}`;
}

function artifactApiHref(runId: string, path: string): string {
  return `/api/v1/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(path)}`;
}

function identifierLinks(runId: string, value: unknown, kind: "step" | "execution"): string {
  const ids = arrayValue(value)
    .map(text)
    .filter((id): id is string => id !== null);
  if (ids.length === 0) return '<span class="muted">-</span>';
  return ids
    .map((id) => {
      const href = kind === "step" ? apiStepHref(runId, id) : apiExecutionHref(runId, id);
      return `<a href="${escapeHtml(href)}">${escapeHtml(id)}</a>`;
    })
    .join(", ");
}

function attemptLinks(runId: string, value: unknown): string {
  const attempts = arrayValue(value);
  if (attempts.length === 0) return '<span class="muted">-</span>';
  return attempts
    .map((attempt) => {
      const entry = record(attempt);
      const id = text(entry?.id);
      const status = text(entry?.status);
      const label =
        id === null
          ? valueMarkup(attempt)
          : `<a href="${escapeHtml(apiExecutionHref(runId, id))}">${escapeHtml(id)}</a>`;
      return `${label}${status === null ? "" : ` <span class="muted">(${escapeHtml(status)})</span>`}`;
    })
    .join(", ");
}

function attemptComparison(value: unknown): string {
  const attempts = arrayValue(value);
  if (attempts.length < 2) return "";
  return `<table class="attempt-comparison"><caption>Attempt comparison</caption><thead><tr><th scope="col">Attempt</th><th scope="col">Model</th><th scope="col">Result</th><th scope="col">Duration</th><th scope="col">Tokens</th></tr></thead><tbody>${attempts
    .map((attempt) => {
      const entry = record(attempt) ?? {};
      const timing = record(entry.timing);
      return `<tr><td>${valueMarkup(entry.attempt)}</td><td>${valueMarkup(entry.model ?? entry.provider)}</td><td>${valueMarkup(entry.result ?? entry.status)}</td><td>${valueMarkup(timing?.wall_clock_ms ?? timing?.duration_ms ?? timing?.duration)}</td><td>${valueMarkup(entry.tokens)}</td></tr>`;
    })
    .join("")}</tbody></table>`;
}

function artifactLinks(runId: string, value: unknown): string {
  const artifacts = arrayValue(value);
  if (artifacts.length === 0) return '<span class="muted">-</span>';
  return artifacts
    .map((artifact) => {
      const entry = record(artifact);
      const path = text(entry?.path);
      return path === null
        ? valueMarkup(artifact)
        : `<a href="${escapeHtml(artifactPageHref(runId, path))}">${escapeHtml(path)}</a>`;
    })
    .join(", ");
}

function collectRelatedIds(value: unknown, prefix: "U" | "D" | "G" | "F", ids: Set<string>): void {
  if (typeof value === "string") {
    if (new RegExp(`^${prefix}-\\d+$`).test(value)) ids.add(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectRelatedIds(entry, prefix, ids));
    return;
  }
  const entry = record(value);
  if (entry !== undefined) {
    Object.values(entry).forEach((nested) => collectRelatedIds(nested, prefix, ids));
  }
}

function relatedEntityMarkup(step: JsonRecord): string {
  const sources = [
    step.related,
    record(step.metadata)?.related,
    record(step.metadata)?.related_ids,
    step.inputs,
    step.outputs,
    step.blocked_by,
    step.result,
  ];
  const groups = (["U", "D", "G", "F"] as const).map((prefix) => {
    const ids = new Set<string>();
    sources.forEach((source) => collectRelatedIds(source, prefix, ids));
    return ids.size === 0 ? null : `${prefix}: ${[...ids].sort().join(", ")}`;
  });
  return (
    groups.filter((group): group is string => group !== null).join(" · ") ||
    '<span class="muted">-</span>'
  );
}

function renderStepDetail(runId: string, step: JsonRecord): string {
  const id = text(step.id) ?? "-";
  const origin = text(step.origin) ?? "unknown";
  const trigger = text(step.trigger);
  const skipReason = text(step.skip_reason);
  const href = id === "-" ? "#" : apiStepHref(runId, id);
  const annotations = [
    `<span class="step-origin">${escapeHtml(origin)}</span>`,
    trigger === null ? "" : `<span class="step-trigger">trigger: ${escapeHtml(trigger)}</span>`,
    skipReason === null
      ? ""
      : `<span class="step-skip-reason">skip: ${escapeHtml(skipReason)}</span>`,
  ].join(" ");

  return `<details class="step-detail" data-graph-kind="step" data-step-id="${escapeHtml(id)}">
    <summary><span class="step-summary-title"><a href="${escapeHtml(href)}">${escapeHtml(id)}</a> <span class="step-status">${escapeHtml(text(step.status) ?? "unknown")}</span></span>${annotations}</summary>
    <dl class="facts step-facts">
      ${fieldRow("Objective", step.objective)}
      ${fieldRow("Agent / Skills", { agent: step.agent, skills: step.skills })}
      ${htmlFieldRow("Dependencies", identifierLinks(runId, step.depends_on, "step"))}
      ${fieldRow("Completion Criteria", step.completion_criteria)}
      ${fieldRow("Status", step.status)}
      ${htmlFieldRow("Attempts", attemptLinks(runId, step.attempts))}
      ${htmlFieldRow("Artifacts", artifactLinks(runId, step.artifacts))}
      ${fieldRow("Blockers", step.blocked_by)}
      ${htmlFieldRow("Related U/D/G/F", relatedEntityMarkup(step))}
      ${fieldRow("Origin", origin)}
      ${fieldRow("Dynamic trigger", trigger)}
      ${fieldRow("Skip reason", skipReason)}
    </dl>
    ${attemptComparison(step.attempts)}
    <p class="muted"><a href="${escapeHtml(href)}">Open Step detail API</a></p>
  </details>`;
}

function renderExecutionGraph(runId: string, graph: MonitorGraph): string {
  const nodes = graph.nodes
    .map((node) => record(node))
    .filter((node): node is JsonRecord => node !== undefined);
  const edges = graph.edges
    .map((edge) => record(edge))
    .filter((edge): edge is JsonRecord => edge !== undefined);
  const gates = graph.gates
    .map((gate) => record(gate))
    .filter((gate): gate is JsonRecord => gate !== undefined);
  const warnings = graph.warnings ?? [];
  return `<section class="panel" id="execution-graph" data-section="execution-graph" aria-labelledby="execution-graph-heading">
    <div class="section-heading"><div><p class="eyebrow">Steps and dependencies</p><h3 id="execution-graph-heading">Execution graph</h3></div><span class="muted">Graph revision ${escapeHtml(jsonText(graph.graph_revision))}</span></div>
    <p class="muted">Nodes are Steps. Edges use <code>depends_on</code>. Gates are annotations, not graph nodes.</p>
    ${warnings.map((warning) => `<p class="warning">${escapeHtml(warning)}</p>`).join("")}
    <div class="step-graph" aria-label="Step graph">${nodes.length === 0 ? '<p class="empty">No Steps indexed for this Run.</p>' : nodes.map((node) => renderStepDetail(runId, node)).join("")}</div>
    <section class="graph-edges" aria-labelledby="graph-edges-heading"><h4 id="graph-edges-heading">depends_on edges</h4>${edges.length === 0 ? '<p class="muted">No dependency edges.</p>' : `<ul>${edges.map((edge) => `<li><a href="${escapeHtml(apiStepHref(runId, text(edge.source) ?? ""))}">${escapeHtml(text(edge.source) ?? "-")}</a> → <a href="${escapeHtml(apiStepHref(runId, text(edge.target) ?? ""))}">${escapeHtml(text(edge.target) ?? "-")}</a></li>`).join("")}</ul>`}</section>
    <section class="gate-annotations" aria-labelledby="gate-annotations-heading"><h4 id="gate-annotations-heading">Gate annotations</h4>${gates.length === 0 ? '<p class="muted">No Gate annotations.</p>' : `<ul>${gates.map((gate) => `<li data-graph-kind="gate-annotation"><span class="gate-diamond" aria-hidden="true">◇</span><strong>${escapeHtml(text(gate.id) ?? "Gate")}</strong> <span>${escapeHtml(text(gate.type) ?? "unknown")}</span> <span class="muted">${escapeHtml(text(gate.status) ?? "unknown")}</span></li>`).join("")}</ul>`}</section>
  </section>`;
}

function renderArtifactBody(selected: MonitorArtifactView): string {
  return `<section class="artifact-content" data-section="artifact-body" aria-labelledby="artifact-body-heading"><h4 id="artifact-body-heading">Loaded Markdown body</h4><p class="muted">Displayed as escaped raw Markdown; HTML in an Artifact is not executed.</p>${fieldRow("Front matter", selected.content.front_matter)}<pre class="artifact-body"><code>${escapeHtml(selected.content.body)}</code></pre></section>`;
}

function renderArtifacts(
  runId: string,
  artifacts: readonly JsonRecord[],
  selected: MonitorArtifactView | undefined,
): string {
  const selectedPath = text(selected?.artifact.path);
  return `<section class="panel" id="artifact-viewer" data-section="artifact-viewer" aria-labelledby="artifact-viewer-heading">
    <div class="section-heading"><div><p class="eyebrow">Lazy content view</p><h3 id="artifact-viewer-heading">Artifact Viewer</h3></div><span class="muted">Metadata and Handoff Summary load before body</span></div>
    <div class="artifact-list">${
      artifacts.length === 0
        ? '<p class="empty">No Artifacts indexed for this Run.</p>'
        : artifacts
            .map((artifact) => {
              const path = text(artifact.path);
              const isSelected = path !== null && path === selectedPath;
              const bodyLink = path === null ? "#" : artifactPageHref(runId, path);
              const apiLink = path === null ? "#" : artifactApiHref(runId, path);
              return `<article class="artifact-card${isSelected ? " artifact-card-selected" : ""}" data-artifact-path="${escapeHtml(path ?? "")}"><h4>${escapeHtml(path ?? "Artifact")}</h4><dl class="facts artifact-facts">${fieldRow("Type", artifact.type)}${fieldRow("Status", artifact.status)}${fieldRow("Step", artifact.step_id)}${fieldRow("Execution", artifact.execution_id)}${fieldRow("Handoff Summary", artifact.handoff_summary)}${fieldRow("Metadata", artifact.metadata)}</dl><p><a href="${escapeHtml(bodyLink)}">Load body in viewer</a>${path === null ? "" : ` · <a href="${escapeHtml(apiLink)}">Artifact API</a>`}</p></article>`;
            })
            .join("")
    }</div>
    ${selected === undefined ? '<p class="muted">Artifact bodies are not loaded until a body link is selected.</p>' : renderArtifactBody(selected)}
  </section>`;
}

function evidenceValue(root: JsonRecord | undefined, ...names: string[]): unknown {
  return firstValue(...names.map((name) => root?.[name]));
}

function renderVerificationDetail(verification: unknown): string {
  const root = record(verification);
  return `<section class="panel evidence-detail" data-section="verification-detail" data-evidence-kind="VR" aria-labelledby="verification-detail-heading"><p class="eyebrow">VR</p><h3 id="verification-detail-heading">Verification detail</h3><dl class="facts">${fieldRow("VR result", evidenceValue(root, "result", "status") ?? verification)}${fieldRow("Strength", evidenceValue(root, "strength"))}${fieldRow("Derived freshness", evidenceValue(root, "derived_freshness", "freshness"))}${fieldRow("Basis", evidenceValue(root, "basis"))}${fieldRow("Checks", evidenceValue(root, "checks"))}${fieldRow("Limitations", evidenceValue(root, "limitations", "accepted_limitations"))}${fieldRow("Evidence refs", evidenceValue(root, "evidence_refs", "evidence"))}</dl></section>`;
}

function renderReviewDetail(review: unknown): string {
  const root = record(review);
  return `<section class="panel evidence-detail" data-section="review-detail" data-evidence-kind="RR" aria-labelledby="review-detail-heading"><p class="eyebrow">RR</p><h3 id="review-detail-heading">Review detail</h3><dl class="facts">${fieldRow("RR result", evidenceValue(root, "result", "status") ?? review)}${fieldRow("Freshness", evidenceValue(root, "freshness", "derived_freshness"))}${fieldRow("Basis", evidenceValue(root, "basis"))}${fieldRow("New Findings", evidenceValue(root, "new_findings", "findings"))}${fieldRow("Rechecks", evidenceValue(root, "rechecks"))}${fieldRow("Observations", evidenceValue(root, "observations"))}</dl></section>`;
}

function eventFindingId(event: MonitorEvent): string | null {
  const data = eventData(event);
  const finding = record(data.finding);
  return text(data.finding_id) ?? text(data.id) ?? text(finding?.finding_id) ?? text(finding?.id);
}

function findingHistory(findingId: string | null, events: readonly MonitorEvent[]): MonitorEvent[] {
  return events.filter((event) => {
    const type = text(event.type) ?? "";
    if (!type.startsWith("finding.") && !type.startsWith("review.")) return false;
    const eventId = eventFindingId(event);
    return eventId === findingId || (eventId === null && type.startsWith("review."));
  });
}

function renderFindings(snapshot: JsonRecord | undefined, events: readonly MonitorEvent[]): string {
  const findings = arrayValue(record(snapshot?.findings)?.findings);
  const content =
    findings.length === 0
      ? '<p class="empty">No current Findings.</p>'
      : findings
          .map((value) => {
            const finding = record(value) ?? {};
            const id = text(finding.id);
            const history = findingHistory(id, events);
            return `<article class="finding-detail" data-finding-id="${escapeHtml(id ?? "")}"><h4>${escapeHtml(id ?? "Finding")}</h4><dl class="facts">${fieldRow("State", finding.state)}${fieldRow("Disposition", finding.disposition)}${fieldRow("Severity", finding.severity)}${fieldRow("Confidence", finding.confidence)}</dl><details class="finding-history"><summary>Review/Event lifecycle history (${history.length})</summary>${history.length === 0 ? '<p class="muted">No lifecycle events indexed for this Finding.</p>' : history.map(renderTimelineEvent).join("")}</details></article>`;
          })
          .join("");
  const unassignedHistory =
    findings.length === 0
      ? events.filter((event) => {
          const type = text(event.type) ?? "";
          return type.startsWith("finding.") || type.startsWith("review.");
        })
      : [];
  return `<section class="panel evidence-detail" data-section="finding-detail" data-evidence-kind="F" aria-labelledby="finding-detail-heading"><p class="eyebrow">F</p><h3 id="finding-detail-heading">Finding detail</h3>${content}${unassignedHistory.length === 0 ? "" : `<details class="finding-history"><summary>Review/Event lifecycle history (${unassignedHistory.length})</summary>${unassignedHistory.map(renderTimelineEvent).join("")}</details>`}</section>`;
}

function renderEvidenceDetails(
  verification: unknown,
  review: unknown,
  snapshot: JsonRecord | undefined,
  events: readonly MonitorEvent[],
): string {
  return `${renderVerificationDetail(verification)}${renderReviewDetail(review)}${renderFindings(snapshot, events)}`;
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
  const { detail, events, artifact } = selected;
  const graph = selected.graph;
  const artifacts = selected.artifacts ?? [];
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
    ${renderEvidenceDetails(verification, review, snapshot, events)}
    ${renderEfficiency(run, evaluation, metrics)}
    ${graph === undefined ? "" : renderExecutionGraph(run.run_id, graph)}
    ${renderArtifacts(run.run_id, artifacts, artifact)}
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
.step-graph { display: grid; gap: 10px; margin-top: 16px; }
.step-detail { border: 1px solid #d8dee5; border-left: 4px solid #1257a6; border-radius: 7px; background: #fbfcfd; }
.step-detail > summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; cursor: pointer; padding: 10px 12px; }
.step-detail[open] > summary { border-bottom: 1px solid #d8dee5; }
.step-summary-title { display: inline-flex; align-items: baseline; gap: 8px; font-weight: 700; }
.step-status, .step-origin, .step-trigger, .step-skip-reason { border-radius: 999px; padding: 2px 7px; background: #edf0f3; color: #48535f; font-size: .78rem; }
.step-trigger { background: #eee8ff; color: #4a348b; }
.step-skip-reason { background: #fff3d7; color: #754900; }
.step-facts { padding: 0 12px 12px; }
.step-detail > p { padding: 0 12px 10px; }
.attempt-comparison { margin: 0 12px 14px; width: calc(100% - 24px); }
.attempt-comparison caption { text-align: left; color: #536170; font-size: .78rem; font-weight: 700; padding: 8px 0; }
.graph-edges, .gate-annotations { margin-top: 18px; border-top: 1px solid #e2e7ec; padding-top: 12px; }
.graph-edges h4, .gate-annotations h4 { margin: 0 0 8px; }
.graph-edges ul, .gate-annotations ul { margin: 0; padding-left: 22px; }
.gate-annotations li { margin: 6px 0; }
.gate-diamond { display: inline-block; color: #8068c7; font-size: 1.2rem; margin-right: 4px; }
.artifact-list { display: grid; gap: 12px; margin-top: 16px; }
.artifact-card { border: 1px solid #d8dee5; border-radius: 7px; padding: 12px; background: #fbfcfd; }
.artifact-card-selected { border-color: #1257a6; box-shadow: 0 0 0 2px #1257a633; }
.artifact-card h4, .finding-detail h4 { margin: 0; overflow-wrap: anywhere; }
.artifact-facts { margin-top: 10px; }
.artifact-content { margin-top: 20px; border-top: 2px solid #1257a6; padding-top: 14px; }
.artifact-body { display: block; max-height: 34rem; overflow: auto; margin: 14px 0 0; border: 1px solid #d8dee5; border-radius: 7px; background: #17202a; color: #f4f6f8; padding: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
.evidence-detail { border-left: 5px solid #8068c7; }
.evidence-detail h3 { margin-bottom: 4px; }
.finding-detail { border-top: 1px solid #e2e7ec; margin-top: 14px; padding-top: 14px; }
.finding-history { margin-top: 12px; }
.finding-history > summary { cursor: pointer; font-weight: 700; }
.timeline {  border-left: 3px solid #cbd4dc; margin: 16px 0 0 8px; padding-left: 16px; }
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
