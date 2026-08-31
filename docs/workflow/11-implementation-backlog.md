# Implementation Backlog

## Usage

This document is an implementation-tracking projection of the authoritative specification in `01` through `10`. It MUST NOT redefine the architecture.

A Story should represent one independently understandable and testable Capability/Contract, not one file.

## Definition of Ready

A Story is ready when:

- Goal is explicit.
- Inputs/outputs and relevant authority/permission are known.
- Dependencies are stable/tested.
- Acceptance Criteria are testable.
- Required `spec_refs` are identified.
- Test Levels are known.

## Definition of Done

A Story is done when:

- implementation is complete;
- static/runtime types pass;
- required tests pass;
- architecture boundaries still pass;
- edge/error behavior is explicit;
- relevant contract documentation is updated;
- unsupported behavior does not silently fall back.

## Test Levels

```text
ARCH      Architecture/import-boundary test
UNIT      Pure unit/property test
CONTRACT  Runtime schema/contract test
INT       Integration test
E2E       End-to-end test
CRASH     Crash/recovery test
SEC       Security/permission test
```

## Priority

```text
P0 = runtime correctness / safety
P1 = required operability / observability
P2 = Monitoring usability / polish
```

# EPIC-01 — Foundation and Architecture

Default references:

```yaml
default_spec_refs:
  required:
    - 02-runtime-architecture.md#dependency-direction
    - 10-implementation-specification.md#runtime-layout
```

## STORY-01-01 — Runtime Module Skeleton

**Goal:** Create the runtime/documented module structure without leaking responsibilities.

**Priority:** P0

**Dependencies:** none

```yaml
spec_refs:
  required:
    - 02-runtime-architecture.md#ports-and-adapters
    - 10-implementation-specification.md#runtime-layout
    - 10-implementation-specification.md#package-manifest
```

**Acceptance Criteria**

- [x] The repository is an installable Pi Package with a `package.json` Pi manifest.
- [x] Runtime TypeScript is organized under `src/`; packaged Skills are under `skills/`.
- [x] The Pi manifest exposes one thin Extension entry point and the nine Core Skills.
- [x] Authored implementation source does not depend on `.pi/agent/skills/` or `.pi/workflows/` layout.
- [x] `domain`, `contracts`, `application`, `ports`, `adapters`, `telemetry`, `evaluation`, `read-model`, `bootstrap` are separated.
- [x] `agents`, `playbooks`, Pi command integration, and `monitor` are separated.
- [x] No catch-all giant `utils`/`common` module is introduced.

**Test Levels:** `ARCH`

## STORY-01-02 — Architecture Dependency Rules

**Goal:** Mechanically prevent forbidden imports and cycles.

**Priority:** P0

**Dependencies:** STORY-01-01

```yaml
spec_refs:
  required:
    - 02-runtime-architecture.md#dependency-direction
    - 10-implementation-specification.md#architecture-tests
```

**Acceptance Criteria**

- [x] `domain → application/adapters` fails tests.
- [x] `application → adapters` fails tests.
- [x] `adapters → application` fails tests.
- [x] `monitor → persistence/write` fails tests.
- [x] Agent/Playbook definition → adapter imports fail.
- [x] circular imports fail.
- [x] Package manifest resource paths resolve and package source does not require authored `.pi/` implementation directories.

**Test Levels:** `ARCH`

## STORY-01-03 — TypeScript and Test Foundation

**Goal:** Establish strict typing, deterministic unit tests, and reusable fixtures.

**Priority:** P0

**Dependencies:** STORY-01-01

```yaml
spec_refs:
  required:
    - 10-implementation-specification.md#testing-strategy
```

**Acceptance Criteria**

- [x] Strict type checking is enabled at a project-compatible level.
- [x] Runtime core contracts do not use unrestricted `any` as normal design.
- [x] Test fixtures/temp repositories are supported.
- [x] Typecheck, lint, format-check, and test commands can run from the package root.
- [x] `packageManager` pins the pnpm development version and package dependencies are classified as runtime/peer/dev dependencies according to the implementation specification.

**Test Levels:** `ARCH`, `UNIT`

## STORY-01-04 — Composition Root Skeleton

**Goal:** Provide one assembly location for concrete Adapters and application services.

**Priority:** P0

**Dependencies:** STORY-01-01

```yaml
spec_refs:
  required:
    - 02-runtime-architecture.md#composition-root
    - 10-implementation-specification.md#composition-root
```

**Acceptance Criteria**

- [ ] A runtime factory/composition module exists.
- [ ] Application modules do not instantiate concrete persistence/Pi/Git adapters.
- [ ] Manual constructor injection is sufficient; no Service Locator is added.

**Test Levels:** `ARCH`

# EPIC-02 — Contracts and Static Definitions

## STORY-02-01 — Domain IDs and Typed References

**Goal:** Prevent accidental mixing of Run-local and Plan-scoped identities.

**Priority:** P0

```yaml
spec_refs:
  required:
    - 03-domain-model.md#referential-integrity
    - 10-implementation-specification.md#contracts
```

**Acceptance Criteria**

- [ ] Types/functions exist for Run/Step/Execution/U/D/G/F/PD/CS/VR/RR IDs.
- [ ] `P-*` and `V-*` references carry Plan version.
- [ ] Issued IDs are not reused; gaps are allowed.

