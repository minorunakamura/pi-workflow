# Persistence and Artifacts

## Purpose

This document defines the physical Run Store, current-state snapshots, requirement history, immutable semantic Artifacts, Event log storage, runtime evidence, migration, retention, and crash-consistency rules.

Logical entity semantics are defined in `03-domain-model.md`.

## Run Store Layout

The Run Store is created in the **consuming repository**, not inside the installed Pi Package source tree.

Canonical Phase 1 layout:

```text
<consumer-repository>/.pi/runs/<run-id>/
├── run.yaml
├── request.md
├── effective-config.yaml
├── requirements/
│   ├── requirement-v1.yaml
│   └── requirement-v<N>.yaml
├── state/
│   └── snapshots/
│       └── <revision>/
│           ├── manifest.json
│           ├── requirement.yaml
│           ├── steps.yaml
│           ├── uncertainties.yaml
│           ├── decisions.yaml
│           ├── gates.yaml
│           └── findings.yaml
├── analysis/
├── research/
├── decisions/
├── plans/
├── implementation/
├── verification/
│   └── evidence/
├── reviews/
├── failures/
├── events/
│   └── events.jsonl
├── runtime/
│   ├── repository/
│   ├── executions/
│   ├── staging/
│   └── debug/
└── outcome.md              # finalized Runs only
```

> **Invariant**
>
> Current authoritative state is `run.yaml` plus the snapshot pointed to by `run.yaml.state_revision`. Events and historical Artifacts are not a substitute for the current snapshot.

## Current State vs History

- `run.yaml` — discovery/lifecycle/current-pointer/compact-summary record.
- current state snapshot — detailed authoritative current Domain State.
- previous snapshots — immutable state history.
- requirement revisions — immutable Requirement contract history.
- semantic Artifacts — immutable detailed evidence/handoff records.
- Events — append-only observability history.

`run.yaml` MUST NOT be treated as a full copy of all current Domain entities.

## run.yaml

Representative normative groups:

```yaml
schema_version: 1
run_id: <run-id>
request:
  id: <request-id>
  type: feature | bug | hotfix | chore | refactor | investigation
status: running
finalized: false
state_revision: 42
graph_revision: 8
playbook:
  initial: {}
  current: {}
current_step: {}
current_plan: null
current_changes:
  relevant_change_sets: []
  external_reconciliation: null
repository: {}
blocked: null
failure: null
cancellation: null
limits: {}
counters: {}
telemetry:
  degraded: false
outcome: null
timestamps: {}
```

`current_plan.applicability.status` may be:

```text
current | compatible | replan-required | unknown
```

It MUST NOT be `superseded`; a superseded Plan is historical and no longer the current Plan.

Counters use `*_last_issued` semantics; gaps are allowed. `failure_record_last_issued` may be included for crash-safe failure filename allocation.

## State Snapshots

Each snapshot contains exactly six authoritative domain-state files plus the manifest:

```text
requirement.yaml
steps.yaml
uncertainties.yaml
decisions.yaml
gates.yaml
findings.yaml
manifest.json
```

Phase 1 MUST NOT add current-state registries such as `verification.yaml`, `reviews.yaml`, `change-sets.yaml`, `errors.yaml`, or `plan-deviations.yaml`.

Every snapshot file contains:

```yaml
schema_version: 1
run_id: <run-id>
state_revision: 42
```

`steps.yaml` additionally carries `graph_revision`.

### manifest.json

Representative shape:

```json
{
  "schema_version": 1,
  "run_id": "<run-id>",
  "state_revision": 42,
  "previous_state_revision": 41,
  "created_at": "2026-08-30T03:02:10.123+09:00",
  "files": [
    "requirement.yaml",
    "steps.yaml",
    "uncertainties.yaml",
    "decisions.yaml",
    "gates.yaml",
    "findings.yaml"
  ]
}
```

Hashes are not required in Phase 1.

## Atomic State Commit

Canonical logical commit:

```text
current state revision N
        ↓
compute N+1 in memory
        ↓
Schema / Reference / Domain / Snapshot validation
        ↓
write snapshot N+1 to temporary location
        ↓
read-back validate all six files + manifest
        ↓
finalize snapshot directory
        ↓
build next run.yaml
        ↓
atomic replace run.yaml   ← logical commit point
        ↓
append observability Events
```

