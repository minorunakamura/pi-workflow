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

- [x] A runtime factory/composition module exists.
- [x] Application modules do not instantiate concrete persistence/Pi/Git adapters.
- [x] Manual constructor injection is sufficient; no Service Locator is added.

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

- [x] Types/functions exist for Run/Step/Execution/U/D/G/F/PD/CS/VR/RR IDs.
- [x] `P-*` and `V-*` references carry Plan version.
- [x] Issued IDs are not reused; gaps are allowed.

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

- [x] Request/result schema validates identity, arrays, outcomes, and mode.
- [x] Agent result candidates cannot submit authoritative State IDs.
- [x] Invalid shape is rejected deterministically.

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

- [x] Six state-file schemas and manifest schema exist.
- [x] `finalized` is separate from status.
- [x] `current_plan` cannot use `superseded` applicability.
- [x] Stable arrays/nullable fields follow the specified shape.

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

- [x] Artifact common status is exactly `complete | partial`.
- [x] Event envelope and type-specific union are runtime validated.
- [x] Deprecated/noisy Event types are not introduced as canonical types.

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

- [x] Exactly seven formal Agent definitions exist.
- [x] Modes/authority/skills/forbidden behavior match the specification.
- [x] No Judge Agent is introduced.

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

- [x] Exactly six Phase 1 Playbooks exist.
- [x] Bug/Hotfix root-cause requirements are represented.
- [x] Refactor invariant/preservation requirements are represented.
- [x] Investigation base graph is read-only without normal Worker/Verifier.

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

- [x] DAG/reference validation rejects cycles/invalid dependencies.
- [x] Valid Step transitions are enforced.
- [x] Dynamic origin and skip/obsolete behavior are representable.

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

- [x] At most one Step is selected in Phase 1.
- [x] Dependency/Gate/blocker checks are deterministic.
- [x] Priority/tie breaking is deterministic.
- [x] Scheduler never mutates state.
- [x] No-progress is detectable.

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

- [x] U/D/F transitions match canonical states.
- [x] Finding reopen preserves identity.
- [x] Illegal state/disposition pairs are rejected.

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

- [x] Evidence/Uncertainty/Decision/Verification/Approval/Completion evaluators exist.
- [x] Evaluators are side-effect free.
- [x] Completion Gate delegates to CompletionEvaluator result rather than recursing.

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

- [x] Candidate operations/effects are validated.
- [x] AC/C identity preservation/supersession is deterministic.
- [x] Requirement changes can classify Plan impact/reclassification need.

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

- [x] Plan/CS/VR/RR currentness is rule-first and deterministic.
- [x] Semantic ambiguity produces `unknown`, not a fabricated answer.
- [x] Stale VR/RR cannot satisfy completion.

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

- [x] Supported triggers can create dynamic Steps.
- [x] Active equivalent purpose is deduplicated.
- [x] `max_dynamic_steps` and graph invariants are enforced.
- [x] Completed Steps are not reopened.

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

- [x] Eight completion domains are evaluated.
- [x] AC/Constraint violation cannot be accepted away.
- [x] Current Plan/implementation/repository/VR/RR/control blockers are represented.
- [x] Evaluator is side-effect free.

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

- [x] `run.yaml` + referenced snapshot load consistently.
- [x] Missing/corrupt current snapshot does not silently roll back.
- [x] Future unsupported schema is rejected.

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

- [x] Next snapshot is fully written/validated before pointer replacement.
- [x] `run.yaml` replacement is the logical commit point.
- [x] Crash before pointer leaves old state current.
- [x] Expected revision mismatch fails.

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

- [x] Stage/validate/redact/atomic-finalize flow works.
- [x] Finalized path overwrite is rejected.
- [x] Traversal/symlink escape is rejected.
- [x] State can reference only finalized Artifacts.
- [x] Partial Artifact is distinct from staging draft.

**Test Levels:** `INT`, `SEC`

## STORY-04-04 — Requirement History

**Priority:** P0

```yaml
spec_refs:
  required:
    - 06-persistence-and-artifacts.md#requirement-revision-history
```

**Acceptance Criteria**

- [x] `requirement-v<N>.yaml` is immutable.
- [x] Current snapshot revision matches current Requirement revision.
- [x] Raw initial `request.md` is not rewritten on amendment.

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

- [x] JSONL sequence/event IDs are writer-owned and monotonic in write order.
- [x] Corrupt line does not block state load.
- [x] Event append failure does not roll back committed state.

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

- [x] One Run has one logical writer owner.
- [x] Concurrent commit with wrong revision is rejected.
- [x] Stale-lock handling never blindly steals a live lock.

**Test Levels:** `INT`, `CRASH`

## STORY-04-07 — Migration Infrastructure

**Priority:** P0

```yaml
spec_refs:
  required:
    - 06-persistence-and-artifacts.md#migration
```

**Acceptance Criteria**

