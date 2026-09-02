# Agents and Skills

## Purpose

This document defines the seven Agent roles, authority boundaries, Agent Execution Request and Step Result contracts, Skill model and allowlists, Tool capability policy, prompt assembly, and model/provider routing principles.

## Agent Model

An Agent is an execution role. It does not own the Workflow State Machine, create runtime Steps, contact the user directly, or widen its own authority.

> **Invariant**
>
> Agent → Orchestrator → User is the only user-interaction path.

> **Invariant**
>
> Worker is the only normal source-writing Agent. Verifier and Reviewer MUST NOT fix source code.

## Decision Authority

| Class | Agent authority |
|---|---|
| `D0` | Local choice within Agent contract and Step objective. |
| `D1` | Plan-bounded choice within approved scope/constraints. |
| `D2` | MUST be escalated to Orchestrator. |
| `D3` | MUST be escalated through Orchestrator to User. |

An Agent's mode, permissions, Skills, Tools, or model choice MUST NOT increase its decision authority.

## Agent Execution Request

`agent-execution-request-v1` is the immutable Orchestrator → Agent Runtime contract for one Execution.

Normative field groups:

| Group | Content |
|---|---|
| Identity | Run, Step, Execution, Agent ID/version |
| Objective | Step objective, type, completion criteria |
| Retry | attempt and retry context |
| Execution | mode, timeout/cancellation policy |
| Authority | maximum D-level and escalation rules |
| Permissions | filesystem, shell, Git, network, repository targets |
| Skills | selected required/optional Skill IDs/versions |
| Tools | resolved capability/tool policy |
| Model | requested/actual policy, thinking level, allowed fallback |
| Context | Context Pack/Manifest and Artifact refs |
| Outputs | expected Artifact types and output contract |

Execution modes:

```text
read-only | write | verify-only
```

The request is prompt-visible where useful, while sensitive/runtime-only enforcement data may remain outside the prompt.

## Step Result

`step-result-v1` is the Agent Runtime → Orchestrator contract.

Agent outcome:

```text
completed | blocked | failed
```

The outcome is not the final Step status until the Orchestrator validates the result and repository/runtime postconditions.

Stable result groups include:

```yaml
summary: "..."
artifacts: []
uncertainty_candidates: []
decision_requests: []
requirement_candidates:
  acceptance_criteria: []
  constraints: []
  assumptions: []
finding_candidates: []
finding_rechecks: []
plan_deviations: []
skill_requests: []
execution_checks: []
observations: []
blocked: null
failure: null
runtime: {}
```

- **MUST:** Stable array fields be present even when empty.
- **MUST:** A `failed` outcome contain structured failure information.
- **MUST:** A `blocked` outcome identify the blocking reason/ref.
- **MUST NOT:** Agent candidates use authoritative `U-*`, `D-*`, `F-*`, or other State IDs; the Orchestrator allocates them.
- **MUST:** The Orchestrator validate schema, identity, role restrictions, references, permissions, repository postconditions, Artifact presence, and size before accepting a result.

## Agent Definitions

### Scout

**Role:** read-only repository understanding and factual evidence collection.

**Mode:** `read-only`

**Maximum normal authority:** `D0`

**Primary Skills:** `how`, `why`, `blast-radius`

**Requirements**

- **MUST:** Distinguish facts/evidence from inference and assumptions.
- **MUST:** Identify unresolved questions and evidence gaps.
- **MUST NOT:** Produce the final implementation design, final Plan, or source change.
- **MUST NOT:** Mutate repository source.

### Researcher

**Role:** acquire external or missing knowledge with source/evidence traceability.

**Mode:** `read-only`

**Maximum normal authority:** `D0`

**Requirements**

- **MUST:** Provide source/evidence references for externally derived claims.
- **MUST:** Separate external evidence from local repository facts.
- **MUST NOT:** Mutate repository source.
- **MUST NOT:** Resolve D2/D3 decisions.

