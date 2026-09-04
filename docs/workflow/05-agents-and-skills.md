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
uncertainty_rechecks: []
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

`uncertainty_rechecks` is an additive field; legacy wire payloads that omit it are normalized to an empty array before State processing.

- **MUST:** Stable array fields be present even when empty.
- **MUST:** A `failed` outcome contain structured failure information.
- **MUST:** A `blocked` outcome identify the blocking reason/ref.
- **MUST NOT:** Agent candidates use authoritative `U-*`, `D-*`, `F-*`, or other State IDs; the Orchestrator allocates them.
- **MUST:** An `uncertainty_rechecks` item may reference an existing `U-*` only, use `action: resolve`, and cite concrete evidence; it does not change authoritative status.
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
- **MUST:** Apply the Uncertainty admission boundary and surface only candidates material to the current Requirement/Run; a required current-Requirement behavior or verification check unavailable to the Execution remains material.
- **MUST NOT:** Produce the final implementation design, final Plan, or source change.
- **MUST NOT:** Promote absent convention/caller/CI/external-contract evidence or hypothetical external impact into a blocking Uncertainty without a concrete material tie.
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

### Core Skill behavioral contract

A selected Core Skill is one reusable procedure inside one Agent Execution. It receives the immutable Agent Execution Request (`agent-execution-request-v1`), the selected Context/Artifact refs, and only the Tool capabilities resolved for that Execution. The procedure MUST:

1. start from the Execution objective, completion criteria, authority, permissions, Write Scope, and output contract;
2. use only supplied/current evidence and permitted Tools;
3. distinguish `Fact`, `Inference`, `Assumption`, and `Recommendation` in its externalized result;
4. return its conclusion, concise rationale, Evidence, Checks, assumptions, and residual Uncertainty through the normal `step-result-v1` fields; and
5. leave result validation, candidate normalization, Artifact finalization, Workflow State mutation, graph mutation, and escalation routing to the Orchestrator.

A Skill may prepare Artifact content, but it MUST NOT treat a draft or unvalidated result as a finalized authoritative Artifact. New `U-*`, `D-*`, `F-*`, `P-*`, or `V-*` identities are allocated by the Orchestrator/domain layer; an Agent/Skill MUST return candidates or scoped references without fabricating authoritative IDs. The procedure cannot change the Agent's mode, authority or D0/D1/D2/D3 decision class, permissions, Write Scope, Tool capability, or decision authority. User interaction remains `Agent → Orchestrator → User`; a Skill never invokes it. Private chain-of-thought is never requested, emitted, or persisted; only externally verifiable conclusions, Evidence, Checks, concise rationale, assumptions, and Uncertainty are returned.

The outcome describes the procedure, not final Workflow acceptance: `completed` requires the requested procedure's output and supporting Evidence, `blocked` means a required input, capability, authority, or external resolution is unavailable, and `failed` means an attempted procedure/check could not safely produce its output. A usable incomplete handoff is represented as a `partial` Artifact with explicit limitations, not as a new Step status. A selected set of Skills is not an implicit workflow: these procedures do not call one another, create runtime Steps, or impose an execution order.

### Uncertainty admission boundary

An unknown or evidence gap MUST NOT become an authoritative `Uncertainty` merely because information is absent or completeness would benefit. Before returning an `uncertainty_candidates` item, the Agent MUST establish that the unknown is relevant to the current Requirement/Run and that a different answer could materially change correctness, requested behavior, scope, architecture/design authority, verification, security/safety, concrete compatibility, completion eligibility, or required authority. If none of those material dimensions would change, the Agent MUST NOT emit an `uncertainty_candidates` item. A required current-Requirement behavior or verification check unavailable to the Execution is material and MUST be surfaced for later authorized evidence. Absence of evidence alone—such as no convention, CI, caller, or external contract found—is an observation or scope limitation, not a blocking Uncertainty. A D0 local choice or D1 Plan-bounded choice that stays within authority and does not materially change the current Requirement is not an Uncertainty. A hypothetical external caller or impact without repository/supplied evidence or an explicit current compatibility requirement is not automatically material. This boundary routes non-material facts/choices to observations or semantically appropriate bounded Plan assumptions without requiring automatic Requirement-assumption persistence; it does not add a new State entity, status, or authority level.

