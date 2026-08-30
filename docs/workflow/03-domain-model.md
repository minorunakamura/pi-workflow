# Domain Model

## Purpose

This document is the authoritative logical definition of Workflow entities, identities, lifecycles, derived state, traceability, and domain invariants. Physical persistence is defined in `06-persistence-and-artifacts.md`.

## Workflow Run

A Run is one durable execution of a normalized user request under a Playbook.

### Run Status

Normative values:

```text
created | running | blocked | completed | failed | cancelled
```

`finalized` is a separate boolean and MUST NOT be encoded as an additional Run status.

| Status | Finalized | Meaning |
|---|---:|---|
| `created` | false | Durable Run exists but normal execution has not started. |
| `running` | false | The Orchestrator can make progress or an Execution is active. |
| `blocked` | false | No active execution and no ready resolution Step can progress until a recoverable blocker changes. |
| `completed` | true | Completion contract passed and final Outcome exists. |
| `failed` + resumable | false | Current Run cannot continue now but an explicit resume may be allowed after the cause is resolved. |
| `failed` + non-resumable | true | Run cannot safely continue within normal recovery policy. |
| `cancelled` | true | Explicit stop has been reconciled and terminalized. |

> **Invariant**
>
> A finalized Run is immutable.

## Requirement

The normalized Requirement is the authoritative current contract for what the Run is trying to accomplish.

Logical shape:

```yaml
revision: 3
goal: "..."
scope:
  in: []
  out: []
constraints: []
acceptance_criteria: []
non_goals: []
supplied_evidence: []
assumptions: []
open_questions: []
```

### Goal

- **MUST:** Describe *what* outcome is needed, not prescribe implementation mechanics unless the user explicitly requires them.

### Acceptance Criteria

IDs use `AC-<NNN>`.

Active Acceptance Criteria may evaluate to:

```text
satisfied | not-satisfied | not-verifiable | not-applicable
```

- **MUST:** `not-satisfied` block completion.
- **MUST NOT:** A violated active Acceptance Criterion be converted into an accepted risk.
- **MAY:** `not-verifiable` be accepted as a limitation only through the applicable authority/policy.

### Constraints

IDs use `C-<NNN>`.

Constraint evaluation:

```text
respected | violated | not-evaluated
```

- **MUST:** `violated` block completion.
- **MUST NOT:** A violated Constraint be risk-accepted; the Requirement must change if the constraint itself is no longer required.

### Requirement Revisions

A meaning-preserving clarification, evidence-backed refinement, or accepted amendment creates a new Requirement revision. `AC-*` and `C-*` identities survive revisions when their semantics are unchanged; semantic replacement creates a new identity and supersedes the old one.

## Requirement Candidate

Agents cannot mutate the Requirement directly. A Step Result may return candidates grouped as:

- Acceptance Criterion candidates;
- Constraint candidates;
- Assumption candidates.

Supported candidate operations are intentionally narrow: add or clarify. Agents do not directly remove, replace, or supersede Requirement elements.

A candidate has a suggested semantic effect:

```text
preserving | narrowing | broadening | changing
```

The Orchestrator decides whether it can be applied automatically, requires a Decision/Uncertainty, or needs user clarification.

## Step

A Step is a logical orchestration unit.

Normative fields include:

```yaml
id: <step-id>
type: analysis | research | decision | planning | implementation | verification | review
objective: "..."
agent: <agent-id>
skills: []
inputs: []
outputs: []
depends_on: []
completion_criteria: []
status: pending | ready | running | blocked | completed | failed | skipped
blocked_by: []
result: null
```

`partial` is not a Step status in Phase 1. Partial execution evidence is represented by finalized partial Artifacts or execution results.

### Step Invariants

- **MUST:** The Step graph remain acyclic.
- **MUST:** Completed Steps are not reopened when material inputs change; a new Step is created instead.
- **MAY:** The same Step be retried only when its objective, material inputs, assumptions, and repository basis are still equivalent.
- **MUST:** A changed premise that alters strategy create a new Step/re-plan instead of masquerading as a retry.

## Execution

An Execution is one attempt to execute one Step.

Typical identity:

```text
exec-001
```

Execution metadata includes Step, Agent, attempt number, model/provider, start/end timing, result, and compact runtime metrics. Multiple Executions may belong to one Step because of retries or configured fallback.

## Uncertainty

IDs use `U-<NNN>`.

Normative statuses:

```text
open | resolving | resolved | accepted | escalated
```

Categories:

```text
requirement | behavior | design | external | impact | verification
```