### Planner

**Role:** convert current Requirement/evidence/Decisions into an executable and verifiable Plan.

**Mode:** `read-only`

**Maximum normal authority:** `D1`

**Requirements**

- **MUST:** Define Plan Units, verification checks, Write Scope, affected areas, dependencies, and Acceptance Criterion coverage.
- **MUST:** Escalate D2/D3 decisions rather than hiding them in the Plan.
- **MUST:** For Bug Playbook, plan against established root-cause evidence.
- **MUST NOT:** Mutate repository source.

### Oracle

**Role:** decision support for high uncertainty, high impact, competing options, or conflicting evidence.

**Mode:** `read-only`

**Maximum normal authority:** recommendation only; D2/D3 remain external authority.

**Requirements**

- **MUST:** Present options, trade-offs, risks, and recommendation.
- **MUST NOT:** Claim final authority for D2 or D3.
- **MUST NOT:** Mutate repository source.

### Worker

**Role:** apply approved implementation work.

**Mode:** `write`

**Maximum normal authority:** `D1` within approved Plan/Write Scope.

**Requirements**

- **MUST:** Operate only within approved Write Scope.
- **MUST:** Preserve pre-existing repository changes.
- **MUST:** Report Plan deviations and relevant implementation checks.
- **MUST NOT:** Perform Git write operations such as commit, push, merge, rebase, reset, restore, clean, or branch mutation under normal Phase 1 policy.
- **MUST NOT:** Make material off-plan D2/D3 choices autonomously.
- **MAY:** Run implementation-level checks while working.
- **MUST NOT:** Treat Worker checks as Formal Verification.

### Verifier

**Role:** formal verification of current implementation and evidence capture.

**Mode:** `verify-only`

**Maximum normal authority:** `D0`

**Requirements**

- **MUST:** Execute/observe Verification Checks and record evidence/results.
- **MUST:** Distinguish passed, failed, skipped, and unavailable checks.
- **MUST NOT:** Modify source to make checks pass.
- **MUST NOT:** Create Findings; that is Reviewer responsibility.

### Reviewer

**Role:** independent evaluation of implementation/evidence or investigation synthesis.

**Mode:** `read-only`

**Maximum normal authority:** `D0`

**Requirements**

- **MUST:** Evaluate actual current repository state and relevant evidence independently.
- **MUST:** Return evidence-backed Finding candidates/rechecks.
- **MUST NOT:** Modify source.
- **MUST NOT:** Directly choose final Finding disposition without Orchestrator/domain normalization.
- **MUST NOT:** Use `figure-it-out` in the Phase 1 allowlist; review should surface uncertainty rather than silently solve around it.

## Skill Model

A Skill is a reusable specialist procedure describing how an Agent performs part of its work. Agent = who, Skill = how, Tool = mechanism.

Skills do not create runtime Steps, contact the user, widen permissions, or own final decisions.

Core Skill package metadata SHOULD include:

```yaml
name: <skill-id>
version: 1
description: "..."
dependencies: []
capabilities: []
preferred_artifacts: []
requirements: []
```

Dependencies MUST be acyclic.

## Skill Packaging and Discovery

Phase 1 Skills are Pi Package resources rather than source files installed manually into `.pi/agent/skills/`. The recommended package source location is `skills/<skill-id>/SKILL.md`; the package manifest exposes the `skills/` resource tree.

- **MUST:** `SkillCatalog` resolve Skills from the package resource model rather than a hard-coded project-local `.pi/agent/skills/` source path.
- **MUST:** The nine Core Skills be installable together with the Workflow Pi Package.
- **MUST NOT:** The Orchestrator depend on physical Skill file paths.
- **MAY:** Pi project settings enable, disable, or filter packaged Skills without changing the Workflow package source.

Package layout is defined in `10-implementation-specification.md#package-manifest`.