### `how`

**Responsibility**

Describe how the current subject actually behaves: its entry point, control/data flow, relevant branches, boundaries, outputs, and observable side effects. `how` establishes behavior facts; it does not explain intent or design a replacement.

**Primary applicability**

Use for a bounded behavior question or behavior uncertainty, normally in a Scout read-only Execution: tracing an existing execution path, locating where a contract is enforced, or explaining current success/error behavior. Do not select it as a substitute for rationale (`why`), impact analysis (`blast-radius`), architecture choice (`architect`), or requirement clarification (`interrogate`).

**Procedure**

1. Restate the behavior question and bound the subject, entry/exit conditions, relevant repository area, and required output from the Execution objective.
2. Locate the entry points, callers, callees, configuration, contracts, tests, and relevant Artifact/State references using structural/search-first inspection.
3. Trace the normal path and the relevant error/edge branches to their observable outputs. Record only observed control flow, data flow, state/Artifact interaction, Tool boundary, and permission boundary.
4. Corroborate the trace with the implementation, tests or permitted checks, and authoritative context. Mark documentation as intended behavior when it is not evidence of runtime behavior.
5. Separate facts from inferences and assumptions, compare the observed behavior with the supplied completion criteria, and list gaps or contradictory observations without resolving them by guesswork.
6. Produce the handoff and stop when the bounded behavior map is supported or when a missing/contradictory basis must be surfaced.

**Expected output / Evidence**

Return an analysis handoff (normally an `analysis` Artifact with purpose `how`) containing a `## Handoff Summary`, a behavior map, source/Artifact refs, relevant command or test results, and scope limitations. Put factual observations in `observations`; put unresolved behavior, contradictions, or missing access in `uncertainty_candidates` only when they are material to the current Requirement/Run, with assumptions called out explicitly. Do not return a final Plan or design recommendation.

**Constraints / stopping conditions**

`how` is read-only under its Phase 1 allowlist and cannot mutate source, create Steps, change State, or choose a Decision. Stop and surface a material behavior Uncertainty or `blocked` result when the entry point, relevant branch, current evidence, or required Tool is unavailable, or when evidence conflicts materially. Do not promote absence of evidence alone or fill a missing behavior contract with an assumption.

### `why`

**Responsibility**

Explain the evidence-backed reason a current implementation, constraint, or design choice exists, including the causal drivers and trade-offs that can be supported. `why` describes rationale, not the mechanics themselves or a new design.

**Primary applicability**

Use for an unresolved rationale question in a Scout read-only Execution, such as why a constraint, compatibility path, guard, or unusual implementation exists. Do not use it to infer author intent from code alone, to decide what should be built, or to map downstream impact.

**Procedure**

1. State the exact choice/constraint and the time or version basis for the rationale question.
2. Gather relevant Requirement/constraint/Decision context, documentation, comments, tests, implementation history, and permitted Git evidence. Record the source and whether it is direct or indirect evidence.
3. For each candidate rationale, connect the choice to the supporting evidence and distinguish an explicit reason from a causal inference or assumption. Include a trade-off only when the evidence supports it.
4. Check the candidate explanation against current behavior and available historical evidence; identify stale, conflicting, or missing rationale evidence.
5. Synthesize the most supported explanation, its confidence and limits, and any material question that requires Orchestrator/Oracle/User authority rather than an Agent conclusion.
6. Return the rationale handoff without converting the explanation into a final Decision or implementation recommendation.

**Expected output / Evidence**

Return an analysis handoff (normally an `analysis` Artifact with purpose `why`) with a concise rationale, cited local refs/commands, the relevant constraints or trade-offs, and `Fact`/`Inference`/`Assumption` labels. Record unresolved or conflicting rationale as `uncertainty_candidates` only when it is material to the current Requirement/Run; include `decision_requests` only to route a material unresolved choice, never as a resolved Decision. The result MUST say when no causal evidence was found.

**Constraints / stopping conditions**

