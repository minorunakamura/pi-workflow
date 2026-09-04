# Observability and Evaluation

## Purpose

This document defines Event semantics, Event taxonomy, correlation/causality, telemetry levels and quality, deterministic runtime metrics, evaluation records, evaluation dimensions, and fair Run comparison.

Event physical storage is defined in `06-persistence-and-artifacts.md#event-log-storage`.

## Observability vs Evaluation

```text
State       → what is true now
Event       → what happened
Telemetry   → what was observed/measured
Evaluation  → what those observations imply for workflow quality
```

> **Invariant**
>
> Events are observability history, not Event Sourcing. Current Workflow State MUST NOT be reconstructed from Events.

Evaluation is derived and MUST NOT mutate Workflow State.

## Event Semantics

All Events use a common envelope containing schema version, Run-local Event ID, monotonic sequence, type, offset-aware timestamp, Run ID, source component, optional actor, current committed state revision, optional primary correlation ID, optional direct `caused_by`, and compact type-specific data.

### Ordering

- **MUST:** Event `sequence` define write order.
- **MUST NOT:** Timestamp be used as authoritative ordering.
- **MUST:** State-mutating Events reference the newly committed state revision.
- **SHOULD:** Non-state Events reference the currently observed committed revision.

State is committed before state-transition Events are appended. Therefore a crash may leave committed state with missing Event history; that is accepted and does not invalidate state correctness.

## Correlation

`correlation_id` groups one primary activity, usually:

```text
exec-*
D-*
U-*
G-*
F-*
CS-*
VR-*
RR-*
<run-id>
```

One string is used as the primary correlation; additional related entities are carried in Event data references.

## Causality

`caused_by.event_id` is optional direct causality, for example:

```text
verification.completed
    ↓ caused_by
gate.failed
    ↓ caused_by
graph.step-added
```

The system does not attempt to persist a complete causal hypergraph. One primary cause plus related refs is sufficient.

## Event Taxonomy

Phase 1 canonical Event types:

### Run

```text
run.created
run.started
run.blocked
run.unblocked
run.failed
run.resumed
run.cancel-requested
run.cancelled
run.completed
```

There is no separate `run.finalized` Event; `finalized` is authoritative state.

### Request / Requirement

```text
request.received
request.amended
requirement.created
requirement.revised
```

Requirement Events record revision/delta references, not the full Requirement body.

### Playbook / Graph

```text
playbook.selected
playbook.switched
graph.step-added
```

Initial base Steps do not require individual `step.created` Events. `graph.revision-changed` is not required.

### Step

```text
step.started
step.blocked
step.completed
step.failed
step.skipped
```

`step.ready` is intentionally omitted to avoid noisy derived-state transitions.

### Execution

```text
execution.started
execution.completed
execution.blocked
execution.failed
execution.interrupted
```

### Model / Skill / Tool

```text
model.resolved
model.fallback
skill.used
skill.requested
tool.started
tool.completed
tool.failed
```

Tool Events remain compact and do not contain full args/results in Standard telemetry.

### Artifact

```text
artifact.finalized
```

Staging/validation phases are not normal timeline Events.

### Uncertainty

```text
uncertainty.created
uncertainty.resolving
uncertainty.resolved
uncertainty.accepted
uncertainty.escalated
```

### Decision

```text
decision.created
decision.resolved
decision.superseded
```

### Gate

```text
gate.created
gate.passed
gate.failed
gate.superseded
```

Repeated `waiting → waiting` evaluation emits no lifecycle Event.

### Plan / Change Set

```text
plan.created
plan.applicability-changed
change-set.created
change-set.relevance-changed
```

Re-plan is represented by a new `plan.created` with reason/previous-version metadata rather than a separate required Event type.

### Verification / Review

```text
verification.completed
verification.invalidated
review.completed
review.invalidated
```

Individual `V-*` check passed/failed Events are not required; details live in the Verification Run.

### Finding

