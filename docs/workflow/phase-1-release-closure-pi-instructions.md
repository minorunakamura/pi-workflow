# Phase 1 Release Closure — Pi Implementation Instructions

## Purpose

Implement and verify the Phase 1 Release Closure Stories discovered by the latest Release Verification:

```text
STORY-13-07 — Production Orchestration Finalization and Dynamic Control Wiring
STORY-13-08 — Production Repository and Capability Enforcement
STORY-13-09 — Packed Production Agent Runtime Closure
STORY-13-10 — Gate D Production Evaluation Projection Closure
```

Recommended execution order:

```text
13-07
  ↓
13-08
  ↓
13-09
  ↓
13-10
  ↓
full check
  ↓
cross-platform re-validation on the new RC HEAD
  ↓
Phase 1 Release Verification rerun
```

Run one Story per Pi session/workflow unless there is a strong reason to keep the same session. This keeps implementation evidence and context boundaries clear.

---

## Authority and Source Rules

Use the repository documents with the following precedence:

```text
01-*.md — 10-*.md
  = authoritative Source of Truth

11-implementation-backlog.md
  = Implementation Tracking Projection

release-verification-result-final.md
  = evidence/report for the previously verified HEAD
```

Rules:

1. Do not treat historical `[x]` markers in `11-implementation-backlog.md` as proof that the current implementation satisfies the Source of Truth.
2. Before changing code, inspect the current HEAD and verify whether each reported release gap still exists.
3. Do not weaken or reinterpret `01`–`10` merely to make a Story pass.
4. `11-implementation-backlog.md` may be updated as implementation tracking only.
5. Mark a Story Acceptance Criterion `[x]` only after current-HEAD code plus test/Evidence demonstrates it.
6. If implementation reveals a genuine contradiction or missing semantic rule in `01`–`10`, do not invent semantics silently. Report the specification gap separately before changing behavior.
7. Preserve Phase 1 exclusions. Do not introduce parallelism, arena/swarm, worktree isolation, Operational Skills, or another Phase 2/3 feature to solve a Phase 1 closure problem.
8. Do not use test-only dependency injection, fake command use cases, synthetic delegation shortcuts, source-checkout resource roots, or manually inserted Monitoring evaluation records to satisfy a release-path Acceptance Criterion.
9. Do not commit or push unless explicitly requested.

---

## Evidence Classification

Use these categories when reporting results:

- `PASS` — required behavior is implemented and acceptable Evidence proves the required path.
- `FAIL` — current code directly violates or omits a required behavior.
- `INSUFFICIENT EVIDENCE` — implementation may exist, but required installed/default/packed/real-runtime Evidence does not prove it.
- `Residual Risk` — non-blocking uncertainty outside the mandatory Phase 1 release Evidence contract.

Do not convert an Evidence gap into PASS because component tests are green.

---

# STORY-13-07 Instructions

## Goal

Connect authoritative Change Set / Verification Run / Review Run / Finding / Outcome finalization and required dynamic-control paths to the installed/default production Orchestrator.

## Read First

At minimum, read the current versions of:

```text
02-runtime-architecture.md
03-domain-model.md
04-orchestration.md
05-agents-and-skills.md
06-persistence-and-artifacts.md
10-implementation-specification.md
11-implementation-backlog.md — STORY-13-07
release-verification-result-final.md
```

Pay particular attention to:

```text
Orchestrator ownership
Step Result normalization
Dynamic Graph Mutation
Verification and Review Fix Loop
CompletionEvaluator
Artifact finalization
Outcome finalization
Default Production Composition
Release Closure Integration Assertions
```

## Execution Instruction

Implement STORY-13-07 against the current HEAD.

First reproduce/confirm the release-verification findings in the current code. Trace the actual installed/default command path from `workflowExtension(pi)` through the production Composition Root and Orchestrator. Identify exactly where raw Agent results currently bypass or fail to reach authoritative Change Set, Verification Run, Review Run/Finding, CompletionEvaluator, and Outcome finalization.

Then make the minimum architecture-consistent changes required so that the production path uses the authoritative Orchestrator/finalizer behavior already defined by the Source of Truth.

The required production chain must be demonstrable as applicable:

```text
Worker Execution
  ↓
result normalization + repository postconditions
  ↓
Change Set finalization
  ↓
Verifier Execution
  ↓
Verification Run finalization
  ↓
Reviewer Execution
  ↓
Review Run / Finding normalization
  ↓
CompletionEvaluator
  ↓
Outcome finalization + terminal State commit
```