Do not invent author intent, treat a historical commit message as current authority, or turn a plausible explanation into a requirement. Do not mutate source or resolve D2/D3. Stop when causal evidence is absent or materially conflicting and the missing rationale can affect the current Requirement/Run; otherwise report the evidence boundary without creating a blocking Uncertainty.

### `blast-radius`

**Responsibility**

Determine what a current behavior, proposed change, or observed repository mutation could affect, and how confidently: direct and indirect code paths, contracts, Acceptance Criteria, State/Artifact/Event flows, verification/review scope, and safety boundaries. It is impact analysis, not architecture or implementation.

**Primary applicability**

Use when a Scout or Reviewer must bound the consequences of a behavior or change, assess affected areas, identify regression exposure, or evaluate whether current evidence covers the subject. The subject and its basis (Requirement, Plan, Change Set, repository snapshot, or investigation evidence) must be supplied or discoverable within the Execution; do not use `blast-radius` to choose a design.

**Procedure**

1. Identify the subject, comparison/baseline, repository or Plan version, and the impact question. If the basis is a proposed change, use the supplied proposal rather than inventing one.
2. Enumerate direct references and immediate consumers, then trace callers/dependents, configuration, data/state, Artifact/Event, persistence, Tool, permission, and user-interaction boundaries as relevant to the subject.
3. Compare the actual current diff/snapshot and relevant evidence with the stated scope when available. Record both affected and inspected-but-not-affected areas; do not equate touched files with the full impact.
4. Classify each impact as direct, indirect, or unknown and describe its affected contract/behavior, confidence, and evidence. Cover relevant correctness, security, compatibility, operational, and verification/review consequences without inventing a risk. Surface an impact Uncertainty only when a different answer could materially change the current Requirement/Run and concrete repository/supplied evidence or an explicit compatibility requirement ties the unknown to that impact.
5. Treat a repository search finding no caller, CI integration, convention, or external contract as an absence-of-evidence observation, not proof of absence and not a blocker by itself. Do not promote a hypothetical external consumer into an Uncertainty without that material tie.
6. Map material impacts to Acceptance Criteria/constraints and list the smallest checks or additional evidence needed to confirm them.
7. Return the impact handoff with scope limits and unresolved material impact Uncertainty; do not decide whether to re-plan, switch Playbooks, or accept the risk.

**Expected output / Evidence**

Return an analysis handoff (normally an `analysis` Artifact with purpose `blast-radius`) containing the subject/basis, impact map, affected and unaffected areas, traceability to relevant AC/constraints, risk/confidence, required checks, and evidence refs. Use `observations` for established impact facts and `uncertainty_candidates` only for unknown reach or incomplete dependency evidence that is material to the current Requirement/Run; hypothetical reach remains a scoped limitation. A Reviewer MUST also provide the evidence needed for any resulting Finding candidate, but does not assign its authoritative identity or disposition.

**Constraints / stopping conditions**

Remain read-only and independent of implementation/design authority. Do not silently broaden scope, mutate source/State, create a recovery Step, or resolve an impact uncertainty by using `figure-it-out`; `figure-it-out` is not in the Reviewer allowlist. Stop and escalate when the subject/baseline is ambiguous, a critical boundary cannot be inspected, or impact remains materially unknown with a concrete current-Requirement tie.

### `architect`

**Responsibility**

Provide decision support for a compliant architecture: identify boundaries, responsibilities, interfaces/data flow, viable structural options, trade-offs, and a recommendation appropriate to the current authority. `architect` defines design support; it does not own the final D2/D3 decision or implement the design.

**Primary applicability**

Use in Planner or Oracle read-only Executions when the Requirement, constraints, and relevant evidence are sufficiently understood but a structural choice is needed. Select it for competing architectures, boundary placement, dependency direction, or integration shape; do not use it to explain an existing rationale, perform local diagnosis, or replace a Plan.

**Procedure**