## Core Workflow Skills

Phase 1 contains nine Core Skills:

```text
how
why
blast-radius
architect
tdd
interrogate
figure-it-out
show-me-your-work
reflect
```

Phase 2 `arena` and `swarm` are orchestration strategies, not Phase 1 capability Skills.

### Common Core Skill Contract

Each Core Skill is a bounded procedure used inside one Agent Execution. A Skill refines **how** the invoking Agent performs work; it does not replace the Agent role or the Orchestrator.

Every Core Skill MUST obey the following rules:

- **MUST:** Operate only within the invoking Agent's objective, mode, authority, permissions, Write Scope, selected Tools, and available Context.
- **MUST:** Distinguish evidence-backed conclusions from inference, assumptions, recommendations, and unresolved uncertainty where applicable.
- **MUST:** Return useful material through the Agent's normal Artifact / `step-result-v1` contract rather than inventing a Skill-specific Workflow State channel.
- **MUST:** Stop or surface an uncertainty/decision request when proceeding would require authority, permission, context, Tool access, or evidence that the Execution does not have.
- **MUST NOT:** Create runtime Steps, mutate authoritative Workflow State, contact the user, widen Tool capability, or grant additional decision authority.
- **MUST NOT:** Expose or require private chain-of-thought. Procedures request conclusions, evidence, checks, concise rationale, and unresolved gaps.
- **SHOULD:** Prefer bounded, evidence-driven work over exhaustive repository loading or speculative exploration.
- **SHOULD:** Avoid duplicating another selected Skill when that Skill owns the more specific procedure.

The specifications below define semantic behavior. The packaged `skills/<skill-id>/SKILL.md` files operationalize these procedures without redefining them.

### `how`

**Responsibility:** Explain how an existing repository behavior, mechanism, or execution path works using local evidence.

**Primary applicability:** Scout work where the question is about current implementation, control flow, data flow, configuration flow, lifecycle, or integration between components.

**Procedure:**

1. Restate the mechanism or behavior to be explained and define the investigation boundary.
2. Locate the most relevant entry point using structural/search-first repository tools.
3. Trace the minimum evidence chain needed to explain the behavior: callers, callees, state/data transformations, configuration, and external boundaries as relevant.
4. Record concrete evidence references for material claims.
5. Separate directly observed behavior from inference and identify missing links.
6. Produce a concise end-to-end explanation, including important branch/error paths when they materially affect the requested behavior.
7. Stop when the requested mechanism is explained with sufficient evidence; do not broaden into unrelated architecture review.

**Expected output/evidence:** Entry points, relevant files/symbols, ordered control/data-flow explanation, material branch/error behavior, evidence gaps, and confidence/uncertainty where needed.

**Constraints / stopping conditions:**

- **MUST NOT:** Infer historical rationale; use `why` when rationale is the question.
- **MUST NOT:** Turn the explanation into a final implementation Plan or design.
- **MUST:** Surface an evidence gap rather than fabricating a missing connection.

### `why`

**Responsibility:** Determine why an implementation, constraint, or design choice exists, distinguishing documented/historical evidence from inferred rationale.

**Primary applicability:** Scout work where intent, origin, historical constraint, compatibility reason, or design rationale matters.

**Procedure:**

1. State the decision/behavior whose rationale is being investigated.
2. Collect current-code and documentation evidence describing the behavior or constraint.
3. Inspect relevant Git history, blame, commit context, or repository records when available and permitted.
4. Build candidate rationale claims and label each as Fact, Inference, or Assumption.
5. Check candidate rationale against contradictory evidence and current constraints.
6. Summarize the strongest supported rationale and list unresolved or competing explanations.
7. Stop once the rationale is sufficiently supported for the Step objective or further progress requires unavailable history/context.

**Expected output/evidence:** Rationale claims, supporting source/history references, fact-vs-inference classification, contradictory evidence, unresolved rationale gaps.