```text
finding.created
finding.disposition-changed
finding.severity-changed
finding.reopened
```

Reopen is explicit because it is a meaningful review-quality signal.

### Repository

```text
repository.drift.detected
repository.drift.reconciled
```

Repository snapshot capture itself is runtime evidence, not a mandatory Event.

### Error

```text
error.occurred
error.recovered
error.escalated
```

Expected domain outcomes such as test assertion failure are not automatically Error Events.

## Event Noise Policy

The Event log records meaningful domain transitions and operational measurements, not every internal function call.

Do not emit normal Events for:

```text
scheduler polling
gate waiting→waiting reevaluation
Context Builder reads
artifact staging start
snapshot captured
state validation passed
unchanged ready recomputation
```

Tool calls are more granular because they are important for cost/context/efficiency evaluation.

## Event Reliability

Event append is best-effort observability. It is not part of state correctness.

- partial Event batches are tolerated;
- Event exactly-once is not a Phase 1 correctness requirement;
- failed state-transition Event append is not replayed by reconstructing state history;
- corrupt Event lines are skipped by readers and surfaced as degraded telemetry rather than blocking Run resume.

## Telemetry Levels

### `minimal`

Contains major Run/Step/Execution lifecycle, Outcome/control transitions, errors, and aggregate execution usage where available.

### `standard`

Default for workflow evaluation. Adds Tool/Skill/Model, Context metrics, Artifact events, freshness invalidations, and repository drift information.

### `debug`

Standard plus additional redacted runtime diagnostics stored primarily under `runtime/debug/`; the Event log itself remains compact.

## Telemetry Quality

Evaluation records expose:

```text
healthy | degraded | insufficient
```

`healthy` means no known telemetry defect, not mathematical proof of perfect completeness.

Examples of degraded telemetry:

- `run.yaml.telemetry.degraded=true`;
- Event sequence gaps/corruption;
- missing provider usage for some executions;
- truncated/incomplete operational measurements.

> **Invariant**
>
> Missing telemetry MUST NOT be silently converted to zero.

Example:

```yaml
tools:
  calls_count: null  # not collected under this telemetry level
```

is different from:

```yaml
tools:
  calls_count: 0     # collected and no calls occurred
```

## Runtime Metrics

### Timing

Base metrics include:

```text
wall_clock_ms
active_wall_ms
blocked_ms
execution_sum_ms
tool_sum_ms (optional)
```

`execution_sum_ms` is deliberately separate from active wall time so Phase 2 parallel execution remains measurable.

### LLM Usage

Provider-reported fields where available:

```text
input_tokens
output_tokens
cached_input_tokens
reasoning_tokens
```

Usage may be aggregated by Agent and by provider/model.

Reported cost may be stored only when the provider supplies it. The runtime MUST NOT hard-code a pricing table to synthesize authoritative cost.

### Context

Context metrics include:

```text
pack_tokens_estimated_total
pack_tokens_estimated_peak
trim_count
budget_exceeded_count
required_context_missing_count
control_plane_context_peak_tokens (optional if measurable)
```

Context Pack token estimates are distinct from provider input-token usage. `tokens_saved` is not a Phase 1 metric because it requires an unobservable counterfactual baseline.

### Orchestration

Representative base metrics:

```text
base_steps_count
dynamic_steps_count
skipped_steps_count
executions_count
retry_executions_count
replans_count
playbook_switches_count
fix_cycles_count
reverification_count
rereview_count
gate_failures_count
gate_superseded_count
escalations_count
recoverable_failures_count
resumes_count
no_progress_count
```

A retry is an additional Execution for the same Step. A dynamic Fix Step is not a retry.

### Skills and Tools

Track actual `skill.used`, not merely selected Skills. Tool metrics may aggregate both capability category and concrete tool name.

### Uncertainty and Decisions

Track creation/resolution/acceptance/escalation and resolution attempts. `uncertainty.resolved` records the validated resolution evidence references. Track D1/D2/D3 Decisions, supersession, and user/Orchestrator resolution where meaningful.