1. Read the current Requirement revision, constraints, relevant Decisions, objective/completion criteria, supplied behavior/impact evidence, authority, and permitted scope. Reject stale or missing authoritative inputs rather than silently substituting them.
2. Extract hard invariants and decision drivers, including security/permission, compatibility, persistence, observability, testability, and dependency-direction constraints that are relevant to the objective.
3. Define the minimum compliant boundary structure and data/control flow. Identify ownership of source mutation, Tools, user interaction, and Workflow State explicitly so the design cannot move those responsibilities into a Skill or Agent.
4. Produce at least one viable option; add alternatives when they are materially different. For each option, evaluate constraint fit, affected interfaces, risks, operational/verification consequences, and required evidence. Keep the option set bounded.
5. For a Planner, recommend only a D0/D1 plan-bounded choice permitted by the request. For an Oracle, any recommendation remains non-authoritative. If the choice is D2/D3, the evidence is conflicting, or no option is safely compliant, return `decision_requests`/Uncertainty with options and trade-offs for Orchestrator routing; do not resolve it.
6. State assumptions, deviations, unresolved dependencies, and Acceptance Criterion coverage, then return decision-support content without creating a Plan, Step, or authoritative Decision.

**Expected output / Evidence**

Return decision-support content (an analysis handoff when no existing Decision ref is supplied). The Orchestrator may finalize the content as a Decision-support Artifact using an existing or newly allocated Decision ref. Include the objective, constraints, option comparison, recommendation status, concise rationale, evidence refs, risks, assumptions, and unresolved decisions. New Decision identities are candidates only; the Orchestrator records authoritative resolution and applies the canonical Decision-support Artifact naming rule.

**Constraints / stopping conditions**

Planner recommendations remain within D1 and approved Plan scope; Oracle recommendations never become D2/D3 authority. Do not mutate source, State, graph, or user-facing decisions; do not widen permissions, Tools, Write Scope, or authority. Stop and escalate when a hard constraint cannot be satisfied, authoritative inputs conflict, or the required choice exceeds the Agent's authority.

### `tdd`

**Responsibility**

Turn an approved behavioral objective into executable Checks/Tests that can drive and protect the implementation, including the expected oracle, edge/error behavior, and regression coverage. `tdd` chooses how behavior is checked; it does not choose the architecture or perform Formal Verification.

**Primary applicability**

Use in Planner and Worker Executions for new behavior, bug fixes, refactors, and other approved write work where observable behavior must be specified and protected. Planner uses it to define verifiable Plan checks; Worker uses it to implement/run authorized Tests and make the smallest approved change. It is not available to Verifier, whose formal checks are governed by the Verification Run.

**Procedure**

1. Read the Requirement/AC/constraints, current Plan Unit and `V-*` checks when supplied, objective, Write Scope, existing evidence, and current tests. Establish the behavior contract and the implementation boundary before editing.
2. Convert each required behavior into an observable case with preconditions, input/action, expected result/state/side effect, and a deterministic pass/fail oracle. Cover the normal path plus relevant boundary, invalid/security, error, and regression cases; map every case to an AC/constraint or label it exploratory.
3. Inspect existing tests and project-native test commands, reuse existing coverage, and record the smallest command/check that exercises each case. Do not invent a new test framework or duplicate a sufficient check.
4. In a Planner Execution, return the check/test design and expected outcomes without mutating the repository. In a Worker Execution, when behavior is new or a bug is reported, first add or run the focused failing/reproducing check within Write Scope when practical, make the smallest approved source/test change, and rerun it. For a refactor, establish characterization/invariant coverage before changing structure when practical.
5. Run the focused checks and the relevant existing regression checks permitted by the request. Record actual `passed`, `failed`, `skipped`, or `unavailable` status and command/output refs; a Worker check is implementation feedback, not Formal Verification.
6. Inspect the resulting change against the check mapping and Write Scope. If a check exposes an ambiguous requirement, unsafe design choice, or scope expansion, stop and surface it instead of changing the test to hide the issue.

**Expected output / Evidence**

Return a check/test matrix with behavior, oracle, AC/constraint traceability, command, expected result, actual result, and limitations. A Planner returns the matrix in the normal plan-support result/Artifact fields without mutating the Plan; a Worker uses `execution_checks`, relevant observations, and normal implementation/Change Set evidence, including the actual diff/scope basis. Never claim Formal Verification from a Worker result and never fabricate a `V-*` identity.