**Test Levels:** `UNIT`

## STORY-02-02 — Agent Execution Contracts

**Goal:** Implement runtime-validated `AgentExecutionRequestV1` and `StepResultV1`.

**Priority:** P0

**Dependencies:** STORY-02-01

```yaml
spec_refs:
  required:
    - 05-agents-and-skills.md#agent-execution-request
    - 05-agents-and-skills.md#step-result
    - 10-implementation-specification.md#contracts
```

**Acceptance Criteria**

- [ ] Request/result schema validates identity, arrays, outcomes, and mode.
- [ ] Agent result candidates cannot submit authoritative State IDs.
- [ ] Invalid shape is rejected deterministically.

**Test Levels:** `CONTRACT`

## STORY-02-03 — Workflow State Schemas

**Goal:** Implement runtime schemas for `run.yaml` and the six snapshot files.

**Priority:** P0

**Dependencies:** STORY-02-01

```yaml
spec_refs:
  required:
    - 06-persistence-and-artifacts.md#runyaml
    - 06-persistence-and-artifacts.md#state-snapshots
```

**Acceptance Criteria**

- [ ] Six state-file schemas and manifest schema exist.
- [ ] `finalized` is separate from status.
- [ ] `current_plan` cannot use `superseded` applicability.
- [ ] Stable arrays/nullable fields follow the specified shape.

**Test Levels:** `CONTRACT`

## STORY-02-04 — Artifact and Event Contracts

**Goal:** Implement Artifact front matter and typed Event envelope/union.

**Priority:** P0

**Dependencies:** STORY-02-01

```yaml
spec_refs:
  required:
    - 06-persistence-and-artifacts.md#artifact-front-matter
    - 06-persistence-and-artifacts.md#event-log-storage
    - 08-observability-and-evaluation.md#event-taxonomy
```

**Acceptance Criteria**

- [ ] Artifact common status is exactly `complete | partial`.
- [ ] Event envelope and type-specific union are runtime validated.
- [ ] Deprecated/noisy Event types are not introduced as canonical types.

**Test Levels:** `CONTRACT`

## STORY-02-05 — Seven Agent Definitions

**Goal:** Encode the final Agent roles and allowlists.

**Priority:** P0

```yaml
spec_refs:
  required:
    - 05-agents-and-skills.md#agent-definitions
    - 05-agents-and-skills.md#skill-allowlists
```

**Acceptance Criteria**

- [ ] Exactly seven formal Agent definitions exist.
- [ ] Modes/authority/skills/forbidden behavior match the specification.
- [ ] No Judge Agent is introduced.

**Test Levels:** `CONTRACT`

## STORY-02-06 — Six Playbook Definitions

**Goal:** Encode base graphs, policies, Gates, and mandatory/conditional work.

**Priority:** P0

```yaml
spec_refs:
  required:
    - 04-orchestration.md#playbooks
    - 04-orchestration.md#gate-matrix
```

**Acceptance Criteria**

- [ ] Exactly six Phase 1 Playbooks exist.
- [ ] Bug/Hotfix root-cause requirements are represented.
- [ ] Refactor invariant/preservation requirements are represented.
- [ ] Investigation base graph is read-only without normal Worker/Verifier.

**Test Levels:** `CONTRACT`, `UNIT`

# EPIC-03 — Pure Domain Engine

## STORY-03-01 — Step Graph and Lifecycle

**Priority:** P0

```yaml
spec_refs:
  required:
    - 03-domain-model.md#step
    - 04-orchestration.md#execution-graph
```

**Acceptance Criteria**

- [ ] DAG/reference validation rejects cycles/invalid dependencies.
- [ ] Valid Step transitions are enforced.
- [ ] Dynamic origin and skip/obsolete behavior are representable.

**Test Levels:** `UNIT`

## STORY-03-02 — Sequential Scheduler

**Priority:** P0

**Dependencies:** STORY-03-01

```yaml
spec_refs:
  required:
    - 04-orchestration.md#scheduler
    - 03-domain-model.md#gate
```

**Acceptance Criteria**

- [ ] At most one Step is selected in Phase 1.
- [ ] Dependency/Gate/blocker checks are deterministic.
- [ ] Priority/tie breaking is deterministic.
- [ ] Scheduler never mutates state.
- [ ] No-progress is detectable.

**Test Levels:** `UNIT`

## STORY-03-03 — Uncertainty Decision and Finding Lifecycle

**Priority:** P0

```yaml
spec_refs:
  required:
    - 03-domain-model.md#uncertainty
    - 03-domain-model.md#decision
    - 03-domain-model.md#finding
```

**Acceptance Criteria**

- [ ] U/D/F transitions match canonical states.
- [ ] Finding reopen preserves identity.
- [ ] Illegal state/disposition pairs are rejected.

**Test Levels:** `UNIT`

## STORY-03-04 — Gate Evaluators

**Priority:** P0

```yaml
spec_refs:
  required:
    - 03-domain-model.md#gate
    - 04-orchestration.md#gates
```

**Acceptance Criteria**

- [ ] Evidence/Uncertainty/Decision/Verification/Approval/Completion evaluators exist.
- [ ] Evaluators are side-effect free.
- [ ] Completion Gate delegates to CompletionEvaluator result rather than recursing.