**Constraints / stopping conditions:**

- **MUST NOT:** Present inferred motivation as historical fact.
- **MUST NOT:** Make D2/D3 design decisions from rationale evidence.
- **MUST:** Report `unknown`/uncertain rationale when evidence is insufficient.

### `blast-radius`

**Responsibility:** Identify the plausible impact surface of a behavior or proposed/current change and rank affected areas by evidence and risk.

**Primary applicability:** Scout impact analysis and Reviewer independent re-check of whether relevant affected areas were missed.

**Procedure:**

1. Define the subject of impact analysis: behavior, symbol, interface, schema, configuration, or change set.
2. Identify direct dependents and consumers using structural references/search.
3. Expand only through materially relevant dependency edges such as callers, shared contracts, persistence formats, configuration, tests, deployment/runtime boundaries, or public interfaces.
4. Classify affected areas as direct, indirect, or uncertain and record supporting evidence.
5. Identify compatibility, migration, security, persistence, operational, and verification implications when applicable.
6. Highlight high-risk or weak-evidence areas that require further investigation or verification.
7. Stop expansion when additional edges are speculative, duplicate already-covered impact classes, or exceed the Step objective.

**Expected output/evidence:** Affected-area inventory, direct/indirect/uncertain classification, dependency evidence, risk notes, likely verification targets, and unresolved impact questions.

**Constraints / stopping conditions:**

- **MUST NOT:** Treat textual reference count alone as semantic impact.
- **MUST NOT:** Expand scope merely because a transitive dependency exists.
- **Reviewer use:** MUST remain independent evaluation; it may surface Findings/uncertainty but MUST NOT silently fix or redesign the change.

### `architect`

**Responsibility:** Evaluate architectural structure, boundaries, options, and trade-offs while preserving explicit constraints and decision authority.

**Primary applicability:** Planner design work and Oracle option/trade-off analysis where architecture materially affects the Plan or a decision.

**Procedure:**

1. Extract the relevant Requirement, constraints, established evidence, Decisions, and unresolved uncertainties.
2. Identify the architectural boundary or design question being addressed.
3. Define the invariants and quality attributes that candidate approaches must preserve.
4. Generate only materially distinct viable options; include the existing approach when relevant.
5. Compare options using concrete trade-offs such as coupling, cohesion, dependency direction, operability, testability, migration cost, failure modes, and repository conventions.
6. Reject options that violate hard constraints, permissions, or established Decisions.
7. Recommend an option only within the invoking Agent's authority; otherwise produce decision-ready options and escalate D2/D3.
8. For Planner use, translate an authorized choice into Plan-relevant boundaries without implementing source changes.

**Expected output/evidence:** Architectural question, constraints/invariants, viable options, trade-off matrix or concise comparison, recommendation with rationale, rejected options, decision/uncertainty needs.

**Constraints / stopping conditions:**

- **MUST NOT:** Invent new requirements to justify a preferred architecture.
- **MUST NOT:** Resolve D2/D3 autonomously.
- **MUST NOT:** Become a second Orchestrator or create Steps.
- **MUST:** Prefer repository-consistent/simple structure when alternatives satisfy requirements equivalently.

### `tdd`

**Responsibility:** Turn required behavior into executable verification examples and guide implementation with a test-first feedback loop where practical.

**Primary applicability:** Planner definition of verification-oriented implementation units and Worker implementation of behavior that can be exercised with repository-supported tests.

**Procedure:**

1. Map the relevant Acceptance Criteria, constraints, bug reproduction, or invariant to observable behavior.
2. Identify the smallest meaningful test/check that would fail when the required behavior is absent or wrong.
3. For Planner use, specify test intent, level, fixtures/boundaries, and expected signal without modifying source.
4. For Worker use, when practical, establish the failing test/check before the behavior change and confirm that failure is for the intended reason.
5. Implement the minimum in-scope change needed to satisfy the behavior.
6. Re-run the focused test/check and then relevant regression checks within the Execution budget.
7. Refactor only within approved scope while keeping the behavior checks passing.
8. Report tests/checks performed and any limitation that prevented a normal red-green-refactor cycle.