**Constraints / stopping conditions**

Planner MUST remain read-only. Worker may write only within the approved Write Scope and MUST NOT perform Git write operations. Do not weaken, delete, or rewrite a Check merely to obtain a pass, claim success for skipped/unavailable/failed required behavior, or make an off-plan D2/D3 choice. Stop with a blocked/failed result or escalation when the oracle, environment, required capability, authority, or scope is insufficient.

### `interrogate`

**Responsibility**

Find the material ambiguities, contradictions, missing inputs, and authority questions that must be resolved or explicitly surfaced before safe progress. `interrogate` turns uncertainty into evidence-backed clarification requests; it does not silently choose an interpretation.

**Primary applicability**

Use in Scout, Researcher, Planner, Oracle, or Reviewer Executions when a Requirement, evidence set, design, impact assessment, review basis, or execution contract contains a material unknown or conflict. Use it to expose questions that affect correctness, safety, scope, authority, or completion—not to ask routine questions already answered by the supplied evidence.

**Procedure**

1. State the objective, the decision or action that is waiting, the information needed, and the consequence of proceeding without it.
2. Inspect the current Requirement revision, AC/constraints, Decisions/Uncertainties, selected Artifacts, repository facts, and—only when the Agent Request permits it—external evidence. Mark the source and currentness of each claim.
3. Enumerate ambiguity, contradiction, missing evidence, or incompatible instructions. Test each candidate against authoritative context and direct evidence; resolve it locally when the answer is explicit and unambiguous.
4. For every material unresolved item, record the concise question, known options or interpretations (if real), evidence for and against each, impact of each answer, and the required authority/destination (`Agent`, `Oracle`, `Orchestrator`, or `User`).
5. Classify the item as an uncertainty or decision/clarification candidate without allocating an authoritative ID. Separate a permitted D0 local assumption from D1 plan-bounded choice and D2/D3 escalation; do not make the latter choices.
6. If no material unresolved item remains, return that conclusion with the checks/evidence used. Otherwise stop at the clarification boundary and return the bounded requests rather than continuing into implementation or design.

**Expected output / Evidence**

Return `observations` for resolved facts, `uncertainty_candidates` for unresolved material unknowns, and `decision_requests` or add/clarify `requirement_candidates` when routing is needed. Each item includes the question, why it matters, evidence refs, alternatives if applicable, assumption/impact, and requested authority. An analysis handoff (normally purpose `interrogate`) records the same information and explicitly states whether the procedure completed or stopped at a blocker.

**Constraints / stopping conditions**

The Agent MUST NOT contact the User; the Orchestrator routes a `decision_request` or clarification through the `Agent → Orchestrator → User` path. Do not resolve D2/D3, invent requirements, create Steps, mutate State/source, or produce a final design merely because a question is inconvenient. Stop when the ambiguity is material, evidence is contradictory, the required authority is unavailable, or the question cannot be answered with permitted evidence; return `blocked`/escalation as appropriate.

### `figure-it-out`

**Responsibility**

Resolve one local, bounded unknown inside a clear objective by gathering and checking evidence. It is diagnostic/problem-solving procedure, not a mechanism for deciding what the objective means or for replacing architecture/authority decisions.

**Primary applicability**

Use in Scout, Researcher, Planner, Oracle, Worker, or Verifier Executions when the objective is clear and a specific repository, Tool, environment, external-fact, or check result is unknown. Do not use it for a material Requirement/authority ambiguity, a competing architecture choice, or as a way for a Reviewer to silently resolve uncertainty; Reviewer is intentionally not allowlisted.

**Procedure**