Counts alone MUST NOT be interpreted as quality judgments without request context.

### Implementation

Representative metrics:

```text
change_sets_count
partial_change_sets_count
noop_change_sets_count
relevance_changes_count
plan_deviations_count
write_scope_violations_count
attribution_uncertainty_count
preexisting_change_loss_count
```

Files/LOC may be displayed but are not core quality-score inputs.

### Verification

```text
runs_count
invalidations_count
reverifications_count
checks.passed_count
checks.failed_count
checks.skipped_count
checks.unavailable_count
accepted_limitations_count
final VR/result/freshness/strength
```

### Review

```text
runs_count
invalidations_count
rereviews_count
findings_created_count
findings_reopened_count
findings_by_severity
final disposition counts
```

Finding count by itself is not a Reviewer-quality score.

### Repository

```text
drift_detected_count
drift_reconciled_count
drift_by_classification
external_reconciliations_count
```

### Outcome

Finalized Runs expose status, `request_satisfied`, final Requirement revision, AC/Constraint evaluation summary, accepted risks/limitations, and Investigation conclusion where applicable.

## Run Metrics Aggregator

`RunMetricsAggregator` is deterministic and LLM-free. It reads authoritative state/outcome, Event history, and required Artifact metadata to produce base metrics.

Same source data and aggregator version MUST produce the same metrics.

## Run Evaluation Record

Evaluation is derived/rebuildable and is not a Semantic Run Artifact.

Representative shape:

```yaml
evaluation_schema_version: 1
evaluator_version: 1
run_id: <run-id>
evaluation_status: provisional | final
source:
  state_revision: 72
  last_event_sequence: 284
  finalized: true
telemetry_quality:
  status: healthy
  telemetry_level: standard
comparison: {}
metrics: {}
```

`final` means the source Run is finalized and the record was computed from its terminal source data; the evaluation itself may be recomputed by a newer evaluator version.

## Evaluation Dimensions

Six lenses organize the evidence:

```text
correctness
efficiency
context-efficiency
decision-quality
review-quality
orchestration-quality
```

These are evidence lenses, not opaque scalar grades.

> **Invariant**
>
> Phase 1 MUST NOT require or present one combined 0–100 workflow score or automatic winner based on one scalar.

### Correctness

Uses request satisfaction, AC/Constraint status, final Verification, final Review/Findings, and accepted limitations/risks. It represents workflow-contract correctness evidence, not proof of a bug-free system.

### Efficiency

Uses time, execution count, tools, retries, re-plans, and fix cycles. More work is not automatically worse; task difficulty matters.

### Context Efficiency

Uses provider tokens, Context Pack estimates, peak context, trimming/errors, and optionally Control Plane context measurements.

### Decision Quality

Uses supersession, re-plan causality, Oracle use, approvals, and decision stability. D2/D3 counts alone are not negative signals.

### Review Quality

Uses severity, dismissal, reopen, re-review, and Finding lifecycle. Zero Findings alone is not evidence of high review quality.

### Orchestration Quality

Uses dynamic Steps, Gates, re-plans, switches, escalations, recovery, drift handling, and no-progress events. Dynamic work may be correct for uncertain requests.

## Comparison Metadata

Fair comparison records at least:

```text
request ID/type
repository baseline
workflow version
initial/final Playbook version
effective config fingerprint
model/provider usage
Agent/Skill versions
final Requirement revision
telemetry level/quality
optional comparison group/variant
```

Effective-config fingerprints use canonical redacted configuration.

## Fair Comparison

Primary rule: compare the same or meaningfully similar workload.

The Monitoring UI SHOULD show comparability warnings for:

```text
different request/requirement fingerprint
different repository baseline
different model/provider/thinking
different workflow/config version
different telemetry level/quality
```

Phase 1 comparison SHOULD be side-by-side metrics and deltas. Correctness/risk evidence appears before token/time efficiency. No automatic winner is required.
