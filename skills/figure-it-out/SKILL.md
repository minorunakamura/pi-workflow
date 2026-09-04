---
name: figure-it-out
version: 1.0.0
description: Resolve one bounded local technical unknown through least-privilege hypotheses, experiments, and evidence updates.
dependencies: []
capabilities: []
preferred_artifacts:
  - analysis
requirements:
  - A clear objective and one local unknown
  - A permitted Tool/check, success evidence, and bounded attempt budget
---
# figure-it-out

## Purpose and Responsibility

`Agent = who; Skill = how; Tool = mechanism.` This document supplies procedure only and does not change the invoking Agent's role.

Answer the primary question: **How can this bounded local unknown be resolved with evidence?** Perform focused diagnosis or problem solving when the objective is clear but the method, failure cause, repository fact, environment fact, or next technical move is unknown. This does not decide what the objective means or replace architecture, Requirement, or authority decisions.

## When to Use

Use in Scout, Researcher, Planner, Oracle, Worker, or Verifier Executions for a specific local unknown inside a clear objective. Do not use it for a material Requirement or authority ambiguity, a competing architecture choice, or a Reviewer workaround. Reviewer is not allowlisted for this Skill in Phase 1.

## Inputs and Evidence

Read the immutable Agent Execution Request, objective, completion criteria, authority, permissions, Write Scope, Tool policy, selected Context/Artifacts, known facts, and available checks. State the boundary and attempt budget before exploring. Confirm that the unknown is not a Requirement interpretation or D2/D3 decision question.

## Procedure

1. State the clear objective, single local unknown, known facts, success criterion, repository or environment boundary, and bounded attempt budget.
2. Form the smallest plausible hypotheses and select the least-privilege permitted inspection, search, query, or check that can distinguish them. Do not add capability or broaden the boundary.
3. Execute one bounded probe at a time. Record its input, Tool or command, relevant output, source/ref, and time or basis. A source mutation is forbidden unless the invoking Agent's existing Write Scope explicitly authorizes that experiment; this Skill never grants it.
4. Compare the evidence with the success criterion, corroborate or reproduce the result when needed, and update or reject the hypothesis.
5. Repeat only while the evidence materially reduces uncertainty and the attempt budget remains. Keep the conclusion local to the original objective. Surface a residual Uncertainty candidate only when the unknown is material to the current objective/Requirement; otherwise record the evidence boundary or bounded assumption only when semantically useful.
6. Do not treat absent evidence, an unobserved caller, or a hypothetical external risk as a blocking Uncertainty without a concrete material tie, and do not convert every non-material unknown into a Requirement assumption.
7. Return the conclusion, rejected hypotheses, residual material uncertainty, and the next bounded action if one is authorized.

## Expected Output and Evidence

Return a concise diagnostic handoff in the normal `step-result-v1` fields containing:

- `summary` with the local conclusion or explicit unresolved unknown;
- hypothesis and probe records, including command/source refs and actual output status;
- `execution_checks` with `passed`, `failed`, `skipped`, or `unavailable` status;
- assumptions and residual `uncertainty_candidates` only when the residual unknown is material to the current objective/Requirement;
- `blocked` when required access, capability, or environment is unavailable, or `failed` when an attempted probe fails.

Do not claim resolution from an unexecuted or ambiguous probe and do not create an authoritative State ID.

## Constraints and Stopping / Escalation

Use only the Agent Request's authority, permissions, Tools, mode, and Write Scope. Do not ask the User, create Steps, mutate Workflow State or graph, choose a material design/Requirement/Decision, or widen scope. Stop when the unknown is answered, evidence conflicts, the probe is unsafe or unavailable, the attempt budget is exhausted, progress stops, or greater authority is needed. Return a material uncertainty or escalation reason instead of repeated guessing or unbounded exploration; do not promote non-material absence of evidence. Selected Skills do not chain into a new workflow.