1. State the clear objective, the single local unknown, known facts, success criterion, scope, and a bounded attempt budget. Confirm that the unknown is not actually a Requirement or D2/D3 decision question.
2. Form the smallest useful hypotheses and select the least-privilege permitted inspection, search, query, or check that can distinguish them. Do not add capability or broaden the repository scope.
3. Execute one bounded probe at a time and record its input, Tool/command, relevant output, source/ref, and time/basis. A source mutation is forbidden unless the invoking Agent's existing Write Scope explicitly authorizes that experiment; the Skill itself never grants it.
4. Compare the evidence with the success criterion, corroborate or reproduce the result when needed, and state the conclusion, rejected hypotheses, and residual uncertainty. Keep the conclusion local to the original objective.
5. If evidence conflicts, the probe is unsafe/unavailable, or the attempt budget is exhausted, stop and return the uncertainty, evidence gap, or escalation reason instead of guessing or expanding into a new task.

**Expected output / Evidence**

Return a concise diagnostic handoff with `summary`, a conclusion or explicitly unresolved unknown, hypothesis/probe records, command or source refs, Check status, assumptions, and residual `uncertainty_candidates` only when the residual unknown is material to the current objective/Requirement. Use `blocked` when required access/capability/environment is unavailable and `failed` when an attempted probe fails; do not claim resolution from an unexecuted or ambiguous probe. No authoritative State ID is created.

**Constraints / stopping conditions**

Use only the Agent Request's authority, permissions, Tools, mode, and Write Scope. Do not ask the User, create a Step, mutate Workflow State, choose a material design/Requirement/Decision, or continue broad exploration after the local question is answered. Reviewer cannot use this Skill in Phase 1; review must surface uncertainty instead of silently solving it.

### `show-me-your-work`

**Responsibility**

Make Agent claims and produced results inspectable by collecting sufficient, traceable Evidence for the objective, output contract, and relevant AC/Checks. It proves what was observed or executed; it does not own the semantic acceptance decision.

**Primary applicability**

Use in Worker, Verifier, and Reviewer Executions when implementation, verification, review, or investigation results must be supported. Worker evidence covers authorized implementation work and checks; Verifier evidence covers supplied Formal Verification Checks; Reviewer evidence independently supports Review/Finding candidates.

**Procedure**

1. Enumerate the claims, required outputs, AC/constraints, and completion criteria in the Agent Request, then identify the minimum Evidence needed for each claim.
2. For each claim, obtain or observe permitted evidence such as a file/Artifact ref, source location, repository snapshot/diff, command and exit result, test output, or cited external source. Record the subject, basis/revision, provenance, and expected versus actual result.
3. Execute or inspect the relevant Checks permitted for the Agent. Preserve `passed`, `failed`, `skipped`, and `unavailable` distinctions and record limitations; raw Tool output is evidence input, not automatically a normalized fact.
4. Check that evidence is current, relevant, non-contradictory, and not superseded. Map each claim to its Evidence and to the AC/constraint/Check it supports; mark unsupported claims instead of filling the gap.
5. Prepare the appropriate handoff/Artifact content and a concise result. Worker reports implementation intent plus observable repository evidence, Verifier reports Verification Run evidence, and Reviewer reports Review Run/Finding evidence; the runtime/Orchestrator assigns authoritative IDs and finalizes records.
6. Before submission, state residual Uncertainty, missing evidence, and any limitation that prevents a complete claim. Do not call a required failed or unavailable Check passed.

**Expected output / Evidence**

Return an evidence ledger or equivalent `## Handoff Summary` with claim-to-Evidence mapping, source/Artifact/command refs, basis and currentness, Check status, limitations, and concise rationale. Populate `execution_checks` and `observations`; add the role-appropriate Artifact candidate and `finding_candidates`/`finding_rechecks` only when the Agent contract allows them. Evidence must be redactable and independently inspectable; no private chain-of-thought is an output.

**Constraints / stopping conditions**

Verifier and Reviewer MUST NOT mutate source; Worker remains inside Write Scope and MUST NOT perform Git writes. Do not use self-assertion, a stale Artifact, or an unrecorded Tool result as proof; do not resolve findings, decisions, or user choices. When a required Check fails, preserve `failed` status and its implication; a Verifier may still complete evidence capture with a failed Verification Run. Stop with `blocked`, `failed`, or an explicitly partial handoff when required Evidence cannot be captured, provenance is ambiguous, or permissions prevent inspection.

### `reflect`

**Responsibility**

