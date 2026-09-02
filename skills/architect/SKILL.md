---
name: architect
version: 1.0.0
description: Compare bounded compliant architecture options and provide authority-appropriate design support.
dependencies: []
capabilities: []
preferred_artifacts:
  - analysis
requirements:
  - Current authoritative requirements, constraints, decisions, and evidence
  - A structural architecture question with known authority
---
# architect

## Purpose and Responsibility

`Agent = who; Skill = how; Tool = mechanism.` This document supplies procedure only and does not change the invoking Agent's role.

Answer the primary question: **Which compliant architecture option satisfies the constraints?** Provide boundary, responsibility, interface/data-flow, option, trade-off, and recommendation support. Do not own the final D2/D3 decision, create a Plan, or implement the design.

## When to Use

Use in Planner or Oracle read-only Executions when the Requirement, constraints, Decisions, and relevant evidence are sufficiently understood but a structural choice is needed. Select it for boundary placement, dependency direction, competing architectures, or integration shape. Do not use it to explain existing rationale, diagnose a local failure, or replace a Plan.

## Inputs and Evidence

Read the current authoritative Requirement revision, constraints, relevant Decisions, objective/completion criteria, supplied behavior/impact evidence, Agent authority, permissions, Write Scope, and Tool policy. Reject stale or missing authoritative inputs rather than silently substituting them.

## Procedure

1. State the architecture question and confirm the authoritative inputs and their currentness.
2. Extract only the hard invariants and decision drivers relevant to the objective, including security/permission, compatibility, persistence, observability, testability, and dependency-direction constraints.
3. Define the minimum compliant boundary structure and control/data flow. Identify ownership of source mutation, Tools, User interaction, and Workflow State so these responsibilities cannot move into a Skill or Agent.
4. Produce at least one viable option and add alternatives only when they are materially distinct. For each option, compare constraint fit, coupling, cohesion, dependency direction, affected interfaces, operability, testability, migration cost, failure modes, and verification consequences.
5. Exclude options that violate hard constraints or authoritative Decisions. In Planner, translate only an authorized D0/D1 choice into a Plan-relevant boundary within the approved scope. In Oracle, keep every recommendation non-authoritative.
6. For a D2/D3 choice, conflicting evidence, or no safely compliant option, return bounded options, trade-offs, `decision_requests`, and uncertainty for Orchestrator routing; do not resolve the choice.
7. State assumptions, deviations, unresolved dependencies, and Acceptance Criterion coverage, then return decision support without creating a Plan, Step, or authoritative Decision.

## Expected Output and Evidence

Return decision-support content, normally an `analysis` Artifact when no existing Decision ref is supplied, containing:

- objective, authoritative constraints, and invariants;
- boundary and control/data-flow summary;
- a bounded option comparison with evidence and risks;
- recommendation status and concise rationale appropriate to the Agent authority;
- evidence refs, assumptions, deviations, unresolved dependencies, and Acceptance Criterion coverage;
- `decision_requests` or `uncertainty_candidates` for choices outside authority.

New Decision identities are candidates or scoped references only; the Orchestrator allocates and records authoritative identities.

## Constraints and Stopping / Escalation

Do not invent Requirements to justify a preferred architecture. Do not mutate source, State, graph, or Artifacts, create runtime Steps, contact the User, widen permissions, Tools, Write Scope, or authority, or act as an Orchestrator or Workflow Engine. Planner recommendations stay within D1 and approved Plan scope; Oracle recommendations never become D2/D3 authority. Stop and escalate when a hard constraint cannot be satisfied, authoritative inputs conflict, or the required choice exceeds the Agent authority.
