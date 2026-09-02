---
name: show-me-your-work
version: 1.0.0
description: Connect material Agent claims to current, reproducible, independently inspectable evidence.
dependencies: []
capabilities: []
preferred_artifacts:
  - implementation
  - verification
  - review
requirements:
  - Material claims, required outputs, Acceptance Criteria, or Checks to support
  - Permitted repository, command, test, Artifact, or source evidence
---
# show-me-your-work

## Purpose and Responsibility

`Agent = who; Skill = how; Tool = mechanism.` This document supplies procedure only and does not change the invoking Agent's role.

Answer the primary question: **What Evidence supports each material claim or result?** Make implementation, Verification, Review, and investigation outputs traceable and reproducible. Capture proof of what was observed or executed; do not own semantic acceptance or final disposition.

## When to Use

Use in Worker, Verifier, and Reviewer Executions when implementation, verification, review, or investigation claims need support. Worker evidence covers authorized changes and checks. Verifier evidence covers supplied Formal Verification Checks. Reviewer evidence independently supports Review or Finding candidates.

## Inputs and Evidence

Read the immutable Agent Execution Request, role contract, objective, completion criteria, expected outputs, relevant Acceptance Criteria/constraints/Checks, selected Context/Artifacts, authority, permissions, Write Scope, and Tool policy. Use repository diff/state, source locations, command results, test output, Artifact refs, and permitted external sources. Raw Tool output is evidence input, not automatically a normalized fact.

## Procedure

1. Enumerate the claims, required outputs, Acceptance Criteria, constraints, and completion criteria. Identify the minimum evidence needed for each claim.
2. Obtain or inspect the strongest permitted evidence for each claim. Record subject, basis/revision, provenance, expected result, and actual result.
3. Execute or inspect relevant permitted Checks. Preserve `passed`, `failed`, `skipped`, and `unavailable` distinctions and record concise output refs and limitations.
4. Check that evidence is current, relevant, non-contradictory, and not superseded. Map every claim to its evidence and to the Acceptance Criterion, constraint, or Check it supports.
5. Prepare the role-appropriate handoff or Artifact candidate. Worker reports authorized implementation intent plus diff/scope evidence; Verifier reports Verification Run evidence; Reviewer reports independent Review Run/Finding evidence. The runtime assigns authoritative IDs.
6. Before submission, state residual uncertainty, missing evidence, and the limitation that prevents a complete claim. Never call a required failed or unavailable Check passed.

## Expected Output and Evidence

Return an evidence ledger or equivalent `## Handoff Summary` with:

- claim-to-Evidence mappings and source/Artifact/command refs;
- basis, revision, provenance, expected versus actual result, and currentness;
- `execution_checks`, `observations`, and concise rationale;
- role-appropriate Artifact or Finding candidate fields only when the Agent contract allows them;
- limitations and residual `uncertainty_candidates`.

Evidence must be redactable and independently inspectable. Do not request, emit, or persist private chain-of-thought or unnecessary full logs.

## Constraints and Stopping / Escalation

Verifier and Reviewer must not mutate source. Worker remains inside Write Scope and must not perform Git write operations. Do not use self-assertion, stale Artifacts, or unrecorded Tool results as proof; do not resolve Findings, Decisions, or User choices. Do not create Steps, mutate Workflow State or graph, contact the User, or widen authority, permissions, Tools, or Write Scope. Stop with `blocked`, `failed`, or an explicitly partial handoff when required evidence cannot be captured, provenance is ambiguous, or permissions prevent inspection.