An accepted Uncertainty means the unknown remains but its residual risk/limitation has been explicitly accepted. It does not mean the missing fact became known.

Resolution attempts are bounded by policy. When the budget is exhausted, the Orchestrator escalates or ultimately fails/blocks according to authority and policy.

## Decision

IDs use `D-<NNN>`.

Material Decisions have a class:

```text
D1 | D2 | D3
```

`D0` is normally a local Agent decision and usually does not require a persisted Decision entity.

Normative statuses:

```text
pending | resolved | superseded
```

- `D1`: plan-bounded material choice that can usually be resolved within approved constraints.
- `D2`: design decision owned by the Orchestrator.
- `D3`: user approval/choice; Agents MUST NOT resolve it.

A resolved Decision records authority, resolution, and relevant evidence references. Detailed option/trade-off analysis may live in a Decision-support Artifact.

## Gate

IDs use `G-<NNN>`.

### Gate Types

```text
evidence | uncertainty | decision | verification | approval | completion
```

### Gate Status

```text
waiting | passed | failed | superseded
```

> **Invariant**
>
> Gates are semantic control conditions and are not Step graph nodes.

A Gate controls one or more Steps and/or Run completion. When its binding changes materially, the old Gate is superseded and a new Gate is created rather than mutating historical meaning.

The Completion Gate is a projection of `CompletionEvaluator` output. The Completion Gate itself MUST NOT be an input to the Completion Evaluator, avoiding a circular condition.

## Finding

IDs use `F-<NNN>`.

### Finding State

```text
open | resolved
```

### Disposition

Allowed combinations:

| State | Disposition |
|---|---|
| `open` | `pending` |
| `open` | `fix-required` |
| `open` | `accepted` |
| `resolved` | `fixed` |
| `resolved` | `dismissed` |

Severity:

```text
critical | high | medium | low
```

Confidence:

```text
high | medium | low
```

A Finding may be reopened by a later Review Run. Reopening MUST preserve the same `F-*` identity when it is the same root issue.

> **Invariant**
>
> An open Finding with disposition `pending` or `fix-required` blocks completion regardless of severity.

Critical Finding acceptance is normally invalid and requires policy/authority rules strong enough to prevent accidental completion.

## Plan

A Plan converts the current Requirement, evidence, and Decisions into an executable/verifiable implementation strategy. It is not the runtime Execution Graph.

Each Plan has a version and binds to a Requirement revision.

Logical sections include:

- summary and strategy;
- implementation units;
- verification checks;
- affected areas;
- Write Scope;
- dependencies;
- constraints and assumptions;
- Acceptance Criterion coverage;
- related Decisions;
- unresolved blockers.

### Plan Unit

IDs use `P-<NNN>` and are scoped by Plan version.

Plan Units describe purpose-oriented implementation work, not necessarily files or runtime Steps.

### Verification Check

IDs use `V-<NNN>` and are scoped by Plan version.

A Verification Check defines what should be verified, its type, whether it is required, and relevant evidence/command expectations.

`P-*` and `V-*` references MUST include Plan version context; the bare ID is not globally unique across Plan versions.

## Plan Applicability

Derived Plan applicability values:

```text
current | compatible | replan-required | unknown
```

A current Run's `current_plan` MUST NOT point to a superseded Plan. When an old Plan is superseded and no replacement exists yet, `current_plan` is absent/null.

## Change Set

IDs use `CS-<NNN>`.

A Change Set is an immutable Implementation Record for one Worker Execution, combining Agent intent with runtime-observed repository mutation.

A Worker Execution produces zero or one Change Set. A no-op may produce a complete Change Set with `changed=false`.

Logical content includes:

- basis and execution identity;
- summary and implementation intent;
- actual repository mutation facts;
- Plan Unit and Acceptance Criterion traceability;
- deviations;
- execution-level checks;
- pre-existing change preservation and attribution.

Artifact completion state may be `complete` or `partial`.

### Change Set Relevance

Current relevance is derived and not written back into the immutable Change Set Artifact:

```text
relevant | partially-superseded | superseded | unknown
```

## Plan Deviation

IDs use `PD-<NNN>` when a deviation is material enough to track formally. Deviations are reported by Worker results and normalized by the Orchestrator. Important off-plan design choices beyond Worker authority escalate rather than being silently recorded as harmless deviations.

## Verification Run

IDs use `VR-<NNN>`.

One Verifier Execution produces zero or one Verification Run.

Artifact status:

```text
complete | partial
```

Aggregate result:

```text
passed | failed | incomplete
```

Check status:

```text
passed | failed | skipped | unavailable
```

Check types include:

