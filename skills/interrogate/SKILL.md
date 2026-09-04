---
name: interrogate
version: 1.0.0
description: Find material ambiguity, contradiction, hidden assumption, and missing constraint before safe progress.
dependencies: []
capabilities: []
preferred_artifacts:
  - analysis
requirements:
  - An objective, requirement, evidence set, design, review basis, or execution contract
  - A material unknown that can affect correctness, safety, scope, authority, or completion
---
# interrogate

## Purpose and Responsibility

`Agent = who; Skill = how; Tool = mechanism.` This document supplies procedure only and does not change the invoking Agent's role.

Answer the primary question: **Which material ambiguity or conflict must be resolved or surfaced?** Turn uncertainty into evidence-backed clarification or escalation candidates. Do not silently select an interpretation, invent a Requirement, or contact the User.

## When to Use

Use in Scout, Researcher, Planner, Oracle, or Reviewer Executions when a Requirement, evidence set, design, impact assessment, review basis, or execution contract contains a material unknown or conflict. Ask only questions that can change correctness, safety, scope, authority, or completion; routine questions already answered by supplied evidence do not qualify.

## Inputs and Evidence

Read the immutable Agent Execution Request, objective, completion criteria, authority, permissions, Write Scope, Tool policy, current Requirement revision, Acceptance Criteria, constraints, Decisions, Uncertainties, selected Artifacts, repository facts, and permitted external evidence. Mark the source and currentness of each claim.

## Procedure

1. State the objective, the decision or action waiting for an answer, the information needed, and the consequence of proceeding without it.
2. Inspect authoritative context and direct evidence before proposing a question. Resolve an item locally when the answer is explicit, current, and unambiguous.
3. Enumerate material ambiguity, contradiction, missing evidence, hidden assumption, or incompatible instruction. Test each interpretation against Requirements, Decisions, constraints, and direct evidence. Ask whether a different answer would materially change correctness, requested behavior, scope, architecture/design authority, verification, security/safety, concrete compatibility, completion eligibility, or required authority.
4. Do not generate a question merely for completeness. Absence of a convention, caller, CI, or external contract is not a material Uncertainty by itself, and a hypothetical external risk without a concrete current-Requirement tie is not a blocker.
5. For every unresolved material item, record a concise question, real options or interpretations when they exist, evidence for and against each, the impact of each answer, and the required authority/destination: Agent, Oracle, Orchestrator, or User.
6. Classify the item as an uncertainty, decision candidate, clarification candidate, or permitted D0 local assumption. Distinguish D0 local assumptions, D1 plan-bounded choices, and D2/D3 escalation without making the latter choices.
7. If no material item remains, return that conclusion with the checks and evidence used. Otherwise stop at the clarification boundary and return bounded requests rather than continuing into implementation or design.

## Expected Output and Evidence

Return the normal `step-result-v1` fields and normally an `analysis` Artifact with purpose `interrogate` containing:

- `observations` for resolved facts;
- `uncertainty_candidates` for unresolved unknowns;
- `decision_requests` or `requirement_candidates` when routing is required;
- for each material item: question, why it matters, evidence refs, alternatives, assumption/impact, requested authority, and currentness;
- an explicit statement that the procedure completed or stopped at a blocker.

Do not allocate authoritative IDs. The Orchestrator decides whether and how a request is routed through `Agent → Orchestrator → User`.

## Constraints and Stopping / Escalation

Never ask the User directly. Do not resolve D2/D3, invent Requirements, create Steps, mutate source, State, or graph, bypass an existing Decision, or widen authority, permissions, Tools, or Write Scope. Reviewer must surface ambiguity rather than silently resolving it. Stop with `blocked` or escalation when the ambiguity is material, evidence is contradictory, authority is unavailable, or the question cannot be answered with permitted evidence; otherwise stop without a candidate when the remaining unknown is non-material. Do not use questioning to create an implicit workflow or call another Skill.