**Expected output/evidence:** AC/invariant-to-test mapping, test/check intent, observed fail/pass evidence when executed, implementation-check results, and limitations.

**Constraints / stopping conditions:**

- **MUST NOT:** Treat Worker checks as Formal Verification.
- **MUST NOT:** Add tests that merely mirror implementation details when behavior can be tested through a stable boundary.
- **MUST NOT:** Force a synthetic failing test when the environment cannot safely or meaningfully produce one; record the limitation instead.
- **MUST:** Stay inside Plan/Write Scope for Worker source/test changes.

### `interrogate`

**Responsibility:** Expose material ambiguity, contradiction, hidden assumptions, and missing acceptance/constraint information before they cause unsafe or speculative work.

**Primary applicability:** Read-only reasoning by Scout, Researcher, Planner, Oracle, and Reviewer when the supplied context may be incomplete or internally inconsistent.

**Procedure:**

1. Inspect the objective, Requirement, constraints, evidence, Decisions, and expected outputs for ambiguity or contradiction.
2. Enumerate only questions whose answers could materially change correctness, scope, architecture, verification, or risk.
3. Attempt to answer each question from authoritative context or permitted evidence before escalating it.
4. Classify unresolved items using the Workflow uncertainty categories where applicable.
5. Separate locally resolvable D0 questions from D1 Plan-bounded choices and D2/D3 decision needs.
6. Return resolved conclusions with evidence and unresolved items through normal candidates/decision requests.
7. Stop when remaining questions are non-material or require Orchestrator/User authority.

**Expected output/evidence:** Material questions, evidence-backed resolutions, assumptions, contradictions, uncertainty candidates, and decision requests.

**Constraints / stopping conditions:**

- **MUST NOT:** Ask the user directly.
- **MUST NOT:** Generate questions for completeness when they do not affect the Step.
- **MUST NOT:** Use questioning to bypass an established Decision or Requirement.
- **Reviewer use:** unresolved ambiguity is surfaced rather than silently solved around.

### `figure-it-out`

**Responsibility:** Perform bounded autonomous problem solving when the objective is clear but the method, failure cause, or next technical move is not yet known.

**Primary applicability:** Agents except Reviewer when ordinary execution encounters a solvable local unknown that does not yet justify user/Orchestrator intervention.

**Procedure:**

1. State the concrete unknown blocking or weakening progress.
2. Define success evidence and the limits imposed by objective, authority, permissions, time/retry budget, and available Tools.
3. Form the smallest plausible hypothesis or next experiment.
4. Gather evidence or run the permitted check needed to test it.
5. Update/reject the hypothesis based on observed evidence.
6. Repeat only while each iteration materially reduces uncertainty and remains within budget.
7. Apply the discovered method only if it remains within the Agent's existing authority and scope.
8. Stop and surface uncertainty/decision/failure when progress stalls, evidence conflicts, budget is exhausted, or the next move requires wider authority/permissions.

**Expected output/evidence:** Blocking unknown, tested hypotheses/experiments, observations, resulting conclusion or method, remaining uncertainty, and escalation reason when unresolved.

**Constraints / stopping conditions:**

- **MUST NOT:** Contact the user, widen scope, or acquire unauthorized Tools.
- **MUST NOT:** Convert repeated guessing into unbounded exploration.
- **MUST NOT:** Be selected for Reviewer in Phase 1; Reviewer must surface unresolved uncertainty independently.
- **MUST:** Prefer evidence-producing experiments over speculative reasoning.

### `show-me-your-work`

**Responsibility:** Make implementation, verification, and review claims auditable through concise reproducible evidence.