```text
test | build | lint | typecheck | format | behavior | regression | inspection | manual
```

Verification strength:

```text
strong | partial | weak | none
```

A Verification Run records basis: Requirement revision, Plan, relevant Change Sets/reconciliation, repository snapshot, checks, evidence, and limitations.

### Verification Freshness

Freshness is derived:

```text
fresh | stale | unknown
```

A stale Verification Run cannot satisfy current completion and is not made acceptable by risk acceptance. A new/current Verification Run is required.

An unavailable required check may be accepted as a limitation by authority/policy. An actually failed required check cannot be converted to passed through risk acceptance.

## Review Run

IDs use `RR-<NNN>`.

One Reviewer Execution produces zero or one Review Run.

Artifact status:

```text
complete | partial
```

Result:

```text
clean | findings | incomplete
```

Review kind:

```text
change | investigation
```

A change Review Run evaluates the current Requirement, applicable Plan, current relevant implementation, fresh Verification Run, Decisions, reconciliation, and repository state. An investigation Review Run uses the investigation evidence/synthesis basis and does not require normal Worker/Verifier artifacts.

### Review Freshness

Freshness is derived:

```text
fresh | stale | unknown
```

Material implementation or verification changes normally invalidate an older Review Run and require re-review when Review is mandatory.

## Outcome

Outcome is the final semantic summary for a finalized Run.

For completed change Runs, `request_satisfied` MUST be true. Completed Investigation Runs may set it false when the investigation is legitimately only partially answered or inconclusive, accompanied by:

```text
answered | partially-answered | inconclusive
```

Cancelled and final-failed Runs have `request_satisfied=false`.

Outcome references existing accepted-risk/limitation/Decision/Finding objects; no additional risk ID family is introduced in Phase 1.

## Completion Evaluator

`CompletionEvaluator` is a side-effect-free domain evaluator over current authoritative state and derived applicability/freshness.

It evaluates eight domains:

1. Steps
2. Requirement
3. Plan
4. Implementation
5. Repository
6. Verification
7. Review/Findings
8. Control State

Representative blocker codes include:

```text
STEP_INCOMPLETE
AC_NOT_SATISFIED
AC_NOT_VERIFIABLE
CONSTRAINT_VIOLATED
CONSTRAINT_NOT_EVALUATED
PLAN_NOT_APPLICABLE
IMPLEMENTATION_UNRECONCILED
REPOSITORY_DRIFT_UNRESOLVED
VERIFICATION_MISSING
VERIFICATION_STALE
VERIFICATION_FAILED
VERIFICATION_LIMITATION_UNACCEPTED
REVIEW_MISSING
REVIEW_STALE
REVIEW_INCOMPLETE
FINDING_PENDING
FINDING_FIX_REQUIRED
UNCERTAINTY_UNRESOLVED
DECISION_PENDING
GATE_NOT_PASSED
TERMINAL_ERROR_PRESENT
```

- **MUST:** Mandatory Steps be complete/skipped only when skip is authorized.
- **MUST:** Write Playbooks have a current/compatible Plan.
- **MUST:** All current source changes be explained by relevant Change Sets/reconciliation.
- **MUST:** Required Verification be fresh and acceptable.
- **MUST:** Required Review be fresh and complete.
- **MUST:** No blocking Finding, Decision, Uncertainty, or active controlling Gate remain.
- **MUST:** Relevant repository drift be reconciled.

The evaluator reports blockers. Recovery/re-plan/fix behavior is the Orchestrator's responsibility.

## Referential Integrity

### Identity ownership

- `U-*`, `D-*`, `G-*`, `F-*`, and other formal State IDs are allocated by the Orchestrator/runtime normalizer.
- Agents return candidates/local IDs, not authoritative State IDs.
- `CS-*`, `VR-*`, and `RR-*` are Run-global identities allocated during finalization.
- `P-*` and `V-*` are Plan-version scoped.

IDs are never reused once issued; gaps are allowed.

### Mandatory traceability

For write workflows the current result MUST support:

```text
Acceptance Criterion
    → Plan Unit / Verification Check
    → Change Set / reconciliation
    → Verification Run
    → Review / Outcome
```

## Derived vs Authoritative vs Historical

| Kind | Examples |
|---|---|
| Authoritative current state | current Requirement, Step states, U/D/G/F current lifecycle state |
| Derived | Plan applicability, Change Set relevance, VR/RR freshness, Completion eligibility |
| Historical evidence | prior Plan, Change Set, VR, RR, Decision-support Artifact, Event history |

Derived values MUST NOT be confused with immutable historical Artifact fields.
