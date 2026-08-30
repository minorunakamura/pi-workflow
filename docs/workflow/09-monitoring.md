# Monitoring

## Purpose

This document defines the local read-only Monitoring and Evaluation application that discovers Runs, builds a rebuildable SQLite projection, exposes read-only APIs/live updates, and renders Run state, graph, timeline, evidence, evaluation, and comparison.

## Read-only Boundary

> **Invariant**
>
> Monitoring MUST NOT mutate authoritative Workflow State, Artifacts, Events, repository source, Decisions, Findings, Gates, or Run lifecycle.

The runtime remains the sole Control Plane. Paths under `.pi/` below belong to the consuming repository; they are not authored Pi Package source:

```text
Workflow Runtime
   │ write
   ▼
<consumer-repository>/.pi/runs/*                      ← authoritative
   │ read only
   ▼
Monitoring Backend
   ├─ Run Discovery / Reader
   ├─ Indexer
   ├─ Metrics Aggregator / Evaluator
   └─ Read-only API / Live Hub
   │
   ▼
Derived SQLite Index            ← rebuildable
   │
   ▼
Local Web UI
```

Monitoring failure MUST NOT change Workflow State or stop the Workflow Runtime.

## Process Boundary

Monitoring SHOULD run as a separate local process so Web/SQLite/UI dependencies and failures do not affect runtime correctness.

Phase 1 monitors one repository root per server instance. A multi-repository/global dashboard is future scope.

## Run Discovery

Default discovery root:

```text
<repository-root>/.pi/runs/
```

A directory is considered a Run candidate only when `run.yaml` exists. Directory name and `run.yaml.run_id` must agree for a valid Run.

Indexer discovery states may include:

```text
valid | degraded | unreadable
```

These are Monitoring/index states, not Workflow Run statuses.

Malformed Runs SHOULD remain visible for troubleshooting rather than silently disappearing.

Discovery uses startup scan, optional filesystem watcher notifications, and periodic lightweight reconciliation. Watcher notifications are hints; polling/revision reconciliation is the reliability fallback.

## Derived SQLite Index

SQLite is recommended for Phase 1 because Run listing/filtering/comparison/aggregation benefits from structured queries.

Example location:

```text
<consumer-repository>/.pi/monitor/index.sqlite
```

> **Invariant**
>
> The SQLite database is a derived projection. Deleting it MUST NOT delete or alter authoritative Run data, and it MUST be rebuildable from `.pi/runs/*`.

Schema incompatibility may be handled by rebuilding rather than maintaining Workflow-grade DB migrations.

## Core Index Tables

Phase 1 core tables:

```text
runs
steps
executions
events
artifacts
findings
evaluations
```

Additional D/U/G projection tables are optional because current snapshot detail can be read on demand.

### `runs`

Representative columns:

```text
run_id
request_id
request_type
status
finalized
initial_playbook
current_playbook
state_revision
graph_revision
created_at
started_at
updated_at
finalized_at
request_satisfied
telemetry_level
telemetry_quality
baseline_head
last_indexed_state_revision
last_indexed_event_sequence
index_status
```

### `steps`

Stores compact current Step metadata: type, Agent, status, mandatory/origin flags, dependencies/order, and current execution reference.

### `executions`

Derived from State/Events and execution metadata:

```text
execution_id
step_id
agent
attempt
status
timing
provider/model/thinking
tokens
```

### `events`

Timeline projection may store envelope fields plus compact payload JSON. The SQLite row is not a second Event source of truth.

### `artifacts`

Stores metadata/path/type/subkind/status/Step/Execution/domain ID and Handoff Summary. Full Markdown bodies SHOULD be read lazily from the Run Store.

### `findings`

Stores current Finding state/disposition/severity/confidence/category and relevant RR references.

### `evaluations`

Caches derived `RunEvaluationRecord` keyed by source state revision/event sequence/evaluator version.

## Incremental Indexing

Indexer tracks:

```text
last_indexed_state_revision
last_indexed_event_sequence
```

If `run.yaml.state_revision` is unchanged, the current snapshot need not be re-parsed. New Events can be tailed after the last indexed sequence.

