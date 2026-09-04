# Orchestration

## Purpose

This document defines how the Orchestrator turns a Playbook plus runtime discoveries into an Execution Graph, schedules Steps, resolves Uncertainty and Decisions, evaluates Gates, inserts dynamic Steps, performs retry/re-plan/fix cycles, switches Playbooks when required, and decides when a Run can complete or must block/fail.

Logical entity definitions are in `03-domain-model.md`.

## Playbook Model

A Playbook is:

```text
Base Graph + Rules + Policies + Invariants
```

The runtime graph is:

```text
Base Graph + Dynamic Steps = Execution Graph
```

- **MUST:** Playbooks define initial strategy, not a hard-coded transcript of every possible runtime action.
- **MUST:** The Orchestrator own graph mutation.
- **MUST NOT:** Agents create or dispatch runtime Steps directly.

## Execution Graph

The Step graph is DAG-compatible from Phase 1. Dependencies express logical prerequisites. Gates are not graph nodes; they control whether a pending/ready Step may be dispatched.

A Step becomes runnable when:

- dependencies are satisfied;
- controlling active Gates are passed;
- no blocking authoritative state prevents dispatch;
- Agent/Skill/permission configuration is valid;
- the Scheduler selects it under current policy.

## Scheduler

Phase 1 is sequential: at most one ready Step is dispatched at a time.

Priority order:

```text
P0 Recovery / Safety
P1 Blocking Resolution
P2 Decision
P3 Blocking Fix
P4 Mandatory Base Work
P5 Verification
P6 Review
P7 Supporting Analysis / Research
P8 Optional Work
```

Tie-breaking MUST be deterministic.

The Scheduler returns either a Step to dispatch or an idle reason. It MUST NOT mutate state, ask the user, create Steps, switch Playbooks, or perform repository inspection.

If there is no active execution, no ready Step, no recoverable blocker, and the Run is neither complete nor terminal, the Orchestrator treats the state as `GRAPH_NO_PROGRESS` rather than busy-looping.

## Uncertainty Resolution

Uncertainty routing:

| Category | Preferred resolution |
|---|---|
| `behavior` | Scout using `how` / `why` |
| `external` | Researcher |
| `impact` | Scout using `blast-radius` |
| `design` | Planner and/or Oracle |
| `requirement` | Existing evidence first, then Orchestrator/User clarification |
| `verification` | Verifier/research/re-plan depending on cause |

A later Agent may return an `uncertainty_rechecks` candidate that references one existing `U-*` and cites concrete evidence; this is a proposal, not an Agent-owned status mutation. The Orchestrator validates the reference and evidence, then alone may project `open|resolving` to `resolved`. Phase 1 may deterministically resolve verification/behavior Uncertainty only from a matching accepted Verification Run and passed required Check; unrelated evidence does not qualify. `accepted` remains an explicit residual-risk disposition and is not produced by this path.

Resolution attempts are bounded. Scope-local investigation/research may be inserted automatically when within D0/D1. D2 remains Orchestrator authority. D3 always requires the user.

## Decisions and Escalation

Escalation reasons include:

```text
insufficient-evidence
authority-exceeded
conflicting-evidence
resolution-budget-exceeded
high-risk
user-decision-required
```

Destinations are Agent, Oracle, Orchestrator, or User depending on authority. An Agent MUST NOT bypass the Orchestrator to ask the user.

## Gates

Gate types and lifecycle are defined in `03-domain-model.md#gate`.

Common behavior:

- a newly created Gate normally starts `waiting`;
- unchanged re-evaluation emits no lifecycle transition;
- `failed` does not automatically mean the Run fails;
- a failed Gate normally creates a recovery/re-plan/fix path when policy allows;
- when its basis changes materially, the old Gate is `superseded` and a new Gate is created.

### Gate Matrix

| Playbook | Evidence / domain gate | Verification gate | Review policy |
|---|---|---|---|
| Feature | Conditional evidence as needed | Required | Required |
| Bug | Root-cause evidence required | Required | Required |
| Hotfix | Root-cause/minimal-safety evidence required | Required | Required |
| Chore | Conditional evidence | Required | Risk/policy conditional |
| Refactor | Invariant/blast-radius evidence required | Required | Required |
| Investigation | Question/evidence synthesis | N/A for read-only base graph | Required findings/synthesis review |

## Dynamic Graph Mutation

Only the Orchestrator mutates the graph.

Valid triggers include:

```text
uncertainty
decision
verification failure
review finding
plan deviation
repository drift
execution/runtime failure
recovery
request amendment
```

Mutation procedure:

1. Identify trigger and semantic purpose.
2. Deduplicate against active equivalent Steps.
3. Build dependencies and completion criteria.
4. Validate agent/skill legality and Playbook invariants.
5. Validate references and cycle freedom.
6. Respect `max_dynamic_steps` and other finite budgets.
7. Commit the new graph revision.

Completed Steps are not physically removed or reopened. Obsolete pending work becomes `skipped` with a reason.

## Retry

Retry means another Execution of the same Step.

- **MAY:** Retry when objective, material inputs, assumptions, Plan basis, and repository basis are still equivalent.
- **MUST:** Re-plan or create a new Step when those premises materially change.
- **MUST NOT:** Blindly retry an interrupted Worker before inspecting repository mutation.