- **MUST:** `StateStore.commit()` commit one complete logical Workflow State revision.
- **MUST:** Compare the expected previous revision and reject a mismatch as `STATE_REVISION_CONFLICT`.
- **MUST NOT:** Auto-adopt an orphan snapshot not referenced by `run.yaml`.
- **MUST NOT:** Silently roll back to an older snapshot when the current referenced snapshot is missing/corrupt.
- **MAY:** Leave orphan snapshot directories after a crash; they are not current until pointed to by `run.yaml`.

## Requirement Revision History

Raw initial request lives at `request.md`. It is not rewritten when the Requirement changes.

Normalized Requirement history:

```text
requirements/requirement-v1.yaml
requirements/requirement-v2.yaml
...
```

A committed Requirement revision file is immutable. Current `state/.../requirement.yaml` is the authoritative current Requirement projection for that state revision.

Sensitive material in persisted request/requirement content MUST pass redaction rules.

## Artifact Model

A Semantic Artifact is a finalized, conversation-independent evidence/handoff record. Runtime temporary material is not a Semantic Artifact.

> **Invariant**
>
> Finalized Semantic Artifacts are immutable.

Common Artifact status:

```text
complete | partial
```

`partial` means a valid finalized historical record of incomplete/partially completed work. It MUST NOT be confused with a draft/staging file.

## Artifact Lifecycle

```text
draft
  ↓
staged
  ↓
validated / normalized / redacted
  ↓
atomic finalize
  ↓
finalized immutable Artifact
```

Only finalized Artifacts may be referenced from authoritative State.

Staging lives under:

```text
runtime/staging/<execution-id>/
```

Crash-left staging material is not automatically promoted to an Artifact.

## Artifact Front Matter

Execution-owned Artifact common fields:

```yaml
schema_version: 1
run_id: <run-id>
step_id: <step-id>
execution_id: <execution-id>
execution_state_revision: 41
agent:
  id: worker
  version: 1
artifact:
  type: implementation
  status: complete
created_at: 2026-08-30T03:02:10.123+09:00
skills: []
```

Type-specific identities may add `change_set_id`, `verification_run_id`, `review_run_id`, `plan_version`, or `requirement_revision`.

Provider/model details are not mandatory Semantic Artifact fields; they are execution/telemetry metadata.

Major Agent/Execution Artifacts SHOULD contain a compact `## Handoff Summary` describing established facts/results, unresolved items, and key refs.

## Artifact Naming

Canonical paths:

| Kind | Path |
|---|---|
| Raw request | `request.md` |
| Effective config | `effective-config.yaml` |
| Requirement revision | `requirements/requirement-v<N>.yaml` |
| Analysis | `analysis/<purpose>-<execution-id>.md` |
| Research | `research/<purpose>-<execution-id>.md` |
| Decision support | `decisions/<decision-id>-<execution-id>.md` |
| Plan | `plans/execution-plan-v<N>.md` |
| Change Set | `implementation/change-set-<CS-ID>.md` |
| Reconciliation | `implementation/reconciliation-<execution-id>.md` |
| Verification Run | `verification/<VR-ID>.md` |
| Verification evidence | `verification/evidence/<VR-ID>/<V-ID>.<ext>` |
| Review Run | `reviews/<RR-ID>.md` |
| Failure Record | `failures/failure-<NNN>.md` |
| Outcome | `outcome.md` |

Filenames MUST NOT encode mutable states such as `passed`, `failed`, or `current`.

Purpose/topic slugs are sanitized lowercase kebab-case. Paths are Run-relative and MUST NOT contain traversal outside the Run root. Phase 1 Semantic Artifact paths MUST NOT rely on symlinks.

## Plan Artifact

Canonical path:

```text
plans/execution-plan-v<N>.md
```

Plan version in the Artifact MUST match the filename. Re-plan creates a new version; previous Plans are never overwritten.

## Decision Support Artifact

Canonical path:

```text
decisions/<decision-id>-<execution-id>.md
```

This Artifact contains detailed option/trade-off evidence. Current Decision resolution remains authoritative in `decisions.yaml`; the Artifact is not rewritten when the Decision is later resolved.