Also connect production dynamic-control triggers required by the orchestration specification, including verification failure, review finding, plan deviation, request amendment, repository drift, runtime failure/recovery, re-plan, and fix/reverify/rereview flow.

Do not create a second orchestration path in the Composition Root. Reuse the Orchestrator/domain/application mechanisms defined by the architecture.

## Required Verification

At minimum:

1. Add/update focused unit/integration tests for the wiring changed.
2. Add a production/default-path test that fails if CS/VR/RR/Outcome finalizers are disconnected.
3. Prove required verification/review cannot be skipped merely because an Agent returns `completed`.
4. Prove CompletionEvaluator is executed before successful terminalization.
5. Prove one fix → reverify → rereview path through the production composition.
6. Prove at least one dynamic trigger enters the production Orchestrator path rather than only a fake composition.
7. Run relevant targeted tests.
8. Run `pnpm check` before declaring the Story complete.

## Completion Report

Report:

```text
Current HEAD
Changed files
Root cause confirmed
Implementation summary
Acceptance Criteria status one by one
Targeted tests + results
pnpm check result
Remaining FAIL / INSUFFICIENT EVIDENCE / Residual Risk
```

Only then update STORY-13-07 `[ ]` → `[x]` for criteria actually proven.

---

# STORY-13-08 Instructions

## Goal

Enforce Plan Write Scope, dirty/pre-existing repository safety, repository drift, Agent permissions, and Tool capabilities through the concrete installed/default runtime.

## Read First

At minimum:

```text
05-agents-and-skills.md
07-security-recovery-and-repository.md
10-implementation-specification.md
11-implementation-backlog.md — STORY-13-08
release-verification-result-final.md
```

Pay particular attention to:

```text
Agent Permission Enforcement
Tool Model
Write Scope
Repository Baseline
Pre-existing Changes
Mutation Attribution
Repository Drift
Recovery Manager
Release Closure Integration Assertions
```

## Execution Instruction

Implement STORY-13-08 against the current HEAD.

Trace the actual production data flow from Plan Write Scope to Worker Execution Request and from Agent definition/Tool policy to `PiSubagentsAdapter`. Confirm whether current production composition widens repository scope, normalizes a dirty repository to clean, or relies on prompt wording for Tool/security restrictions.

Make the minimum architecture-consistent changes required so that:

```text
Plan Write Scope
  ↓
Execution Request
  ↓
Worker runtime constraint
  ↓
pre/post repository observation
  ↓
actual diff + attribution
  ↓
Change Set acceptance/rejection
```

and:

```text
Agent definition + Execution Request
  ↓
mode / permissions / Tool capabilities
  ↓
Pi Agent Runtime adapter enforcement
```

are production-runtime facts rather than prompt conventions.

Do not solve this by broadening every Worker to repository-wide write access. Do not reset/restore/clean pre-existing user changes.

## Required Verification

Use golden-repository/security scenarios covering at least:

1. clean repository in approved Write Scope;
2. dirty repository with pre-existing modified file;
3. pre-existing untracked file;
4. Worker mutation outside Write Scope;
5. same-file attribution uncertainty;
6. relevant/critical/unknown repository drift;
7. read-only/verify-only Agent attempting source mutation;
8. prohibited Git write;
9. denied Tool capability reaching the concrete Pi adapter boundary.

Verify that prompt text is not the only enforcement layer.

Run targeted tests and `pnpm check`.

## Completion Report

Use the same report structure as STORY-13-07 and update only proven STORY-13-08 checkboxes.

---

# STORY-13-09 Instructions

## Goal

Prove packed Package production Agent execution separately from package installation mechanics.

## Read First

At minimum:

```text
02-runtime-architecture.md
05-agents-and-skills.md
10-implementation-specification.md
11-implementation-backlog.md — STORY-13-03 and STORY-13-09
release-verification-result-final.md
```

## Execution Instruction

Implement STORY-13-09 against the current HEAD.

Do not re-prove only `pnpm pack`/installation. The previous release verification already separated package mechanics from runtime operation. Verify the installed artifact from a clean consumer and trace the actual production Agent path:

```text
packed artifact
  ↓
clean consumer
  ↓
workflowExtension(pi)
  ↓
production Composition Root
  ↓
Agent registry
  ↓
SkillCatalog / PromptAssembler
  ↓
PiSubagentsAdapter
  ↓
actual Pi Agent execution bridge
```

All seven Phase 1 Agent resources must be packaged/resolvable, including Verifier. Worker, Verifier, and Reviewer must resolve through the same production registry/path used by normal installed operation.