Transient provider/tool retry is distinct from semantic workflow retry.

## Re-plan

Re-plan creates a new planning Step and a new Plan version. Existing Plans remain immutable history.

A re-plan may adopt, adjust, or supersede existing implementation. The new Plan explicitly classifies relevant existing changes rather than pretending no implementation exists.

## Playbook Switch

Playbook switch is stronger than re-plan. It changes the current strategy/policies while keeping the same Run ID unless the task is better modeled as a follow-up Run.

The Orchestrator SHOULD prefer local dynamic Steps/re-plan over frequent switches.

Investigation-to-write work SHOULD normally create a new follow-up Run rather than silently converting a completed investigation into a mutation workflow.

When switching:

- persist the new current Playbook/version;
- preserve existing graph/history;
- add missing mandatory equivalent Steps where needed;
- skip obsolete pending Steps with reasons;
- do not rebuild the Run from scratch.

## Request Amendment

A user change to the request is a Request Amendment, not an Agent message. The Orchestrator updates the normalized Requirement through a new revision, assesses Plan applicability, supersedes/rebinds affected Gates, and inserts re-analysis/re-plan Steps when needed.

## Verification and Review Fix Loop

Canonical write-workflow recovery:

```text
Worker
  ↓
Verifier
  ├─ passed ──────────────► Reviewer
  │                           │
  │                           ├─ clean / acceptable findings → Completion
  │                           │
  │                           └─ blocking Finding
  │                                   ↓
  └─ failed required check ───────► Fix Worker
                                      ↓
                                   Verifier
                                      ↓
                                   Reviewer
```

Fix cycles are bounded by policy. Exhaustion may escalate or fail the Run; it does not silently weaken verification/review requirements.

## Completion

The Orchestrator runs `CompletionEvaluator` before declaring no more work and before terminalization.

If completion is eligible:

1. write/finalize `outcome.md`;
2. commit the terminal Run state with `finalized=true`;
3. append completion Events;
4. release locks.

If evaluation returns blockers, the Orchestrator chooses recovery work, blocks, or fails according to blocker type, authority, and budgets.

The Completion Gate simply reflects evaluator eligibility and is excluded from the evaluator input.

## Blocked and Failed Routing

A Run is `blocked` when:

- no active execution exists;
- no ready resolution Step can make progress;
- at least one recoverable blocker requires an external/user/environment change.

Stable blocked reasons include:

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

Step failure, Gate failure, Verification failure, or Finding creation does not automatically make the Run failed. The Orchestrator first attempts allowed recovery.

A `failed` Run means normal recovery paths/policies/budgets cannot currently continue safely. Resumability is explicit and defined in `07-security-recovery-and-repository.md#run-failure`.

## Playbooks

### Feature Playbook

Purpose: introduce user-visible or system behavior safely.

Base Graph:

```text
Scout → Planner → Worker → Verifier → Reviewer
```

- **MUST:** Planner, Worker, Verifier, and Reviewer be present in normal feature mutation flow.
- **MAY:** Researcher/Oracle be inserted when evidence or design uncertainty requires them.
- **MUST:** Required verification pass on the current implementation before final review can satisfy completion.

### Bug Playbook

Purpose: fix a defect based on established behavior/root cause.

Base Graph:

```text
Scout understand
   ↓
Scout reproduce
   ↓
Scout root-cause
   ↓
Planner
   ↓
Worker
   ↓
Verifier regression
   ↓
Reviewer
```

- **MUST:** Establish root cause/equivalent causal evidence before implementation planning.
- **MUST:** Verification include a regression-oriented check when technically possible.

### Hotfix Playbook

Purpose: rapidly correct a high-urgency defect using the narrowest safe change.

Base strategy:

```text
rapid understand/root-cause
   ↓
minimal Plan
   ↓
Worker
   ↓
critical Verification
   ↓
Reviewer
```

- **MUST:** Preserve root-cause evidence and critical verification despite reduced breadth.
- **SHOULD:** Keep Write Scope and Plan narrowly bounded.

### Chore Playbook

Purpose: low-behavioral-risk maintenance/configuration/tooling work.

Base Graph:

```text
Scout → Planner → Worker → Verifier → Reviewer?
```

Verifier is mandatory for write chores. Reviewer is policy/risk conditional.

### Refactor Playbook

Purpose: change internal structure while preserving required observable behavior.

Base Graph:

```text
Scout structure/invariants/blast-radius
   ↓
Planner
   ↓
Worker
   ↓
Verifier behavior preservation
   ↓
Reviewer
```

- **MUST:** Establish relevant invariants/behavior preservation basis before Worker execution.
- **MUST:** Final Verification evaluate preservation, not merely build success.

### Investigation Playbook

Purpose: answer a technical question without normal source mutation.

Base Graph:

```text
Scout define question
   ↓
investigate / Researcher? / Oracle?
   ↓
synthesize
   ↓
Reviewer
```

- **MUST NOT:** Include a normal Worker Step in the base graph.
- **MUST NOT:** Require a normal Verification Run when no source change exists.
- **MUST:** Produce a reviewed conclusion and explicit `answered`, `partially-answered`, or `inconclusive` outcome state as appropriate.
