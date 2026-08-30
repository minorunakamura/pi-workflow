# Security, Recovery, and Repository Safety

## Purpose

This document defines repository mutation safety, permissions, Git policy, dirty-tree protection, mutation attribution, repository drift, locks, error/recovery behavior, resume, cancellation, failure, secrets, network access, and external side effects.

## Security Principles

> **Invariant**
>
> Prompt instructions alone are not a security boundary. Runtime permissions and Tool capabilities MUST enforce the same restrictions.

> **Invariant**
>
> User approval does not override hard runtime/security invariants.

## Agent Permission Enforcement

Runtime permissions are derived from Agent definition plus the current Execution Request.

Typical defaults:

| Agent | Source write | Network | Formal verification |
|---|---:|---:|---:|
| Scout | no | normally no | no |
| Researcher | no | yes when selected | no |
| Planner | no | normally no | no |
| Oracle | no | normally no | no |
| Worker | approved scope only | normally no | no |
| Verifier | no source mutation | normally no | yes |
| Reviewer | no | normally no | no |

A Skill or Tool adapter MUST NOT widen these permissions.

## Git Policy

Normal Phase 1 control-plane Git policy:

| Operation | Allowed |
|---|:---:|
| `status`, `diff`, `log`, `show`, `blame` | yes |
| `add`, `commit`, `push` | no |
| `merge`, `rebase`, branch mutation | no |
| `reset`, `restore`, `clean` | no |

Worker may modify source files within Write Scope but MUST NOT perform Git write operations under the normal Phase 1 runtime contract.

## Write Scope

Write Scope is approved by the Plan and enforced at runtime.

- **MUST:** Worker only mutate files/areas authorized by Write Scope.
- **MUST:** Actual diff be checked after Worker execution.
- **MUST:** Scope expansion be classified as D1/D2 according to materiality before continuing.
- **MUST:** A `WRITE_SCOPE_VIOLATION` block acceptance of the Worker result until reconciled.

## Repository Baseline

At Run start, persist/observe at least:

```text
repository root identity
HEAD
branch
dirty state
pre-existing changed/untracked files
```

Before each Worker, capture a more targeted execution baseline sufficient to detect mutation and protect pre-existing changes.

The repository working tree is the source of truth for actual current source; a Change Set is an implementation record, not a patch archive that replaces the tree.

## Pre-existing Changes

Repository content is classified conceptually as:

```text
Pre-existing
Workflow-attributed
External
```

- **MUST:** Preserve pre-existing user changes.
- **MUST:** Detect/flag likely lost pre-existing content (`PREEXISTING_CHANGE_LOST`).
- **MUST:** Treat uncertain same-file attribution conservatively rather than falsely claiming all changes as Workflow-attributed.
- **MUST NOT:** Automatically reset/restore user changes to make the workflow easier to reason about.

## Mutation Attribution

Worker finalization combines:

```text
pre-execution snapshot
+ Worker intent/result
+ post-execution snapshot/diff
= Change Set runtime observation
```

Attribution may be confident or uncertain. Uncertain attribution prevents a complete accepted Change Set until reconciled.

## Repository Drift

Drift is an unexplained repository change relative to the expected workflow basis.

Drift uses two axes.

### Classification

```text
clean | unrelated | relevant | critical | unknown
```

### Resolution

```text
clear | unresolved | reconciled
```

Recommended combinations include:

```text
clean      + clear
unrelated  + clear
relevant   + unresolved/reconciled
critical   + unresolved/reconciled
unknown    + unresolved
```

A relevant/critical/unknown unresolved drift blocks normal continuation until analyzed/reconciled.

Drift checks occur at important boundaries such as Run start/resume, pre/post Worker, pre-Verifier, pre-Reviewer, and pre-completion.

External/manual corrections are respected. They MAY supersede prior Change Set relevance, but MUST NOT be rewritten as fictitious Workflow Change Sets. Material reconciliation is recorded separately.

## Repository Reconciliation

Reconciliation explains how current repository state relates to earlier Workflow-attributed changes and external/manual edits.

A material reconciliation SHOULD be executed as a dedicated recovery/analysis Step and finalized to:

```text
implementation/reconciliation-<execution-id>.md
```

Current implementation completeness is based on relevant Change Sets plus reconciliation, not on Change Sets alone.

## Locks

### Run Lock

Only one Orchestrator owner may mutate one Run at a time.

A Run lock records owner/process/host/acquired/heartbeat metadata. Resume/start MUST acquire the lock before state mutation. Read-only status does not require ownership.

Stale lock recovery MUST be explicit; the runtime MUST NOT blindly steal a live lock.

### Workspace Lock