- [x] Reader can route old known schemas through sequential in-memory migration.
- [x] Historical snapshots are not rewritten on read.
- [x] Unknown future schema is rejected.

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

- [x] Load/recover/reconcile/trigger/completion/schedule/dispatch/finalize/commit/event order is preserved.
- [x] One major state transition is processed per iteration.
- [x] Agent result is untrusted until validation/postconditions pass.

**Test Levels:** `UNIT`, `INT`

## STORY-05-02 — FakeAgentRuntime and Fixtures

**Priority:** P0

```yaml
spec_refs:
  required:
    - 10-implementation-specification.md#fakeagentruntime
```

**Acceptance Criteria**

- [x] Fixtures can return completed/blocked/failed/invalid results deterministically.
- [x] Fake runtime remains reusable after Phase 1 implementation.

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

- [x] Current authoritative refs are selected by priority.
- [x] Conversation is not required/default context.
- [x] Stale/superseded evidence is excluded from authoritative context.
- [x] Budget errors do not drop required Requirement/Decision content.

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

- [x] Schema/identity/role/ref/permission/postcondition validation order is implemented.
- [x] Candidate IDs are normalized centrally.
- [x] Required Artifact failure prevents successful Step acceptance.

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

- [x] Feature/Bug/Hotfix/Chore/Refactor/Investigation complete with deterministic fake outputs.
- [x] Persisted State/Artifacts/Events/Outcome are coherent.

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

- [x] Researcher/Oracle insertion paths work.
- [x] D3 block/user resolution/resume works.
- [x] Verification/Review fix cycle works.
- [x] Requirement amendment → applicability/re-plan works.
- [x] Playbook switch preserves Run/history.

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

- [x] One request maps to one Agent Execution.
- [x] Adapter returns StepResult contract only.
- [x] Adapter never commits Workflow State.
- [x] No giant multi-Agent workflowScript exists.
- [x] The Adapter is reached through the installed/local Pi Package Extension entry point rather than copied `.pi/` source files.

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

- [x] Stable precedence/order is implemented.
- [x] Only resolved selected context/Skills are included.
- [x] Full prompt is not persisted in Standard telemetry.

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

- [x] Nine Core Skills are discoverable/versioned.
- [x] Dependencies/allowlists are validated.
- [x] Allowlisted Skills are not automatically loaded.
- [x] Skills are resolved as Pi Package resources and do not require `.pi/agent/skills/` source placement.

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

- [x] Capability → concrete Tool is least-privilege.
- [x] Requested/actual model are recorded.
- [x] Only configured fallback is allowed.
- [x] Resolution cannot widen permission/authority.

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

- [x] Real Scout output normalizes successfully.
- [x] Real Planner output normalizes successfully.
- [x] Read-only permissions are actually enforced.
- [x] Schema-invalid output takes bounded recovery/retry path.
- [x] Smoke tests load the repository through the local Pi Package manifest and resolve the packaged Skills without copied `.pi/agent/skills/` source.

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

- [x] HEAD/branch/status/snapshot/diff/fingerprint facts are available.
- [x] Adapter does not decide semantic relevance/re-plan.

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

- [x] Current-tree workspace is lockable.
- [x] Run/pre-Worker baselines preserve dirty/untracked facts.

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

- [x] Runtime validates actual diff against Write Scope.
- [x] Pre-existing changes are preserved/attributed.
- [x] Complete/partial/no-op CS finalization works.
- [x] Git write is denied.

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

- [x] Formal checks distinguish passed/failed/skipped/unavailable.
- [x] VR result/strength/basis/evidence are finalized.
- [x] Verifier source mutation is detected/rejected.
- [x] Failed required check is not converted to success by acceptance.

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

- [x] RR and F-ID candidate normalization work.
- [x] Rechecks can fix/dismiss/reopen the same Finding identity.
- [x] Reviewer source mutation is denied.

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

- [x] Verification failure inserts bounded fix/reverify path.
- [x] Blocking Finding inserts bounded fix/reverify/rereview path.
- [x] Final current evidence becomes fresh before completion.

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

- [x] Pre-existing modified/untracked files are preserved.
- [x] Same-file overlap is conservatively attributed.
- [x] External edits during Worker are detected.
- [x] Lost hunk/scope violation/uncertain attribution blocks safe acceptance.

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

- [x] Load/migrate/lock/workspace/drift/interruption/cancellation order is implemented.
- [x] State is reloaded after lock where needed.

**Test Levels:** `CRASH`

## STORY-08-02 — Interrupted Execution Recovery

**Priority:** P0

```yaml
spec_refs:
  required:
    - 07-security-recovery-and-repository.md#interrupted-execution
```

**Acceptance Criteria**

- [x] Read-only interrupted execution has safe retry policy.
- [x] Interrupted Worker inspects/reconciles repository before any retry.
- [x] Partial mutation can produce partial record/recovery path.

**Test Levels:** `CRASH`

## STORY-08-03 — Resume Lifecycle