## Change Set Artifact

Canonical path:

```text
implementation/change-set-<CS-ID>.md
```

One Worker Execution produces zero or one Change Set. The finalizer merges Worker intent/result with runtime repository observation before Artifact finalization.

## Reconciliation Artifact

Canonical path:

```text
implementation/reconciliation-<execution-id>.md
```

Material repository reconciliation SHOULD be represented as a recovery/analysis Step with an Execution identity so the Artifact can use the same naming model.

## Verification Run Artifact

Canonical summary Artifact:

```text
verification/<VR-ID>.md
```

Phase 1 does not require a separate Markdown Artifact for every `V-*` check.

Large or valuable raw evidence MAY be stored under:

```text
verification/evidence/<VR-ID>/
```

Examples:

```text
V-001.stdout.log
V-001.stderr.log
V-002.result.json
```

Raw output is optional; short evidence may be summarized directly in the VR Artifact. Referenced formal evidence is immutable.

## Review Run Artifact

Canonical path:

```text
reviews/<RR-ID>.md
```

Phase 1 does not create a separate Markdown Artifact for each Finding. Current Finding lifecycle state lives in `findings.yaml`; detailed evidence remains in Review Runs.

## Failure Records

Canonical path:

```text
failures/failure-<NNN>.md
```

Failure Records are immutable history. `run.yaml.failure` points only to the current failure; successful resume clears the current failure reference but does not delete historical records.

## Outcome

`outcome.md` exists only for finalized Runs.

| Run condition | `outcome.md` |
|---|---|
| completed | required |
| cancelled | required |
| failed, resumable=false | required |
| failed, resumable=true | MUST NOT exist yet |

Outcome is written/finalized before the terminal state commit.

## Event Log Storage

Canonical Event log:

```text
events/events.jsonl
```

Events are append-only observability history. State is not reconstructed from Events.

Common envelope fields include:

```json
{
  "schema_version": 1,
  "event_id": "evt-000123",
  "sequence": 123,
  "type": "step.completed",
  "timestamp": "2026-08-30T03:02:10.123+09:00",
  "run_id": "<run-id>",
  "source": { "component": "orchestrator" },
  "actor": { "type": "agent", "id": "worker" },
  "state_revision": 42,
  "correlation_id": "exec-015",
  "caused_by": { "event_id": "evt-000121" },
  "data": {}
}
```

Sequence is authoritative for Event ordering; timestamp is not. Event Writer owns sequence/event ID allocation.

A committed State revision may exist without its corresponding Event after a crash. This does not invalidate current state.

## Runtime Evidence

`runtime/` contains internal evidence/temporary material, not semantic handoff Artifacts:

```text
runtime/repository/
runtime/executions/
runtime/staging/
runtime/debug/
```

Repository snapshots may record hashes/diffs/metadata and only retain full file baselines when necessary for dirty-tree preservation/recovery. Raw source copies SHOULD NOT be duplicated broadly because of size/privacy risk.

Standard mode does not persist full raw Agent payloads or prompts. Redacted debug detail may be stored under `runtime/debug/` when debug telemetry is enabled.

## Validation

Before state commit/final Artifact reference, validators run in conceptually separate layers:

```text
SchemaValidator
  ↓
ReferenceValidator
  ↓
DomainInvariantValidator
  ↓
SnapshotConsistencyValidator
```

Artifact finalization additionally validates path/type agreement, identity/provenance, type-specific fields, Handoff Summary where required, redaction, and size limits.

## Migration

State schema versions, Workflow versions, and Agent/Skill/Playbook versions are distinct concerns.

- **MUST:** Reject unsupported future state schemas.
- **MUST:** Apply known migrations sequentially in memory, then validate.
- **MUST NOT:** Silently rewrite historical snapshots during read.
- **MAY:** A later successful mutation write the current schema version into a new snapshot.
- **MUST:** Resume use the persisted graph/effective config snapshot rather than regenerating historical state from the current Playbook definition.

## Retention

Phase 1 retains active Runs and terminal Run semantic history by default. Automatic cleanup is not required.

Semantic Artifacts and referenced verification evidence are retained. Runtime staging, temporary full-file baselines, and debug material are cleanup candidates in later phases, but recovery MUST occur before blind deletion.