**Test Levels:** `UNIT`

## STORY-03-05 — Requirement Mutation and Impact

**Priority:** P0

```yaml
spec_refs:
  required:
    - 03-domain-model.md#requirement-candidate
    - 03-domain-model.md#requirement-revisions
```

**Acceptance Criteria**

- [ ] Candidate operations/effects are validated.
- [ ] AC/C identity preservation/supersession is deterministic.
- [ ] Requirement changes can classify Plan impact/reclassification need.

**Test Levels:** `UNIT`

## STORY-03-06 — Applicability and Freshness

**Priority:** P0

```yaml
spec_refs:
  required:
    - 03-domain-model.md#plan-applicability
    - 03-domain-model.md#change-set-relevance
    - 03-domain-model.md#verification-freshness
    - 03-domain-model.md#review-freshness
```

**Acceptance Criteria**

- [ ] Plan/CS/VR/RR currentness is rule-first and deterministic.
- [ ] Semantic ambiguity produces `unknown`, not a fabricated answer.
- [ ] Stale VR/RR cannot satisfy completion.

**Test Levels:** `UNIT`

## STORY-03-07 — Dynamic Graph Mutation

**Priority:** P0

**Dependencies:** STORY-03-01, STORY-03-04

```yaml
spec_refs:
  required:
    - 04-orchestration.md#dynamic-graph-mutation
```

**Acceptance Criteria**

- [ ] Supported triggers can create dynamic Steps.
- [ ] Active equivalent purpose is deduplicated.
- [ ] `max_dynamic_steps` and graph invariants are enforced.
- [ ] Completed Steps are not reopened.

**Test Levels:** `UNIT`

## STORY-03-08 — Completion Evaluator

**Priority:** P0

**Dependencies:** STORY-03-03, STORY-03-04, STORY-03-06

```yaml
spec_refs:
  required:
    - 03-domain-model.md#completion-evaluator
```

**Acceptance Criteria**

- [ ] Eight completion domains are evaluated.
- [ ] AC/Constraint violation cannot be accepted away.
- [ ] Current Plan/implementation/repository/VR/RR/control blockers are represented.
- [ ] Evaluator is side-effect free.

**Test Levels:** `UNIT`

# EPIC-04 — Persistence and Run Store

## STORY-04-01 — Pointer-consistent Run Reader

**Priority:** P0

```yaml
spec_refs:
  required:
    - 06-persistence-and-artifacts.md#current-state-vs-history
    - 06-persistence-and-artifacts.md#state-snapshots
```

**Acceptance Criteria**

- [ ] `run.yaml` + referenced snapshot load consistently.
- [ ] Missing/corrupt current snapshot does not silently roll back.
- [ ] Future unsupported schema is rejected.

**Test Levels:** `INT`

## STORY-04-02 — Atomic State Snapshot Store

**Priority:** P0

**Dependencies:** STORY-04-01, STORY-02-03

```yaml
spec_refs:
  required:
    - 06-persistence-and-artifacts.md#atomic-state-commit
```

**Acceptance Criteria**

- [ ] Next snapshot is fully written/validated before pointer replacement.
- [ ] `run.yaml` replacement is the logical commit point.
- [ ] Crash before pointer leaves old state current.
- [ ] Expected revision mismatch fails.

**Test Levels:** `INT`, `CRASH`

## STORY-04-03 — Artifact Store

**Priority:** P0

```yaml
spec_refs:
  required:
    - 06-persistence-and-artifacts.md#artifact-lifecycle
    - 06-persistence-and-artifacts.md#artifact-naming
```

**Acceptance Criteria**

- [ ] Stage/validate/redact/atomic-finalize flow works.
- [ ] Finalized path overwrite is rejected.
- [ ] Traversal/symlink escape is rejected.
- [ ] State can reference only finalized Artifacts.
- [ ] Partial Artifact is distinct from staging draft.

**Test Levels:** `INT`, `SEC`

## STORY-04-04 — Requirement History

**Priority:** P0

```yaml
spec_refs:
  required:
    - 06-persistence-and-artifacts.md#requirement-revision-history
```

**Acceptance Criteria**

- [ ] `requirement-v<N>.yaml` is immutable.
- [ ] Current snapshot revision matches current Requirement revision.
- [ ] Raw initial `request.md` is not rewritten on amendment.

**Test Levels:** `INT`

## STORY-04-05 — Event Reader and Writer

**Priority:** P1

```yaml
spec_refs:
  required:
    - 06-persistence-and-artifacts.md#event-log-storage
    - 08-observability-and-evaluation.md#event-semantics
```

**Acceptance Criteria**

- [ ] JSONL sequence/event IDs are writer-owned and monotonic in write order.
- [ ] Corrupt line does not block state load.
- [ ] Event append failure does not roll back committed state.

**Test Levels:** `INT`, `CRASH`

## STORY-04-06 — Run Lock and Revision Conflict

**Priority:** P0

```yaml
spec_refs:
  required:
    - 07-security-recovery-and-repository.md#locks
    - 06-persistence-and-artifacts.md#atomic-state-commit
```

**Acceptance Criteria**

