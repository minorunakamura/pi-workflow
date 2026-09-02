---
name: reflect
version: 1.0.0
description: Perform a bounded pre-submission check that an Agent result answers its objective and obeys its execution contract.
dependencies: []
capabilities: []
preferred_artifacts:
  - analysis
requirements:
  - The pending Agent result and its Execution objective/output contract
  - Evidence, authority, permission, and scope information for consistency checks
---
# reflect

## Purpose and Responsibility

`Agent = who; Skill = how; Tool = mechanism.` This document supplies procedure only and does not change the invoking Agent's role.

Answer the primary question: **Is this Result ready to submit and contract-compliant?** Perform the Agent's final bounded completeness and compliance check. This is not independent Verification, Review, redesign, or a second Execution.

## When to Use

Use before submitting any Agent result, especially a claimed completion, blocked result, failure, Artifact handoff, Decision request, or Finding candidate. It is allowlisted for every Phase 1 Agent and may be selected alone or with other Skills; selection does not create a runtime Step.

## Inputs and Evidence

Re-read the immutable Agent Execution Request, objective, completion criteria, output contract, selected Context/Artifact refs, mode, authority, permissions, Write Scope, Tool policy, Agent Definition, and the current draft result. Use only the evidence and checks already available, plus the smallest permitted consistency check needed to resolve an output omission.

## Procedure

1. Confirm the Step objective, completion criteria, expected outputs, mode, authority, permissions, Write Scope, constraints, and permitted Tools.
2. Check result identity and role consistency, required summary and Artifact refs, stable result arrays, candidate/reference shape, and outcome-specific `blocked` or `failure` details. Ensure no authoritative State IDs were fabricated.
3. Check every material conclusion against current cited Evidence. Label `Fact`, `Inference`, `Assumption`, and `Recommendation` appropriately, and verify Acceptance Criterion, constraint, and Check coverage.
4. Check actual Tool use, source mutation, Artifact claims, User-interaction attempts, and decision scope against the Agent Request. Confirm that no Skill created a Step, changed Workflow State, or widened authority, permissions, Tools, or Write Scope.
5. Run only the smallest permitted consistency check needed to correct an omission. Do not substitute this for Formal Verification or independent Review.
6. Correct response-format omissions or retract/downgrade unsupported claims when the correction is within Agent authority. If the contract remains unmet, return the precise blocker, failure, escalation, deviation, or uncertainty instead of claiming completion.
7. Submit only the concise external result and checklist outcome through the Orchestrator. Do not emit or persist private chain-of-thought.

## Expected Output and Evidence

Return a compact reflection checklist in `observations` or `execution_checks` showing:

- objective and output-contract coverage;
- material claim-to-Evidence coverage and currentness;
- authority, permission, Tool, and Write Scope compliance;
- outcome-specific field completeness;
- remaining omissions, contradictions, blockers, uncertainty, or limitations.

Preserve normal `step-result-v1` fields and structured blocker/failure details. This checklist is evidence of preflight, not proof that implementation is correct or that a gate has passed.

## Constraints and Stopping / Escalation

Do not independently redesign, verify, review, ask the User, mutate source, State, or graph, allocate authoritative IDs, create Steps, or override the Agent Definition/Execution Request. Do not hide a missing Artifact, failed Check, unresolved Uncertainty, or authority violation. Stop before submission with `blocked` or `failed` and partial evidence when the result cannot satisfy the contract. Stop checking when another self-check would not materially improve correctness; do not start additional research or an implicit Skill workflow.