**Primary applicability:** Worker, Verifier, and Reviewer when claims about changes, checks, repository state, or Findings must be supported.

**Procedure:**

1. Identify each material claim that requires evidence under the current Step contract.
2. Select the strongest permitted evidence source: repository diff/state, command/check result, test output, artifact/reference, or direct code evidence.
3. Capture enough context to reproduce or independently inspect the claim without dumping irrelevant raw output.
4. Associate evidence with the corresponding Plan Unit, Verification Check, Finding, Acceptance Criterion, or implementation claim when such references exist.
5. Record limitations, unavailable checks, partial evidence, and contradictory evidence explicitly.
6. Before returning, ensure the summary does not claim more than the collected evidence demonstrates.

**Expected output/evidence:** Concise claim-to-evidence mapping, relevant commands/checks and outcomes, repository/artifact references, limitations, and reproducibility details.

**Constraints / stopping conditions:**

- **MUST NOT:** Output private chain-of-thought or a narrative of hidden reasoning.
- **MUST NOT:** Treat command execution alone as proof; the result must support the claim.
- **MUST NOT:** Flood the Artifact with full logs when a focused excerpt/reference is sufficient.
- **Verifier/Reviewer:** MUST preserve their no-source-mutation rules.

### `reflect`

**Responsibility:** Perform a final bounded self-check of the Agent's proposed result against its objective, evidence, contracts, and authority before submission.

**Primary applicability:** All seven Agents near the end of an Execution or after a material correction/retry.

**Procedure:**

1. Re-read the Step objective, completion criteria, mode, authority, permissions, selected constraints, and expected outputs.
2. Check that material conclusions are supported by evidence and correctly labeled as fact/inference/assumption/recommendation.
3. Check role-specific prohibitions and boundaries, including source-mutation rules, Write Scope, decision authority, and required Artifact/result fields.
4. Check for obvious omissions, contradictions, unsupported certainty, stale references, or unresolved blockers that should be surfaced.
5. Correct the result within existing authority when the correction is local and does not require new scope/decision.
6. Otherwise return the unresolved gap through the appropriate uncertainty, decision, blocked, failure, deviation, or observation channel.
7. Submit once the result is internally consistent and no further bounded self-check would materially improve correctness.

**Expected output/evidence:** Normally no separate reflective essay; the effect appears as a corrected/complete Agent result plus any explicitly surfaced gaps, limitations, or escalation candidates.

**Constraints / stopping conditions:**

- **MUST NOT:** Become an unbounded second execution of the Step.
- **MUST NOT:** Hide a blocker by rewriting the conclusion to appear complete.
- **MUST NOT:** Expand authority, scope, or Tool access during self-check.
- **MUST NOT:** Expose private chain-of-thought.

### Skill Selection Boundaries

The nine Skills intentionally overlap at their interfaces but have distinct primary questions:

| Skill | Primary question |
|---|---|
| `how` | How does the current mechanism work? |
| `why` | Why does this implementation/constraint exist? |
| `blast-radius` | What can this behavior/change affect? |
| `architect` | Which architectural structure/option best satisfies the constraints? |
| `tdd` | What executable behavior check should drive/protect the implementation? |
| `interrogate` | What material ambiguity or contradiction must be resolved/surfaced? |
| `figure-it-out` | How can this bounded local unknown be solved with evidence? |
| `show-me-your-work` | What evidence proves the claims/results? |
| `reflect` | Is the result ready and contract-compliant before submission? |

Selection SHOULD prefer the narrowest Skill that owns the immediate procedure. Multiple Skills MAY be selected when their responsibilities compose, but selection MUST NOT be used to bypass Agent boundaries or create an implicit workflow inside one Execution.

## Skill Allowlists