- [ ] One Run has one logical writer owner.
- [ ] Concurrent commit with wrong revision is rejected.
- [ ] Stale-lock handling never blindly steals a live lock.

**Test Levels:** `INT`, `CRASH`

## STORY-04-07 — Migration Infrastructure

**Priority:** P0

```yaml
spec_refs:
  required:
    - 06-persistence-and-artifacts.md#migration
```

**Acceptance Criteria**

- [ ] Reader can route old known schemas through sequential in-memory migration.
- [ ] Historical snapshots are not rewritten on read.
- [ ] Unknown future schema is rejected.

**Test Levels:** `CONTRACT`

# EPIC-05 — Orchestrator and Fake Runtime

## STORY-05-01 — Orchestrator Control Loop

**Priority:** P0

**Dependencies:** EPIC-03, STORY-04-02

```yaml
spec_refs:
  required:
    - 02-runtime-architecture.md#runtime-control-loop
    - 04-orchestration.md#dynamic-graph-mutation
    - 04-orchestration.md#completion
```

**Acceptance Criteria**

- [ ] Load/recover/reconcile/trigger/completion/schedule/dispatch/finalize/commit/event order is preserved.
- [ ] One major state transition is processed per iteration.
- [ ] Agent result is untrusted until validation/postconditions pass.

**Test Levels:** `UNIT`, `INT`

## STORY-05-02 — FakeAgentRuntime and Fixtures

**Priority:** P0

```yaml
spec_refs:
  required:
    - 10-implementation-specification.md#fakeagentruntime
```

**Acceptance Criteria**

- [ ] Fixtures can return completed/blocked/failed/invalid results deterministically.
- [ ] Fake runtime remains reusable after Phase 1 implementation.

**Test Levels:** `INT`

## STORY-05-03 — Context Builder

**Priority:** P0

```yaml
spec_refs:
  required:
    - 02-runtime-architecture.md#context-builder
    - 05-agents-and-skills.md#context-manifest
```

**Acceptance Criteria**

- [ ] Current authoritative refs are selected by priority.
- [ ] Conversation is not required/default context.
- [ ] Stale/superseded evidence is excluded from authoritative context.
- [ ] Budget errors do not drop required Requirement/Decision content.

**Test Levels:** `UNIT`

## STORY-05-04 — Result Normalization Pipeline

**Priority:** P0

**Dependencies:** STORY-02-02, STORY-04-03

```yaml
spec_refs:
  required:
    - 05-agents-and-skills.md#step-result
    - 10-implementation-specification.md#result-normalization
```

**Acceptance Criteria**

- [ ] Schema/identity/role/ref/permission/postcondition validation order is implemented.
- [ ] Candidate IDs are normalized centrally.
- [ ] Required Artifact failure prevents successful Step acceptance.

**Test Levels:** `CONTRACT`, `INT`

## STORY-05-05 — Six Playbook Fake E2E

**Priority:** P0

**Dependencies:** STORY-05-01, STORY-05-02, STORY-05-03, STORY-05-04

```yaml
spec_refs:
  required:
    - 04-orchestration.md#playbooks
```

**Acceptance Criteria**

- [ ] Feature/Bug/Hotfix/Chore/Refactor/Investigation complete with deterministic fake outputs.
- [ ] Persisted State/Artifacts/Events/Outcome are coherent.

**Test Levels:** `E2E`

**Release Gate:** Gate A

## STORY-05-06 — Dynamic Fake E2E

**Priority:** P0

**Dependencies:** STORY-05-05

```yaml
spec_refs:
  required:
    - 04-orchestration.md#dynamic-graph-mutation
    - 04-orchestration.md#verification-and-review-fix-loop
    - 04-orchestration.md#request-amendment
```

**Acceptance Criteria**

- [ ] Researcher/Oracle insertion paths work.
- [ ] D3 block/user resolution/resume works.
- [ ] Verification/Review fix cycle works.
- [ ] Requirement amendment → applicability/re-plan works.
- [ ] Playbook switch preserves Run/history.

**Test Levels:** `E2E`

# EPIC-06 — Pi Package and Runtime Integration

## STORY-06-01 — PiSubagentsAdapter

**Priority:** P0

**Dependencies:** Gate A

```yaml
spec_refs:
  required:
    - 02-runtime-architecture.md#agent-runtime-boundary
    - 10-implementation-specification.md#pisubagentsadapter
    - 10-implementation-specification.md#package-manifest
```

**Acceptance Criteria**

- [ ] One request maps to one Agent Execution.
- [ ] Adapter returns StepResult contract only.
- [ ] Adapter never commits Workflow State.
- [ ] No giant multi-Agent workflowScript exists.
- [ ] The Adapter is reached through the installed/local Pi Package Extension entry point rather than copied `.pi/` source files.

**Test Levels:** `INT`

## STORY-06-02 — Prompt Assembler

**Priority:** P0

```yaml
spec_refs:
  required:
    - 05-agents-and-skills.md#prompt-assembly
    - 10-implementation-specification.md#prompt-assembler
```

**Acceptance Criteria**

- [ ] Stable precedence/order is implemented.
- [ ] Only resolved selected context/Skills are included.
- [ ] Full prompt is not persisted in Standard telemetry.

**Test Levels:** `UNIT`, `INT`

## STORY-06-03 — Skill Catalog

**Priority:** P0