A test that intercepts delegation before `PiSubagentsAdapter` and fabricates a response does not satisfy this Story.

Do not require every deterministic release test to call a live external LLM/provider. The required proof is the real installed Pi execution bridge. If live-provider execution remains untested, report that separately as Residual Risk unless the Source of Truth explicitly requires it for the tested condition.

## Required Verification

1. Produce the distributable artifact using the repository package process.
2. Install/load it in a genuinely clean consumer.
3. Confirm no source checkout Agent/Skill root is used.
4. Confirm all seven Agents resolve from packaged resources.
5. Confirm all nine Skills remain discoverable and selected Skill content reaches Agent execution through the production path.
6. Exercise the real `PiSubagentsAdapter` bridge used by installed/default runtime.
7. Prove Worker → Verifier → Reviewer → Outcome through the packed/default path without manual use-case injection or synthetic delegation shortcut.
8. Record Packed Package Installation/Loading and Packed Production Runtime Operation as separate Evidence results.
9. Run relevant targeted tests and `pnpm check`.

## Completion Report

Explicitly report two independent statuses:

```text
Packed Package Installation / Loading: PASS | FAIL | INSUFFICIENT EVIDENCE
Packed Production Runtime Operation: PASS | FAIL | INSUFFICIENT EVIDENCE
```

Update only proven STORY-13-09 checkboxes.

---

# STORY-13-10 Instructions

## Goal

Connect Monitoring indexing to deterministic metrics/evaluation so Gate D is proven through generated `RunEvaluationRecord` projections rather than manually seeded DB records.

## Read First

At minimum:

```text
08-observability-and-evaluation.md
09-monitoring.md
10-implementation-specification.md
11-implementation-backlog.md — STORY-13-10
release-verification-result-final.md
```

Pay particular attention to:

```text
RunMetricsAggregator
RunEvaluationRecord
Telemetry Quality
Evaluation Projection
Phase 1 MVP
Monitoring Modules
Release Closure Integration Assertions
```

## Execution Instruction

Implement STORY-13-10 against the current HEAD.

The production Monitoring path must derive evaluation data from authoritative Run sources:

```text
Run Store / Events
  ↓
Monitoring indexer
  ↓
RunMetricsAggregator
  ↓
RunEvaluator
  ↓
RunEvaluationRecord
  ↓
SQLite evaluations projection
  ↓
Evaluation / Compare read API
```

Implement `healthy | degraded | insufficient` telemetry quality according to the Source of Truth. Missing telemetry must not silently become zero-valued healthy metrics.

Tests that manually INSERT evaluation rows may remain as narrow persistence/API tests, but they cannot be the Evidence used to pass Gate D production integration.

`/api/v1/health` is not a STORY-13-10 or Phase 1 release blocker under the current `09-monitoring.md` Phase 1 MVP Required set. Do not add it merely to make the release report green unless separately desired.

## Required Verification

1. active Run → provisional evaluation;
2. finalized Run → final evaluation;
3. healthy telemetry;
4. degraded telemetry;
5. insufficient telemetry;
6. missing telemetry is not silently zeroed;
7. incremental State/Event update refreshes the evaluation projection;
8. full rebuild from authoritative Run Store recreates evaluation rows without prior SQLite state;
9. Evaluation API consumes generated projection;
10. Two-Run Compare consumes generated evaluation records and surfaces comparability/telemetry-quality warnings;
11. Gate D E2E passes without manual evaluation INSERT as the production integration mechanism;
12. targeted tests and `pnpm check` pass.

## Completion Report

Use the same report structure and update only proven STORY-13-10 checkboxes.

---

# After STORY-13-10

Do not immediately declare Phase 1 released.

First:

```text
1. Run full `pnpm check`.
2. Freeze/report the new candidate HEAD SHA.
3. Re-run the required macOS/Linux/Windows hardening checks against that same HEAD.
4. Re-run Legacy Cutover certification against that same HEAD.
5. Re-run the complete Phase 1 Release Verification from the beginning.
```

The final verification must independently classify at least:

```text
Static prerequisites
Gate A
Core Skills
Gate B
Gate C
Packed Package Installation / Loading
Packed Production Runtime Operation
Persistence / Recovery
Repository / Security
Cross-platform
Gate D
Context Independence
Legacy Cutover
Full Check
```

Do not inherit PASS from the previous Release Verification merely because the older HEAD passed it. Evidence must correspond to the new release-candidate HEAD where the release contract requires HEAD consistency.