One Run update SHOULD be committed to SQLite in one DB transaction so the UI does not observe a mixed projection.

A filesystem watcher notification only wakes the indexer. Missed notifications are repaired by periodic reconciliation.

## Pointer-consistent Reads

Monitoring uses the same read-side snapshot consistency contract as the runtime:

```text
read run.yaml → revision N
read snapshot N
re-read/verify run.yaml still points to N
```

If the pointer changes during the read, retry. Monitoring never repairs the Run Store.

## Evaluation Projection

When current State or Event sequence changes, the indexer may recompute the provisional `RunEvaluationRecord`. A finalized Run receives a final evaluation for the current evaluator version.

Evaluation files are not added to authoritative Run directories; the Monitoring index/cache owns these projections.

## API

Phase 1 API SHOULD use an `/api/v1` prefix and read-only DTOs rather than exposing persistence DTOs directly.

### Run List

```text
GET /api/v1/runs
```

Typical filters:

```text
status
request_type
playbook
finalized
date range
telemetry quality
search
limit/cursor
```

### Run Detail

```text
GET /api/v1/runs/:runId
```

Returns compact status/current Step/Plan/changes/repository/blocker/failure/outcome/evaluation summary.

### Current State

```text
GET /api/v1/runs/:runId/state
```

Returns a typed read-model DTO, not raw storage objects by default.

### Execution Graph

```text
GET /api/v1/runs/:runId/graph
```

Nodes are Steps and edges are `depends_on`. Gates are supplied as annotations and MAY be rendered as diamond overlays; they MUST NOT become domain Step nodes.

### Timeline

```text
GET /api/v1/runs/:runId/events
```

Typical query parameters:

```text
after_sequence
type/category
correlation_id
limit
```

Timeline order is Event sequence.

### Step / Execution

```text
GET /api/v1/runs/:runId/steps/:stepId
GET /api/v1/runs/:runId/executions/:executionId
```

Execution detail includes model/usage, selected/used Skills, Tool summary, context manifest summary, artifacts, errors, and outcome. Standard Monitoring does not require the full prompt/context text.

### Artifacts

```text
GET /api/v1/runs/:runId/artifacts
GET /api/v1/runs/:runId/artifact?path=<run-relative-path>
```

Artifact paths MUST be validated as Run-relative. Path traversal, absolute paths, and symlink escape are rejected.

Markdown rendering MUST sanitize raw HTML/script content.

### Verification / Review / Finding

Structured endpoints MAY be exposed for UI convenience:

```text
GET /api/v1/runs/:runId/verification/:vrId
GET /api/v1/runs/:runId/reviews/:rrId
GET /api/v1/runs/:runId/findings/:findingId
```

### Evaluation

```text
GET /api/v1/runs/:runId/evaluation
```

Manual recompute endpoints are not required; the indexer refreshes projections automatically.

### Compare

```text
GET /api/v1/compare?run=<A>&run=<B>
```

MVP compares two Runs and includes comparability metadata plus base metrics/deltas.

### Health

```text
GET /api/v1/health
```

Reports Monitoring DB/indexer/watcher status. Monitoring health is distinct from Workflow runtime health.

## Live Updates

Server-Sent Events (SSE) are recommended because the primary direction is server → browser.

Live notifications SHOULD remain compact, for example:

```json
{
  "type": "run-updated",
  "run_id": "<run-id>",
  "state_revision": 43
}
```

The browser refetches required DTOs when state revision changes. Event-only tool activity may update Timeline without forcing a full Run reload.

SSE disconnect/reconnect MUST be safe; sequence-based Event retrieval and API refetch restore current state. Polling is the fallback.

## Run List UI

Display at least:

```text
Run ID
Request ID/type
Status
Playbook
Current Step
Created/duration
Telemetry health
```

UI MUST distinguish:

```text
Running
Blocked
Recoverable Failed
Final Failed
Completed
Cancelled
```

Recoverable Failed is derived from `status=failed`, `resumable=true`, `finalized=false`.

Active Runs SHOULD be easy to prioritize/filter.

## Run Overview

Show compact current information:

```text
Status / blocker
Current Step
Playbook
Requirement revision
Current Plan/applicability
Current Changes
Repository drift
Verification
Review
Open Findings
Open Decisions/Uncertainties
```

For finalized Runs, correctness evidence appears before efficiency:

```text
request_satisfied
final Verification / Review
accepted risks / limitations
```

For blocked/resumable-failed Runs, the blocker and recovery possibility are prominent.

## Execution Graph

- node = Step;
- edge = `depends_on`;
- dynamic Steps display origin/trigger;
- skipped Steps display skip reason;
- Gates are visual annotations/diamonds rather than graph nodes;
- graph revision may be shown for troubleshooting.

## Timeline

Timeline is Event sequence ordered. Major Events render as human descriptions while raw type/Event ID/state revision remain available in detail.

Execution correlation groups may be collapsible:

```text
▶ Worker exec-015
  ├─ tool calls
  ├─ CS-004
  └─ completed
```

Tool Events SHOULD be collapsed by default. Errors/recovery remain visible.

## Step and Execution Detail

Step detail:

```text
Objective
Agent / Skills
Dependencies
Completion Criteria
Status
Attempts
Artifacts
Blockers
Related U/D/G/F
```

Attempt comparison SHOULD support model/result/duration/token comparison for retries.

## Artifact Viewer

Display Artifact metadata and Handoff Summary before rendered Markdown. A raw Markdown view MAY be provided for troubleshooting.

Artifact content is lazy-loaded and sanitized.

## Verification View

Show:

```text
VR result
strength
Derived freshness
basis
checks
limitations
Evidence refs
```

Current accepted limitations/Decisions may be overlaid without modifying the immutable VR Artifact.

## Review and Finding View

Review view shows result/freshness/basis/new Findings/rechecks/observations. Finding detail combines current `F-*` state with Review/Event lifecycle history including reopen.

## Evaluation View

Organize metrics under:

```text
Outcome / correctness evidence
Timing
LLM / tokens
Context
Orchestration
Skills / Tools
Implementation
Verification
Review
Repository
Telemetry quality
Reproducibility
```

The six evaluation dimensions may be tabs/lenses. A single score/gauge MUST NOT be required.

## Compare View

First display comparability:

```text
same request/requirement?
same repository baseline?
same workflow/config?
same model?
telemetry comparable?
```

Then show:

1. Outcome/correctness evidence;
2. risks/limitations;
3. orchestration behavior;
4. context/tokens;
5. time/tool usage.

Numeric deltas may include percentages only when denominator is valid/non-null/non-zero. Degraded/unavailable metrics are marked not reliably comparable rather than treated as zero.

## Degraded State Handling

Monitoring parser/index errors are not Workflow errors.

Examples:

- corrupt Event line → skip it, warn, continue current state display;
- missing referenced Artifact → prominently show integrity warning, do not repair;
- unreadable current snapshot with readable `run.yaml` → show Run as state-unreadable/degraded;
- orphan Artifact → optional debug view; do not auto-adopt.

## Security

- **MUST:** Bind to `127.0.0.1`/localhost by default.
- **MUST NOT:** Bind to `0.0.0.0` without explicit configuration.
- **MUST:** Constrain filesystem reads to configured repository/Run roots.
- **MUST:** Sanitize rendered Markdown/HTML and use a strict CSP.
- **MUST NOT:** Auto-fetch external URLs embedded in Artifacts.
- **MUST NOT:** Log full sensitive API/Artifact payloads unnecessarily.

Localhost-only Phase 1 does not require authentication. Any future remote bind MUST introduce authentication/authorization.

## Phase 1 MVP

Required:

```text
Run discovery/index
Run List
Run Overview
Execution Graph
Timeline
Step/Execution detail
Artifact viewer
Verification/Review/Finding detail
Evaluation
Two-Run Compare
Live active-Run update
Degraded-state warnings
```

Excluded from Phase 1 core:

```text
Run control from Web UI
remote access
multi-repository dashboard
custom dashboards/formulas
single score/ranking
Artifact editing/deletion
advanced FTS
team collaboration
remote database
```