```yaml
spec_refs:
  required:
    - 05-agents-and-skills.md#skill-model
    - 05-agents-and-skills.md#skill-allowlists
    - 05-agents-and-skills.md#skill-packaging-and-discovery
    - 10-implementation-specification.md#skill-catalog
```

**Acceptance Criteria**

- [ ] Nine Core Skills are discoverable/versioned.
- [ ] Dependencies/allowlists are validated.
- [ ] Allowlisted Skills are not automatically loaded.
- [ ] Skills are resolved as Pi Package resources and do not require `.pi/agent/skills/` source placement.

**Test Levels:** `CONTRACT`

## STORY-06-04 — Model and Tool Resolution

**Priority:** P0

```yaml
spec_refs:
  required:
    - 05-agents-and-skills.md#tool-model
    - 05-agents-and-skills.md#model-and-provider-routing
```

**Acceptance Criteria**

- [ ] Capability → concrete Tool is least-privilege.
- [ ] Requested/actual model are recorded.
- [ ] Only configured fallback is allowed.
- [ ] Resolution cannot widen permission/authority.

**Test Levels:** `INT`

## STORY-06-05 — Real Read-only Agent Smoke Tests

**Priority:** P0

**Dependencies:** STORY-06-01..04

```yaml
spec_refs:
  required:
    - 05-agents-and-skills.md#scout
    - 05-agents-and-skills.md#planner
    - 05-agents-and-skills.md#researcher
    - 05-agents-and-skills.md#oracle
    - 10-implementation-specification.md#local-package-development
```

**Acceptance Criteria**

- [ ] Real Scout output normalizes successfully.
- [ ] Real Planner output normalizes successfully.
- [ ] Read-only permissions are actually enforced.
- [ ] Schema-invalid output takes bounded recovery/retry path.
- [ ] Smoke tests load the repository through the local Pi Package manifest and resolve the packaged Skills without copied `.pi/agent/skills/` source.

**Test Levels:** `INT`

# EPIC-07 — Repository Mutation Verification and Review

## STORY-07-01 — Git Repository Adapter

**Priority:** P0

```yaml
spec_refs:
  required:
    - 07-security-recovery-and-repository.md#repository-baseline
    - 10-implementation-specification.md#repository-adapter
```

**Acceptance Criteria**

- [ ] HEAD/branch/status/snapshot/diff/fingerprint facts are available.
- [ ] Adapter does not decide semantic relevance/re-plan.

**Test Levels:** `INT`

## STORY-07-02 — Workspace and Baseline Protection

**Priority:** P0

```yaml
spec_refs:
  required:
    - 07-security-recovery-and-repository.md#locks
    - 07-security-recovery-and-repository.md#pre-existing-changes
```

**Acceptance Criteria**

- [ ] Current-tree workspace is lockable.
- [ ] Run/pre-Worker baselines preserve dirty/untracked facts.

**Test Levels:** `INT`, `SEC`

## STORY-07-03 — Worker and Change Set Finalizer

**Priority:** P0

**Dependencies:** STORY-07-01, STORY-07-02

```yaml
spec_refs:
  required:
    - 05-agents-and-skills.md#worker
    - 03-domain-model.md#change-set
    - 07-security-recovery-and-repository.md#write-scope
    - 07-security-recovery-and-repository.md#mutation-attribution
    - 06-persistence-and-artifacts.md#change-set-artifact
```

**Acceptance Criteria**

- [ ] Runtime validates actual diff against Write Scope.
- [ ] Pre-existing changes are preserved/attributed.
- [ ] Complete/partial/no-op CS finalization works.
- [ ] Git write is denied.

**Test Levels:** `INT`, `E2E`, `SEC`

## STORY-07-04 — Verifier and Verification Run Finalizer

**Priority:** P0

```yaml
spec_refs:
  required:
    - 05-agents-and-skills.md#verifier
    - 03-domain-model.md#verification-run
    - 06-persistence-and-artifacts.md#verification-run-artifact
```

**Acceptance Criteria**

- [ ] Formal checks distinguish passed/failed/skipped/unavailable.
- [ ] VR result/strength/basis/evidence are finalized.
- [ ] Verifier source mutation is detected/rejected.
- [ ] Failed required check is not converted to success by acceptance.

**Test Levels:** `INT`, `E2E`, `SEC`

## STORY-07-05 — Reviewer Review Run and Finding Normalization

**Priority:** P0

```yaml
spec_refs:
  required:
    - 05-agents-and-skills.md#reviewer
    - 03-domain-model.md#review-run
    - 03-domain-model.md#finding
    - 06-persistence-and-artifacts.md#review-run-artifact
```

**Acceptance Criteria**

- [ ] RR and F-ID candidate normalization work.
- [ ] Rechecks can fix/dismiss/reopen the same Finding identity.
- [ ] Reviewer source mutation is denied.

**Test Levels:** `INT`, `E2E`, `SEC`

## STORY-07-06 — Fix Reverify Rereview Cycle

**Priority:** P0

**Dependencies:** STORY-07-03..05

```yaml
spec_refs:
  required:
    - 04-orchestration.md#verification-and-review-fix-loop
```

**Acceptance Criteria**