**Priority:** P0

```yaml
spec_refs:
  required:
    - 07-security-recovery-and-repository.md#resume
```

**Acceptance Criteria**

- [x] blocked/resumable failed can resume.
- [x] completed/cancelled/final failed cannot resume.
- [x] budgets are not reset.
- [x] resume re-checks repository/freshness.

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

- [x] unrelated/relevant/critical/unknown paths behave safely.
- [x] relevant drift invalidates/reconciles Plan/evidence as required.

**Test Levels:** `E2E`

## STORY-08-05 — Cancellation Lifecycle

**Priority:** P0

```yaml
spec_refs:
  required:
    - 07-security-recovery-and-repository.md#cancellation
```

**Acceptance Criteria**

- [x] cancellation intent is persisted before abort.
- [x] no new dispatch occurs after intent.
- [x] Worker mutation is reconciled, not rolled back blindly.
- [x] cancelled Run becomes finalized with Outcome.

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

- [x] Resumable failed has Failure Record, no Outcome, `finalized=false`.
- [x] Final failed has Failure Record + Outcome + `finalized=true`.
- [x] Successful resume clears current failure pointer only.

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

- [x] Six `/wf-*` start commands invoke the new runtime/use cases.
- [x] Commands are registered through the Pi Package Extension entry point.
- [x] Commands contain no Playbook orchestration logic.

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

- [x] `/wf-status` is read-only.
- [x] `/wf-resume` follows resumability rules.
- [x] `/wf-cancel` follows crash-safe cancellation lifecycle.

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

- [x] D3 approval/options/custom answer/cancel are supported through adapter.
- [x] Agent cannot directly invoke user interaction.
- [x] User answer is applied through an Orchestrator state transition.

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

- [x] Progress contains compact milestone/blocker information.
- [x] Agent transcript is not echoed wholesale into Main Session.
- [x] Final response is derived from final Outcome/current state.

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

- [x] Canonical Event types are emitted at correct transitions.
- [x] Retired noisy Events are not emitted.
- [x] Sequence/correlation/caused_by follow contract.

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

- [x] Timing/tokens/context/model/tool/skill measurements are captured where available.
- [x] Standard telemetry does not persist full prompts/tool results.
- [x] Secret redaction is applied.

**Test Levels:** `INT`

## STORY-10-03 — RunMetricsAggregator

**Priority:** P1

```yaml
spec_refs:
  required:
    - 08-observability-and-evaluation.md#run-metrics-aggregator
```

**Acceptance Criteria**

- [x] Retry/replan/fix/blocked/VR/RR/Finding metrics are deterministic.
- [x] Missing telemetry remains null/unavailable rather than zero.

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

- [x] provisional/final evaluation works.
- [x] telemetry quality and source revision/sequence are recorded.
- [x] same source + evaluator version is deterministic.
- [x] no required scalar score/grade is produced.

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

- [x] minimal/standard/debug behavior is explicit.
- [x] Event corruption/gap/telemetry writer failure produces degraded quality.
- [x] Workflow state correctness remains independent from telemetry completeness.

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

- [x] Valid/degraded/unreadable Run candidates are handled.
- [x] SQLite can be deleted and rebuilt.
- [x] State revision/Event sequence incremental indexing works.

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

- [x] `/api/v1` read endpoints cover Run/detail/graph/events/steps/executions/artifacts/evaluation/compare.
- [x] No workflow-control mutation endpoint is present.
- [x] Artifact path traversal/symlink escape is rejected.

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

- [x] Run lifecycle variants are visually distinguishable.
- [x] Correctness/blocker information precedes efficiency for relevant views.
- [x] Timeline uses Event sequence and collapses Tool detail by default.

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

- [x] Step graph uses Steps/depends_on; Gates are annotations.
- [x] Dynamic origin/skip reason is visible.
- [x] Artifact bodies are lazy-loaded and sanitized.
- [x] VR/RR/F detail is accessible.

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

- [x] Two Runs can be compared with comparability warnings.
- [x] null/degraded metrics are not treated as zero/reliable.
- [x] Outcome/risks appear before efficiency.
- [x] no automatic winner/scalar score is required.

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

- [x] watcher hint + periodic reconciliation recovers missed updates.
- [x] SSE reconnect/refetch is safe.
- [x] corrupt Event/missing Artifact/index error is surfaced without mutating Workflow state.

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

- [x] Reproducible fixtures cover feature/bug/hotfix/chore/refactor/investigation and dirty-tree cases.

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

- [x] Crash before/during Agent, during Worker, after Artifact, after State, during resume/cancel is covered.
- [x] Current State remains old-or-new complete, never partial mixed state.

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

- [x] Scout/Planner/Reviewer/Verifier write restrictions are enforced.
- [x] Worker scope/Git rules are enforced.
- [x] Network/path traversal/secret persistence cases are covered.

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

- [x] Resume works without chat history.
- [x] Main Session does not need normal repository exploration.
- [x] Artifact/State handoff is sufficient for subsequent Steps.