Phase 1 write-capable Runs use the current tree and therefore require exclusive workspace mutation coordination. Long blocked/user-wait states SHOULD release the workspace lock and perform drift validation on resume.

Phase 2 may replace this with worktree isolation.

## Error Model

An Error is distinct from a Step failure, Verification failure, Finding, or Run failure.

Categories include:

```text
configuration
state
runtime
agent
tool
validation
permission
concurrency
graph
context
artifact
```

Structured Errors carry:

```text
error_id
category
code
severity
retryable
recoverable
message/context refs
```

Severity:

```text
info | warning | error | fatal
```

Expected domain outcomes such as a failed test assertion are not automatically `error.occurred` conditions.

Representative stable codes include:

```text
RESULT_SCHEMA_INVALID
STATE_REVISION_CONFLICT
RUN_LOCKED
REPOSITORY_DRIFT
WRITE_SCOPE_VIOLATION
PREEXISTING_CHANGE_LOST
GRAPH_NO_PROGRESS
CONTEXT_BUDGET_EXCEEDED
REQUIRED_CONTEXT_MISSING
```

## Recovery Manager

Resume/start recovery order:

```text
locate Run
   ↓
read run.yaml
   ↓
validate finalized/resumability
   ↓
load/migrate current snapshot
   ↓
validate effective config
   ↓
recover stale lock state
   ↓
acquire Run lock
   ↓
resolve workspace
   ↓
check repository drift
   ↓
recover interrupted Execution
   ↓
process pending cancellation/user state
   ↓
reconcile Gates/freshness/triggers
   ↓
continue scheduling
```

After acquiring the lock, the runtime SHOULD reload current state before mutation to avoid acting on stale pre-lock data.

## Interrupted Execution

Read-only interrupted executions may be retryable when their premise remains current.

Worker interruption is special:

```text
Worker running
  ↓ crash / interrupt
repository may already be changed
  ↓
inspect current diff / attribution
  ↓
finalize partial record or reconciliation
  ↓
only then choose retry/fix/re-plan
```

> **Invariant**
>
> Interrupted Worker execution MUST NOT be blindly retried.

## Resume

Allowed normal resume transitions:

```text
blocked → running
failed(resumable=true) → running
```

Disallowed:

```text
completed → running
cancelled → running
failed(resumable=false) → running
```

Resume MUST preserve retry/fix/dynamic-Step/resolution budgets and MUST re-check repository drift/freshness. Conversation history is not required.

## Cancellation

Cancellation is an explicit user/control request; Agents cannot cancel a Run themselves.

Crash-safe flow:

```text
persist cancellation_requested
   ↓
stop new dispatch
   ↓
abort active Execution if possible
   ↓
if Worker: inspect/reconcile repository state
   ↓
finalize partial records as needed
   ↓
write outcome.md
   ↓
commit cancelled + finalized
```

> **Warning**
>
> Cancellation does not imply repository rollback. Partial Worker mutations and pre-existing changes are preserved and reconciled, not automatically reverted.

A cancel request accepted before a completion commit wins the race. If completion was already committed/finalized, the Run remains completed.

## Run Failure

A Run enters `failed` only when it cannot safely continue with normal current recovery paths/policy/budget.

Step failure, Gate failure, Verification failure, or a Review Finding does not automatically fail the Run.

### Recoverable failure

```text
status: failed
resumable: true
finalized: false
failure record: required
outcome.md: absent
```

Successful resume clears the current failure pointer but retains historical Failure Records and Events.

### Final failure

```text
status: failed
resumable: false
finalized: true
failure record: required
outcome.md: required
```

Pending U/D/G/F objects do not need artificial lifecycle closure just to terminalize a failed/cancelled Run.

## Blocked Run

A blocked Run is not failed. Typical blocked reasons:

```text
user-input-required
decision-pending
approval-pending
uncertainty-unresolved
environment-unavailable
repository-drift
recovery-required
dependency-unavailable
external-condition
```

Long blocked periods SHOULD release workspace resources and be revalidated on resume.

## Secrets

- **MUST:** Secret-like values be redacted before persistence into request, Artifact, Event, or debug data.
- **MUST NOT:** Full environment values, API keys, raw authorization headers, or secret Tool args be stored in Standard telemetry.
- **SHOULD:** Use explicit markers such as `[REDACTED_SECRET]` when redaction affects visible evidence.

## Network

External network access is least-privilege. Researcher may receive network/external Tool access when required. Other Agents normally do not.

Network access MUST NOT imply authority to perform external side effects.

## External Side Effects

Phase 1 normally denies external mutation operations unrelated to source editing. A future adapter may support explicitly approved side effects, but they require dedicated authority and policy; they are not implied by D3 alone if hard runtime policy forbids them.