- [ ] Verification failure inserts bounded fix/reverify path.
- [ ] Blocking Finding inserts bounded fix/reverify/rereview path.
- [ ] Final current evidence becomes fresh before completion.

**Test Levels:** `E2E`

## STORY-07-07 — Dirty Tree Safety Matrix

**Priority:** P0

```yaml
spec_refs:
  required:
    - 07-security-recovery-and-repository.md#pre-existing-changes
    - 07-security-recovery-and-repository.md#repository-drift
```

**Acceptance Criteria**

- [ ] Pre-existing modified/untracked files are preserved.
- [ ] Same-file overlap is conservatively attributed.
- [ ] External edits during Worker are detected.
- [ ] Lost hunk/scope violation/uncertain attribution blocks safe acceptance.

**Test Levels:** `SEC`, `E2E`

**Release Gate:** Gate B

# EPIC-08 — Recovery Resume and Cancellation

## STORY-08-01 — Startup Recovery Manager

**Priority:** P0

```yaml
spec_refs:
  required:
    - 07-security-recovery-and-repository.md#recovery-manager
```

**Acceptance Criteria**

- [ ] Load/migrate/lock/workspace/drift/interruption/cancellation order is implemented.
- [ ] State is reloaded after lock where needed.

**Test Levels:** `CRASH`

## STORY-08-02 — Interrupted Execution Recovery

**Priority:** P0

```yaml
spec_refs:
  required:
    - 07-security-recovery-and-repository.md#interrupted-execution
```

**Acceptance Criteria**

- [ ] Read-only interrupted execution has safe retry policy.
- [ ] Interrupted Worker inspects/reconciles repository before any retry.
- [ ] Partial mutation can produce partial record/recovery path.

**Test Levels:** `CRASH`

## STORY-08-03 — Resume Lifecycle

**Priority:** P0

```yaml
spec_refs:
  required:
    - 07-security-recovery-and-repository.md#resume
```

**Acceptance Criteria**

- [ ] blocked/resumable failed can resume.
- [ ] completed/cancelled/final failed cannot resume.
- [ ] budgets are not reset.
- [ ] resume re-checks repository/freshness.

**Test Levels:** `E2E`

## STORY-08-04 — Repository Drift Recovery

**Priority:** P0

```yaml
spec_refs:
  required:
    - 07-security-recovery-and-repository.md#repository-drift
    - 07-security-recovery-and-repository.md#repository-reconciliation
```

**Acceptance Criteria**

- [ ] unrelated/relevant/critical/unknown paths behave safely.
- [ ] relevant drift invalidates/reconciles Plan/evidence as required.

**Test Levels:** `E2E`

## STORY-08-05 — Cancellation Lifecycle

**Priority:** P0

```yaml
spec_refs:
  required:
    - 07-security-recovery-and-repository.md#cancellation
```

**Acceptance Criteria**

- [ ] cancellation intent is persisted before abort.
- [ ] no new dispatch occurs after intent.
- [ ] Worker mutation is reconciled, not rolled back blindly.
- [ ] cancelled Run becomes finalized with Outcome.

**Test Levels:** `CRASH`, `E2E`

## STORY-08-06 — Failure Records and Finalization

**Priority:** P0

```yaml
spec_refs:
  required:
    - 07-security-recovery-and-repository.md#run-failure
    - 06-persistence-and-artifacts.md#failure-records
    - 06-persistence-and-artifacts.md#outcome
```

**Acceptance Criteria**

- [ ] Resumable failed has Failure Record, no Outcome, `finalized=false`.
- [ ] Final failed has Failure Record + Outcome + `finalized=true`.
- [ ] Successful resume clears current failure pointer only.

**Test Levels:** `E2E`, `CRASH`

# EPIC-09 — Commands and User Interaction

## STORY-09-01 — Six Start Commands

**Priority:** P0

```yaml
spec_refs:
  required:
    - 10-implementation-specification.md#commands
    - 04-orchestration.md#playbooks
```

**Acceptance Criteria**

- [ ] Six `/wf-*` start commands invoke the new runtime/use cases.
- [ ] Commands are registered through the Pi Package Extension entry point.
- [ ] Commands contain no Playbook orchestration logic.

**Test Levels:** `E2E`

## STORY-09-02 — Status Resume Cancel Commands

**Priority:** P0

```yaml
spec_refs:
  required:
    - 10-implementation-specification.md#commands
    - 07-security-recovery-and-repository.md#resume
    - 07-security-recovery-and-repository.md#cancellation
```

**Acceptance Criteria**

- [ ] `/wf-status` is read-only.
- [ ] `/wf-resume` follows resumability rules.
- [ ] `/wf-cancel` follows crash-safe cancellation lifecycle.

**Test Levels:** `E2E`

## STORY-09-03 — User Interaction D3 and Clarification

**Priority:** P0

```yaml
spec_refs:
  required:
    - 02-runtime-architecture.md#user-interaction-boundary
    - 05-agents-and-skills.md#decision-authority
```

**Acceptance Criteria**

- [ ] D3 approval/options/custom answer/cancel are supported through adapter.
- [ ] Agent cannot directly invoke user interaction.
- [ ] User answer is applied through an Orchestrator state transition.

**Test Levels:** `INT`

## STORY-09-04 — Compact Progress and Final Rendering

**Priority:** P1