Perform the Agent's final pre-submission contract check: confirm that the result answers the objective, is supported by Evidence, respects the Agent/Execution contract and authority, and declares what remains unresolved. `reflect` is a completeness and compliance check, not independent Verification or Review.

**Primary applicability**

Use before submitting any Agent result, especially a claimed completion, blocked result, failure, Artifact handoff, Decision request, or Finding candidate. It is allowlisted for every Phase 1 Agent and can be selected alone or with other Skills; selection does not create a separate runtime Step.

**Procedure**

1. Re-read the Execution objective, completion criteria, output contract, selected context/Artifact refs, mode, authority, permissions, Write Scope, and Tool policy.
2. Check result identity and role consistency, required summary/artifact refs, stable result arrays, candidate/reference shape, and outcome-specific `blocked`/`failure` information. Ensure no authoritative State IDs were fabricated.
3. Check every material claim against cited Evidence and currentness. Label `Fact`, `Inference`, `Assumption`, and `Recommendation`; verify AC/constraint/Check coverage and record missing or unsupported items.
4. Check that actual Tool use, source mutation, Artifact claims, user-interaction attempts, and decision scope stay within the Agent Request. Confirm that no Skill has created a Step, changed Workflow State, or widened authority/permissions/Tools.
5. Run only the smallest permitted consistency check needed to resolve an output omission; do not substitute this check for Formal Verification or independent Review.
6. Correct response-format omissions or retract/downgrade unsupported claims within the Agent's authority. If the contract still cannot be met, stop and return the precise blocker/failure/escalation instead of claiming completion.
7. Submit only the concise external result and checklist outcome through the Orchestrator; do not emit or persist private chain-of-thought.

**Expected output / Evidence**

Return a compact reflection checklist in `observations` or `execution_checks` showing objective/output coverage, Evidence coverage, authority/permission/Write Scope compliance, and remaining gaps. Preserve the normal `step-result-v1` fields, including candidates and structured blocker/failure details as applicable. The checklist is evidence of preflight, not proof that the implementation is correct or that a Gate has passed.

**Constraints / stopping conditions**

Do not independently redesign, verify, review, ask the User, mutate source/State/graph, allocate authoritative IDs, or override the Agent Definition/Execution Request. Do not hide a missing Artifact, failed Check, unresolved Uncertainty, or authority violation. Stop before submission and return `blocked`/`failed` with partial evidence where appropriate when the result cannot satisfy the contract.

### Core Skill boundaries

The Skills answer different questions and MUST NOT be treated as interchangeable:

| Skill | Primary question | Explicit boundary |
|---|---|---|
| `how` | How does the current mechanism behave? | Describes observed flow; does not explain rationale or propose a design. |
| `why` | Why does this current choice or constraint exist? | Explains supported rationale; does not replace behavior tracing or decide what to build. |
| `blast-radius` | What could this behavior or change affect? | Maps impact and evidence gaps; does not select architecture or re-plan. |
| `architect` | What compliant structure/option should be recommended? | Provides bounded design support; does not own D2/D3, create a Plan, or implement. |
| `tdd` | Which executable behavior Checks/Tests drive and protect the work? | Defines/runs approved behavior checks; does not choose architecture or perform Formal Verification. |
| `interrogate` | Which material ambiguity or conflict must be resolved or surfaced? | Drafts bounded clarification/escalation; does not silently choose or contact the User. |
| `figure-it-out` | Which local unknown can Evidence resolve inside a clear objective? | Performs bounded diagnosis; does not resolve Requirement/authority ambiguity and is not available to Reviewer. |
| `show-me-your-work` | What Evidence supports each claim or result? | Captures traceability; does not own semantic acceptance or final disposition. |
| `reflect` | Does this result satisfy its objective and contract before submission? | Performs Agent preflight; does not substitute for independent Verification/Review. |

The existing Agent allowlist is normative for these procedures. In particular, `figure-it-out` remains unavailable to Reviewer, and no Skill is added to an Agent to compensate for a missing authority, permission, Tool capability, or decision route. The procedures do not define Phase 2 orchestration strategies or Operational Skills.

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