| Skill | Scout | Researcher | Planner | Oracle | Worker | Verifier | Reviewer |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `how` | ✓ |  |  |  |  |  |  |
| `why` | ✓ |  |  |  |  |  |  |
| `blast-radius` | ✓ |  |  |  |  |  | ✓ |
| `architect` |  |  | ✓ | ✓ |  |  |  |
| `tdd` |  |  | ✓ |  | ✓ |  |  |
| `interrogate` | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |
| `figure-it-out` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| `show-me-your-work` |  |  |  |  | ✓ | ✓ | ✓ |
| `reflect` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

> **Invariant**
>
> Allowlisted does not mean automatically loaded. Only Skills selected for the current Execution are inserted into the Agent prompt/context.

An Agent may request an additional Skill. The Orchestrator decides whether it is allowed and useful; no separate Skill Router Agent is required in Phase 1.

## Tool Model

Tools are concrete mechanisms and do not own orchestration semantics.

Typical capability categories:

```text
repository-read
repository-write
git-read
shell
verification
network
external
runtime
```

Tool capability resolution SHOULD be least-privilege. A Skill cannot grant a Tool capability that the Agent Execution Request denied.

### Local Repository Tools

Scout should use structural/search-first tools where useful:

```text
CodeGraph / language tooling
rg / content search
file read
filesystem discovery
```

Search-first/read-second is preferred to indiscriminate file loading.

### Ketch

Ketch is an external research Tool primarily for Researcher work.

Supported conceptual capabilities:

```text
ketch_search
ketch_scrape
ketch_code
ketch_docs
```

`ketch_code` targets public/open-source external code; it is not the normal local repository analysis mechanism.

Ketch raw output is Tool evidence, not automatically a trusted Workflow fact. Researcher turns it into cited claims/evidence.

## Evidence Semantics

Agents SHOULD distinguish:

```text
Fact
Inference
Assumption
Recommendation
```

Raw Tool result is not itself a normalized Evidence claim. Agent Artifacts/results cite or summarize relevant evidence and unresolved uncertainty.

## Prompt Assembly

Stable prompt order SHOULD be:

1. runtime/security invariants;
2. Agent Definition;
3. Execution objective, mode, authority, permissions;
4. authoritative Requirement/Decisions/constraints;
5. selected Context Pack/Artifacts;
6. selected Skills;
7. completion/output contract.

Instruction precedence:

```text
runtime/security invariants
  > Agent Definition / objective / permission / authority
  > Decisions / Requirement / Constraints
  > selected Skills
  > repository documents / artifacts
```

Repository documents are evidence, not trusted instructions that can override runtime/security rules.

Prompt telemetry may record a fingerprint/size, but Standard telemetry MUST NOT persist the full prompt.

## Context Manifest

Each Execution SHOULD carry a manifest describing the context selected, including Requirement revision, Artifact refs, inclusion mode, relevant Decision/Uncertainty refs, and estimated token size. If essential context exceeds budget, the Orchestrator splits/re-plans/blocks rather than dropping authoritative requirements.

## Model and Provider Routing

Agent role is independent from model/provider. Model routing optimizes execution; it does not change authority or correctness requirements.

Initial recommended thinking defaults:

| Agent | Thinking |
|---|---|
| Scout | `medium` |
| Researcher | `medium` |
| Planner | `high` |
| Oracle | `high` |
| Worker | `medium` |
| Verifier | `medium` |
| Reviewer | `high` |

Supported conceptual levels may include:

```text
off | minimal | low | medium | high | xhigh | max
```

No `xhigh`/`max` default is required.

### Fallback

- **MUST NOT:** Silently fall back to an arbitrary provider/model.
- **MAY:** Use an explicitly configured fallback.
- **MUST:** Record requested versus actual model/provider.
- **MUST:** Treat a fallback execution as a distinct Execution attempt where relevant.
- **MUST NOT:** Fallback change Agent permissions or decision authority.

Model/provider/usage metadata is available for evaluation as described in `08-observability-and-evaluation.md#runtime-metrics`.