```yaml
spec_refs:
  required:
    - 01-overview.md#core-principles
    - 06-persistence-and-artifacts.md#outcome
```

**Acceptance Criteria**

- [ ] Progress contains compact milestone/blocker information.
- [ ] Agent transcript is not echoed wholesale into Main Session.
- [ ] Final response is derived from final Outcome/current state.

**Test Levels:** `E2E`

**Release Gate:** Gate C

# EPIC-10 — Telemetry and Evaluation

## STORY-10-01 — Event Taxonomy Correlation and Causality

**Priority:** P1

```yaml
spec_refs:
  required:
    - 08-observability-and-evaluation.md#event-taxonomy
    - 08-observability-and-evaluation.md#correlation
    - 08-observability-and-evaluation.md#causality
```

**Acceptance Criteria**

- [ ] Canonical Event types are emitted at correct transitions.
- [ ] Retired noisy Events are not emitted.
- [ ] Sequence/correlation/caused_by follow contract.

**Test Levels:** `CONTRACT`, `INT`

## STORY-10-02 — Execution Tool and Context Telemetry

**Priority:** P1

```yaml
spec_refs:
  required:
    - 08-observability-and-evaluation.md#runtime-metrics
    - 08-observability-and-evaluation.md#telemetry-levels
```

**Acceptance Criteria**

- [ ] Timing/tokens/context/model/tool/skill measurements are captured where available.
- [ ] Standard telemetry does not persist full prompts/tool results.
- [ ] Secret redaction is applied.

**Test Levels:** `INT`

## STORY-10-03 — RunMetricsAggregator

**Priority:** P1

```yaml
spec_refs:
  required:
    - 08-observability-and-evaluation.md#run-metrics-aggregator
```

**Acceptance Criteria**

- [ ] Retry/replan/fix/blocked/VR/RR/Finding metrics are deterministic.
- [ ] Missing telemetry remains null/unavailable rather than zero.

**Test Levels:** `UNIT`

## STORY-10-04 — RunEvaluationRecord

**Priority:** P1

```yaml
spec_refs:
  required:
    - 08-observability-and-evaluation.md#run-evaluation-record
    - 08-observability-and-evaluation.md#evaluation-dimensions
    - 08-observability-and-evaluation.md#fair-comparison
```

**Acceptance Criteria**

- [ ] provisional/final evaluation works.
- [ ] telemetry quality and source revision/sequence are recorded.
- [ ] same source + evaluator version is deterministic.
- [ ] no required scalar score/grade is produced.

**Test Levels:** `UNIT`

## STORY-10-05 — Telemetry Levels and Degradation

**Priority:** P1

```yaml
spec_refs:
  required:
    - 08-observability-and-evaluation.md#telemetry-levels
    - 08-observability-and-evaluation.md#telemetry-quality
```

**Acceptance Criteria**

- [ ] minimal/standard/debug behavior is explicit.
- [ ] Event corruption/gap/telemetry writer failure produces degraded quality.
- [ ] Workflow state correctness remains independent from telemetry completeness.

**Test Levels:** `INT`, `CRASH`

# EPIC-11 — Monitoring Web App

## STORY-11-01 — Run Discovery and SQLite Index

**Priority:** P1

```yaml
spec_refs:
  required:
    - 09-monitoring.md#run-discovery
    - 09-monitoring.md#derived-sqlite-index
    - 09-monitoring.md#incremental-indexing
```

**Acceptance Criteria**

- [ ] Valid/degraded/unreadable Run candidates are handled.
- [ ] SQLite can be deleted and rebuilt.
- [ ] State revision/Event sequence incremental indexing works.

**Test Levels:** `INT`

## STORY-11-02 — Read-only API

**Priority:** P1

```yaml
spec_refs:
  required:
    - 09-monitoring.md#api
    - 09-monitoring.md#security
```

**Acceptance Criteria**

- [ ] `/api/v1` read endpoints cover Run/detail/graph/events/steps/executions/artifacts/evaluation/compare.
- [ ] No workflow-control mutation endpoint is present.
- [ ] Artifact path traversal/symlink escape is rejected.

**Test Levels:** `INT`, `SEC`

## STORY-11-03 — Run Overview and Timeline

**Priority:** P1

```yaml
spec_refs:
  required:
    - 09-monitoring.md#run-list-ui
    - 09-monitoring.md#run-overview
    - 09-monitoring.md#timeline
```

**Acceptance Criteria**

- [ ] Run lifecycle variants are visually distinguishable.
- [ ] Correctness/blocker information precedes efficiency for relevant views.
- [ ] Timeline uses Event sequence and collapses Tool detail by default.

**Test Levels:** `E2E`

## STORY-11-04 — Graph Step and Artifact Detail

**Priority:** P1

```yaml
spec_refs:
  required:
    - 09-monitoring.md#execution-graph
    - 09-monitoring.md#step-and-execution-detail
    - 09-monitoring.md#artifact-viewer
```

**Acceptance Criteria**

- [ ] Step graph uses Steps/depends_on; Gates are annotations.
- [ ] Dynamic origin/skip reason is visible.
- [ ] Artifact bodies are lazy-loaded and sanitized.
- [ ] VR/RR/F detail is accessible.

**Test Levels:** `E2E`, `SEC`