**Test Levels:** `E2E`

## STORY-12-05 — Cross-platform Persistence and Git

**Status:** COMPLETE — GitHub Actions [run #33625283638](https://github.com/minorunakamura/pi-workflow/actions/runs/33625283638) passed on `macos-latest`, `ubuntu-latest`, and `windows-latest` with 8 test files / 39 tests on each OS; uploaded matrix artifacts are the Release Evidence.

**Priority:** P0

```yaml
spec_refs:
  required:
    - 06-persistence-and-artifacts.md#atomic-state-commit
    - 07-security-recovery-and-repository.md#locks
```

**Release Evidence:** The three matrix artifacts (`story-12-05-macos-latest`, `story-12-05-ubuntu-latest`, `story-12-05-windows-latest`) contain per-OS PASS logs and the required environment/version, command, result, and artifact locations.

**Acceptance Criteria**

- [x] macOS/Linux/Windows relevant path/rename/process/lock/Git behavior is validated on actual target OS environments.
- [x] Release Evidence records OS, Node/pnpm/Git versions, filesystem/environment, test command, result, and artifact/log location.
- [x] Persistence pointer replacement/crash boundaries, Run/Workspace locks and process liveness, space/Unicode paths, Git status/diff/rename, packed installation/load, and packaged Skill discovery are covered by the platform matrix.

**Test Levels:** `INT`, `CRASH`

## STORY-12-06 — Legacy Cutover

**Status:** COMPLETE — legacy absence, default/installed production execution, and the required Gate A-D and hardening prerequisites are verified.

**Priority:** P0

**Dependencies:** Gates A–D and hardening tests

```yaml
spec_refs:
  required:
    - 10-implementation-specification.md#hardening
```

**Release Evidence:** `tests/e2e/legacy-cutover.test.ts`, `tests/e2e/default-production-path.test.ts`, and `tests/e2e/packed-package-installation.test.ts` passed on the current production composition. The full local suite passed 74 test files / 281 tests. Cross-platform hardening, including packed installation, passed on macOS, Linux, and Windows in GitHub Actions [run #33625283638](https://github.com/minorunakamura/pi-workflow/actions/runs/33625283638); its three uploaded matrix artifacts contain the per-OS logs and environment records.

**Acceptance Criteria**

- [x] `LEGACY_PATH_ABSENT` passes: obsolete Workflow runtime paths are absent, including `workflow-tui.ts`.
- [x] `NEW_RUNTIME_OPERATIONAL` passes: installed/default `/wf-*` reaches the new production runtime without manual use-case injection.
- [x] `CUTOVER_ELIGIBLE` passes only after Gates A-D and required hardening Evidence pass.
- [x] `NO_LEGACY_FALLBACK` passes: normal operation cannot silently invoke an obsolete Workflow runtime.
- [x] Legacy session transcript migration is not introduced.

**Test Levels:** `E2E`

# EPIC-13 — Release Closure

This Epic closes release blockers discovered by Phase 1 Release Verification. It does not redefine runtime behavior; it completes the production integration and release Evidence required by the authoritative specification.

## STORY-13-01 — Production Use Cases and Initial Run Bootstrap

**Goal:** Provide production Application use cases and create the initial persisted Run/State required to enter the Orchestrator.

**Priority:** P0

**Dependencies:** Gate A, persistence/recovery components

```yaml
spec_refs:
  required:
    - 03-domain-model.md#workflow-run
    - 04-orchestration.md#playbooks
    - 06-persistence-and-artifacts.md#run-store-layout
    - 10-implementation-specification.md#application-modules
    - 10-implementation-specification.md#default-production-composition
```

**Acceptance Criteria**

- [x] Production `StartWorkflowUseCase` selects one of the six Playbooks and creates a valid initial Run/State in the consuming repository Run Store.
- [x] Production status use case reads current Run state through the read-side boundary.
- [x] Production resume use case reaches the defined resume lifecycle and can continue the Orchestrator.
- [x] Production cancel use case reaches the defined cancellation lifecycle.
- [x] Start-created state is sufficient to invoke `Orchestrator.run(runId)` without test-only fixtures or fake command stubs.
- [x] Failure/invalid-input behavior is explicit and does not silently fall back to test behavior.

**Test Levels:** `UNIT`, `INT`

## STORY-13-02 — Default Composition Root and Pi Context Wiring

**Goal:** Make `workflowExtension(pi)` construct and expose the real production runtime used during normal Pi operation.

**Priority:** P0

**Dependencies:** STORY-13-01

```yaml
spec_refs:
  required:
    - 02-runtime-architecture.md#pi-package-boundary
    - 02-runtime-architecture.md#composition-root
    - 02-runtime-architecture.md#user-interaction-boundary
    - 10-implementation-specification.md#composition-root
    - 10-implementation-specification.md#default-production-composition
    - 10-implementation-specification.md#commands
```

**Acceptance Criteria**

- [x] Calling `workflowExtension(pi)` without test-only dependency injection constructs the production Composition Root.
- [x] Command context resolves the consuming repository/workspace used by `.pi/runs/`.
- [x] File stores/readers, Run/Workspace locks, Repository/Workspace adapters, Pi Agent/User adapters, Skill/Model/Tool resolution, Application use cases, and Orchestrator are connected through the Composition Root.
- [x] `PiSubagentsAdapter` receives the Pi execution facilities it requires, including events where required by the adapter contract.
- [x] `/wf-*` default execution no longer returns a `NOT_IMPLEMENTED` placeholder.
- [x] Fake/test composition remains available for tests but is not reachable as an implicit production fallback.

**Test Levels:** `ARCH`, `INT`

## STORY-13-03 — Packed Package Installation Smoke

**Goal:** Prove that the distributable Pi Package works from a clean consumer without relying on the source checkout layout.

**Priority:** P0

**Dependencies:** STORY-13-02

```yaml
spec_refs:
  required:
    - 05-agents-and-skills.md#skill-packaging-and-discovery
    - 10-implementation-specification.md#package-manifest
    - 10-implementation-specification.md#local-package-development
    - 10-implementation-specification.md#release-evidence-contract
```

**Acceptance Criteria**

- [x] A package artifact is produced using the repository package process (for example `pnpm pack`).
- [x] The artifact is installed/loaded from a clean consumer context rather than referenced as the source checkout.
- [x] No authored `.pi/agent/skills/` copy is required and all nine packaged Skills are discovered.
- [x] The packed Extension binds successfully and `/wf-*` reaches the production/default runtime.
- [x] Pi core peer dependencies and the bundled/runtime dependency on `pi-subagents` resolve according to Package rules.
- [x] The test records reproducible Release Evidence.

**Test Levels:** `INT`, `E2E`

## STORY-13-04 — Gate C Default-path E2E

**Goal:** Demonstrate Operational Safety through the same default runtime path used by a normally installed Package.

**Priority:** P0

**Dependencies:** STORY-13-02

```yaml
spec_refs:
  required:
    - 02-runtime-architecture.md#user-interaction-boundary
    - 07-security-recovery-and-repository.md#recovery-manager
    - 07-security-recovery-and-repository.md#resume
    - 07-security-recovery-and-repository.md#cancellation
    - 10-implementation-specification.md#commands
    - 10-implementation-specification.md#default-production-composition
```

**Acceptance Criteria**

- [x] All six start commands execute through the default production path without manual use-case injection.
- [x] Start creates project-local Run data and Agent execution reaches the production Pi Agent Runtime boundary.
- [x] `/wf-status`, `/wf-resume`, and `/wf-cancel` operate on the same default Run Store.
- [x] D3 approval/options/custom/cancel interaction reaches the Pi User Interaction adapter through the production Composition Root.
- [x] A blocked Run can resume through `/wf-resume`.
- [x] Active execution can be cancelled through `/wf-cancel`, preserving required partial/recovery evidence and terminal outcome semantics.
- [x] Recovery behavior required for normal operation is exercised through the default path.
- [x] The E2E test MUST NOT satisfy the path by injecting `startWorkflow`, `statusWorkflow`, `resumeWorkflow`, `cancelWorkflow`, or equivalent production-use-case stubs into the Extension.

**Test Levels:** `E2E`, `CRASH`

## STORY-13-05 — Phase 1 Core Skill Behavioral Specification

**Goal:** Define the responsibility and executable procedure of each Phase 1 Core Skill before treating its packaged `SKILL.md` as an implementation target.

**Priority:** P0

**Dependencies:** existing Agent definitions and Skill model

```yaml
spec_refs:
  required:
    - 05-agents-and-skills.md#core-workflow-skills
    - 05-agents-and-skills.md#skill-allowlists
    - 10-implementation-specification.md#core-skill-implementation
```

**Acceptance Criteria**

- [x] `05-agents-and-skills.md` defines the responsibility of each of the nine Phase 1 Core Skills: `how`, `why`, `blast-radius`, `architect`, `tdd`, `interrogate`, `figure-it-out`, `show-me-your-work`, and `reflect`.
- [x] Each Skill specification defines enough procedural behavior to implement it without inventing semantics during implementation, including applicability, procedure, expected output/evidence, and relevant constraints or stopping/escalation conditions.
- [x] Skill responsibilities are non-overlapping enough to support deliberate selection and do not silently create a second Agent/Orchestrator role.
- [x] Skill behavior remains subordinate to Agent authority, permissions, decision classes, Write Scope, Tool policy, and Orchestrator-owned State mutation.
- [x] Agent allowlists remain consistent with the specified Skill responsibilities; any required semantic change is made in the authoritative specification before Skill implementation.
- [x] Phase 2/Phase 3 behavior such as arena, swarm, worktree isolation, or Operational Skills is not pulled into Phase 1 Core Skill semantics.

**Test Levels:** documentation/specification review prerequisite; no runtime completion claim

## STORY-13-06 — Phase 1 Core Skill Implementations

**Goal:** Replace all metadata-only Core Skill placeholders with the executable procedures defined by the authoritative Skill specification and prove they work through the normal Pi Package path.

**Priority:** P0

**Dependencies:** STORY-13-05, STORY-06-02, STORY-06-03, STORY-13-03

```yaml
spec_refs:
  required:
    - 05-agents-and-skills.md#core-workflow-skills
    - 05-agents-and-skills.md#skill-allowlists
    - 05-agents-and-skills.md#skill-packaging-and-discovery
    - 10-implementation-specification.md#prompt-assembler
    - 10-implementation-specification.md#skill-catalog
    - 10-implementation-specification.md#core-skill-implementation
```

**Acceptance Criteria**

- [x] All nine Phase 1 Core Skills contain implemented procedural guidance rather than metadata-only placeholders or text that defers behavior to a future Story.
- [x] Each `SKILL.md` implements the responsibility/procedure defined by the authoritative Skill specification without silently adding new behavior.
- [x] Each Skill makes its purpose/applicability, concrete procedure, expected output/evidence, and relevant constraints or stopping/escalation conditions operationally clear.
- [x] Skill content cannot widen the invoking Agent's permissions, authority, Write Scope, Tool access, or user-interaction capability.
- [x] Agent allowlists remain enforced and allowlisted Skills are not automatically loaded merely because they are permitted.
- [x] `SkillCatalog` discovers/resolves the implemented packaged content and `PromptAssembler` supplies only selected Skill content to Agent Execution.
- [x] Tests fail when any required Core Skill is missing, metadata-only, structurally incomplete, or still contains an implementation-deferred placeholder.
- [x] Packed-package verification proves all nine implemented Skills are included and discoverable from a clean consumer without authored `.pi/agent/skills/` copies.
- [x] Focused production-path integration/E2E Evidence demonstrates selected Skill content reaches Agent Execution; fake/test-only Skill injection alone is insufficient.

**Test Levels:** `CONTRACT`, `INT`, `E2E`

## STORY-13-07 — Production Orchestration Finalization and Dynamic Control Wiring

**Goal:** Connect authoritative Change Set / Verification Run / Review Run / Finding / Outcome finalization and required dynamic-control paths to the installed/default production Orchestrator so a Run cannot complete from raw Agent results alone.

**Priority:** P0

**Dependencies:** STORY-13-01, STORY-13-02, Gate A, existing Gate B finalizer/components

```yaml
spec_refs:
  required:
    - 02-runtime-architecture.md#runtime-control-loop
    - 02-runtime-architecture.md#composition-root
    - 04-orchestration.md#dynamic-graph-mutation
    - 04-orchestration.md#verification-and-review-fix-loop
    - 04-orchestration.md#completion
    - 05-agents-and-skills.md#step-result
    - 10-implementation-specification.md#default-production-composition
    - 10-implementation-specification.md#release-closure-integration-assertions
```

**Acceptance Criteria**

- [x] The installed/default production Orchestrator sends accepted Agent results through the same schema/identity/role/reference/permission/repository-postcondition normalization required by the authoritative runtime contract.
- [x] Worker completion finalizes an authoritative Change Set from actual repository observation; a raw `completed` Agent result cannot independently satisfy implementation completion.
- [x] Required Verifier execution finalizes a Verification Run and required Reviewer execution finalizes a Review Run plus Finding candidates/rechecks through Orchestrator/domain normalization.
- [x] Completion invokes `CompletionEvaluator` before terminalization and cannot succeed while a required Verification/Review result is missing/stale/failed, a blocking/fix-required Finding remains open, repository drift is unresolved, or another Completion Gate is not satisfied.
- [x] Eligible completion finalizes `outcome.md`, commits final authoritative State, appends required Events, and reaches the defined terminal lifecycle without a test-only completion shortcut.
- [x] Production dynamic-control wiring handles required triggers including verification failure, review finding, plan deviation, request amendment, repository drift, runtime failure, recovery, and re-plan insertion through the Orchestrator control loop.
- [x] The Worker → Verifier → Reviewer fix/reverify/rereview path executes through the installed/default production composition when a verification failure or review finding requires a fix.
- [x] Production-path tests fail when the CS/VR/RR/Outcome finalizer wiring or required dynamic-control hook is removed; component-only/fake-path coverage is insufficient.
- [x] A focused installed/default E2E demonstrates Worker → Change Set → Verifier → Verification Run → Reviewer → Review Run/Findings → CompletionEvaluator → Outcome.

**Test Levels:** `ARCH`, `INT`, `E2E`

**Release Gate:** Gate B / Gate C production integration

## STORY-13-08 — Production Repository and Capability Enforcement

**Goal:** Enforce Plan Write Scope, dirty/pre-existing repository safety, drift checks, Agent permissions, and Tool capabilities through the concrete installed/default runtime rather than relying on prompt instructions or permissive repository defaults.

**Priority:** P0

**Dependencies:** STORY-13-07, existing repository/security adapters and finalizers

```yaml
spec_refs:
  required:
    - 05-agents-and-skills.md#tool-model
    - 07-security-recovery-and-repository.md#agent-permission-enforcement
    - 07-security-recovery-and-repository.md#write-scope
    - 07-security-recovery-and-repository.md#repository-baseline
    - 07-security-recovery-and-repository.md#pre-existing-changes
    - 07-security-recovery-and-repository.md#mutation-attribution
    - 07-security-recovery-and-repository.md#repository-drift
    - 07-security-recovery-and-repository.md#recovery-manager
    - 10-implementation-specification.md#release-closure-integration-assertions
```

**Acceptance Criteria**

- [x] The approved Plan Write Scope is propagated into each Worker Execution Request; production composition does not replace it with repository-wide scope unless the authoritative Plan explicitly authorizes that scope.
- [x] Run start records the actual repository root identity, HEAD, branch, dirty state, and pre-existing changed/untracked files; a dirty repository is never persisted as a synthetic clean baseline.
- [x] Worker pre/post repository observation produces mutation attribution and an actual diff check before Change Set acceptance.
- [x] `WRITE_SCOPE_VIOLATION`, uncertain attribution, or detected pre-existing change loss blocks acceptance according to the repository safety contract.
- [x] Pre-existing user changes are preserved and are not automatically reset/restored/cleaned by the workflow runtime.
- [x] Required repository drift checks execute on the installed/default lifecycle boundaries and unresolved relevant/critical/unknown drift blocks unsafe continuation/completion.
- [x] Agent mode/permissions and Tool capability policy are propagated to the concrete Pi Agent Runtime adapter as enforceable execution constraints where supported; prompt text is not the sole security boundary.
- [x] Read-only/verify-only Agents cannot mutate source through the normal runtime path, Worker cannot escape approved Write Scope, and normal Phase 1 execution cannot perform prohibited Git writes.
- [ ] Security/golden-repository E2E covers dirty tree, pre-existing changes, out-of-scope mutation, drift, prohibited Agent mutation, and Tool-capability denial through the production composition.

**Test Levels:** `UNIT`, `INT`, `E2E`, `CRASH`

**Release Gate:** Gate B / Repository-Security / Gate C recovery safety

## STORY-13-09 — Packed Production Agent Runtime Closure

**Goal:** Prove that a clean-consumer packed installation can resolve all required Agent resources and execute the actual production Pi Agent Runtime bridge, independently from package-installation mechanics.

**Priority:** P0

**Dependencies:** STORY-13-03, STORY-13-07, STORY-13-08

```yaml
spec_refs:
  required:
    - 02-runtime-architecture.md#agent-runtime-boundary
    - 05-agents-and-skills.md#agent-definitions
    - 05-agents-and-skills.md#skill-packaging-and-discovery
    - 10-implementation-specification.md#default-production-composition
    - 10-implementation-specification.md#release-evidence-contract
    - 10-implementation-specification.md#release-closure-integration-assertions
```

**Acceptance Criteria**

- [ ] The distributable package contains/resolves all seven Phase 1 Agent resources required by the production registry, including `verifier`.
- [ ] A `pnpm pack` (or repository-equivalent package artifact) is installed/loaded from a clean consumer without source-checkout resource paths, authored `.pi/agent/skills/` copies, or manually injected Agent roots.
- [ ] The packed/default runtime resolves Worker, Verifier, and Reviewer through the production Agent registry and reaches `PiSubagentsAdapter` through the normal Composition Root.
- [ ] Release E2E does not intercept delegation and synthesize the Agent response before the production Pi Agent Runtime bridge; the actual bridge used by installed/default operation is exercised.
- [ ] Selected packaged Skill content still reaches Agent execution through `SkillCatalog → PromptAssembler → PiSubagentsAdapter` while Agent/Tool allowlists remain enforced.
- [ ] A packed/default E2E demonstrates the required production chain through Worker → Verifier → Reviewer → Outcome without manual use-case injection or synthetic delegation shortcuts.
- [ ] Packed Package Installation/Loading Evidence is reported separately from Packed Production Runtime Operation Evidence; successful install/load alone does not establish `NEW_RUNTIME_OPERATIONAL`.
- [ ] External live LLM/provider execution is not required for every deterministic release test; any remaining live-provider coverage gap is reported separately and is not used to substitute for proof of the real Pi execution bridge.

**Test Levels:** `ARCH`, `INT`, `E2E`

**Release Gate:** Gate C / Packed Production Runtime / `NEW_RUNTIME_OPERATIONAL`

## STORY-13-10 — Gate D Production Evaluation Projection Closure

**Goal:** Connect the Monitoring indexer to deterministic metrics/evaluation so authoritative Run changes produce rebuildable provisional/final `RunEvaluationRecord` projections and Gate D is proven through the real production read path.

**Priority:** P0

**Dependencies:** existing telemetry/evaluation/Monitoring components, STORY-13-07

```yaml
spec_refs:
  required:
    - 08-observability-and-evaluation.md#run-metrics-aggregator
    - 08-observability-and-evaluation.md#run-evaluation-record
    - 08-observability-and-evaluation.md#telemetry-quality
    - 09-monitoring.md#evaluation-projection
    - 09-monitoring.md#phase-1-mvp
    - 10-implementation-specification.md#monitoring-modules
    - 10-implementation-specification.md#release-closure-integration-assertions
```

**Acceptance Criteria**

- [ ] `RunEvaluationRecord.telemetry_quality.status` supports `healthy`, `degraded`, and `insufficient` according to the authoritative telemetry-quality rules.
- [ ] Missing required telemetry is represented explicitly and is not silently converted to zero-valued healthy metrics.
- [ ] On relevant State/Event changes, the Monitoring indexer invokes the deterministic metrics/evaluation path and writes/updates the `evaluations` SQLite projection.
- [ ] A finalized Run receives a `final` evaluation for the current evaluator version; active/non-final Runs can receive a `provisional` evaluation.
- [ ] Full Monitoring rebuild from authoritative Run directories recreates evaluation projections without relying on prior SQLite state or manually inserted evaluation records.
- [ ] Incremental indexing updates evaluation projection consistently with indexed State/Event revisions and does not expose a mixed projection for one Run update.
- [ ] Evaluation and Two-Run Compare read paths consume generated evaluation records and surface telemetry-quality/comparability warnings where applicable.
- [ ] Gate D E2E proves Run discovery/index → metrics aggregation → evaluation → SQLite projection → Evaluation/Compare API through the production Monitoring composition; tests that satisfy the path only by manual evaluation INSERT are insufficient.
- [ ] `/api/v1/health` is not required to close this Story or Phase 1 release unless `09-monitoring.md` Phase 1 MVP Required is explicitly changed to make it mandatory.

**Test Levels:** `UNIT`, `INT`, `E2E`

**Release Gate:** Gate D

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
Release Closure bootstrap / default path (STORY-13-01 → STORY-13-04)
  ↓
Core Skill specification / implementation (STORY-13-05 → STORY-13-06)
  ↓
Production orchestration finalization / dynamic control (STORY-13-07)
  ↓
Repository / capability enforcement (STORY-13-08)
  ↓
Packed production Agent runtime (STORY-13-09)
  ↓
Gate D production evaluation projection (STORY-13-10)
  ↓
Cross-platform re-validation against the new RC HEAD (STORY-12-05)
  ↓
Legacy Cutover re-validation against the new RC HEAD (STORY-12-06)
  ↓
Phase 1 Release
```

# Release Gates

## Gate A — Engine Core

All six Playbooks complete using `FakeAgentRuntime`, including key dynamic paths.

## Gate B — Real Execution Safety

Real Worker/Verifier/Reviewer flow passes Write Scope, dirty-tree, Change Set, Verification, Review, and fix-cycle tests.

## Gate C — Operational Safety

Recovery, resume, cancellation, D3 interaction, and command integration are usable through the installed/default production runtime path. Component-level or manually injected command tests alone are insufficient.

## Gate D — Evaluation

Runs can be indexed, observed, evaluated, and compared with telemetry quality/comparability handling.

## Phase 1 Release

Requires architecture/domain/persistence/crash/fake-E2E/real-write/recovery/security/evaluation/Monitoring hard gates to pass, plus:

- Gate B production finalization and repository/capability safety passing through the installed/default production runtime path;
- Gate C recovery/command/dynamic-control behavior passing through the installed/default production runtime path;
- all nine Phase 1 Core Skills having non-placeholder executable procedures defined by the authoritative Skill specification and available through the production Skill path;
- packed Package installation/loading Evidence from a clean consumer;
- packed production Agent-runtime Evidence proving the actual installed/default Pi Agent Runtime bridge separately from package-installation mechanics;
- Gate D production Monitoring projection generating rebuildable `RunEvaluationRecord` data rather than relying on manually inserted evaluation rows;
- cross-platform hardening Evidence for macOS, Linux, and Windows against the release-candidate HEAD;
- Legacy Cutover certification with `LEGACY_PATH_ABSENT`, `NEW_RUNTIME_OPERATIONAL`, `CUTOVER_ELIGIBLE`, and `NO_LEGACY_FALLBACK` satisfied.

Release verification MUST report each required area as `PASS`, `FAIL`, `INSUFFICIENT EVIDENCE`, or `NOT ELIGIBLE` where applicable. A prior Story completion marker does not override missing Acceptance Criteria or Evidence discovered by release verification. Parallelism begins only after multiple stable Phase 1 Runs establish an evaluation baseline.