## STORY-11-05 — Evaluation and Compare

**Priority:** P1

```yaml
spec_refs:
  required:
    - 08-observability-and-evaluation.md#fair-comparison
    - 09-monitoring.md#evaluation-view
    - 09-monitoring.md#compare-view
```

**Acceptance Criteria**

- [ ] Two Runs can be compared with comparability warnings.
- [ ] null/degraded metrics are not treated as zero/reliable.
- [ ] Outcome/risks appear before efficiency.
- [ ] no automatic winner/scalar score is required.

**Test Levels:** `E2E`

**Release Gate:** Gate D

## STORY-11-06 — Live Update and Degraded Handling

**Priority:** P2

```yaml
spec_refs:
  required:
    - 09-monitoring.md#live-updates
    - 09-monitoring.md#degraded-state-handling
```

**Acceptance Criteria**

- [ ] watcher hint + periodic reconciliation recovers missed updates.
- [ ] SSE reconnect/refetch is safe.
- [ ] corrupt Event/missing Artifact/index error is surfaced without mutating Workflow state.

**Test Levels:** `E2E`

# EPIC-12 — Hardening and Cutover

## STORY-12-01 — Golden Repositories

**Priority:** P0

```yaml
spec_refs:
  required:
    - 10-implementation-specification.md#testing-strategy
```

**Acceptance Criteria**

- [ ] Reproducible fixtures cover feature/bug/hotfix/chore/refactor/investigation and dirty-tree cases.

**Test Levels:** `E2E`

## STORY-12-02 — Crash Matrix

**Priority:** P0

```yaml
spec_refs:
  required:
    - 06-persistence-and-artifacts.md#atomic-state-commit
    - 07-security-recovery-and-repository.md#interrupted-execution
    - 07-security-recovery-and-repository.md#cancellation
```

**Acceptance Criteria**

- [ ] Crash before/during Agent, during Worker, after Artifact, after State, during resume/cancel is covered.
- [ ] Current State remains old-or-new complete, never partial mixed state.

**Test Levels:** `CRASH`

## STORY-12-03 — Security and Permission Matrix

**Priority:** P0

```yaml
spec_refs:
  required:
    - 07-security-recovery-and-repository.md#agent-permission-enforcement
    - 07-security-recovery-and-repository.md#git-policy
    - 07-security-recovery-and-repository.md#secrets
```

**Acceptance Criteria**

- [ ] Scout/Planner/Reviewer/Verifier write restrictions are enforced.
- [ ] Worker scope/Git rules are enforced.
- [ ] Network/path traversal/secret persistence cases are covered.

**Test Levels:** `SEC`

## STORY-12-04 — Context and Conversation Independence

**Priority:** P0

```yaml
spec_refs:
  required:
    - 02-runtime-architecture.md#context-layers
    - 02-runtime-architecture.md#context-builder
```

**Acceptance Criteria**

- [ ] Resume works without chat history.
- [ ] Main Session does not need normal repository exploration.
- [ ] Artifact/State handoff is sufficient for subsequent Steps.

**Test Levels:** `E2E`

## STORY-12-05 — Cross-platform Persistence and Git

**Priority:** P0

```yaml
spec_refs:
  required:
    - 06-persistence-and-artifacts.md#atomic-state-commit
    - 07-security-recovery-and-repository.md#locks
```

**Acceptance Criteria**

- [ ] macOS/Linux/Windows relevant path/rename/process/lock/Git behavior is validated.

**Test Levels:** `INT`

## STORY-12-06 — Legacy Cutover

**Priority:** P0

**Dependencies:** Gates A–D and hardening tests

```yaml
spec_refs:
  required:
    - 10-implementation-specification.md#hardening
```

**Acceptance Criteria**

- [ ] `/wf-*` uses the new runtime after release gates pass.
- [ ] Obsolete runtime is removed only after stabilization.
- [ ] `workflow-tui.ts` is removed as planned.
- [ ] Legacy session transcript migration is not introduced.

**Test Levels:** `E2E`

# Critical Path

```text
Foundation
  ↓
Contracts
  ↓
Domain
  ↓
Persistence
  ↓
Fake Orchestrator E2E   ← Gate A
  ↓
Pi Integration
  ↓
Write / Verify / Review ← Gate B
  ↓
Recovery / Commands     ← Gate C
  ↓
Telemetry / Evaluation
  ↓
Monitoring / Compare    ← Gate D
  ↓
Hardening / Cutover
  ↓
Phase 1 Release
```

# Release Gates

## Gate A — Engine Core

All six Playbooks complete using `FakeAgentRuntime`, including key dynamic paths.

## Gate B — Real Execution Safety

Real Worker/Verifier/Reviewer flow passes Write Scope, dirty-tree, Change Set, Verification, Review, and fix-cycle tests.

## Gate C — Operational Safety

Recovery, resume, cancellation, D3 interaction, and command integration are usable for normal operation.

## Gate D — Evaluation

Runs can be indexed, observed, evaluated, and compared with telemetry quality/comparability handling.

## Phase 1 Release

Requires architecture/domain/persistence/crash/fake-E2E/real-write/recovery/security/evaluation/Monitoring hard gates to pass. Parallelism begins only after multiple stable Phase 1 Runs establish an evaluation baseline.
