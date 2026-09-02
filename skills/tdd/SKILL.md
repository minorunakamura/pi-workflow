---
name: tdd
version: 1.0.0
description: Translate approved behavior into executable checks and use focused test-first feedback to guide scoped implementation.
dependencies: []
capabilities: []
preferred_artifacts:
  - analysis
  - implementation
requirements:
  - Acceptance Criteria or another approved observable behavior contract
  - Existing test commands and the invoking Agent Write Scope when applicable
---
# tdd

## Purpose and Responsibility

`Agent = who; Skill = how; Tool = mechanism.` This document supplies procedure only and does not change the invoking Agent's role.

Answer the primary question: **Which executable Test or Check drives and protects this behavior?** Turn an approved behavioral objective into observable cases, deterministic oracles, edge/error coverage, and regression protection. Choose how behavior is checked; do not choose architecture or perform Formal Verification.

## When to Use

Use in Planner and Worker Executions for new behavior, bug fixes, refactors, and other approved write work where observable behavior must be specified and protected. Planner defines verifiable Plan checks. Worker implements and runs authorized Tests and the smallest approved change. This Skill is not available to Verifier.

## Inputs and Evidence

Read the Requirement, Acceptance Criteria, constraints, bug reproduction or invariant, current Plan Unit, supplied `V-*` check refs when present, objective, Write Scope, permissions, Tool policy, existing evidence, and current project-native tests/commands. Establish the behavior contract and implementation boundary before editing.

## Procedure

1. Map every required behavior to an observable case with preconditions, input/action, expected result/state/side effect, and a deterministic pass/fail oracle. Cover the normal path plus relevant boundary, invalid/security, error, and regression cases; map each case to an Acceptance Criterion or constraint, or label it exploratory.
2. Inspect existing tests and project-native commands. Reuse sufficient coverage and record the smallest command or check for each case. Do not invent a framework or duplicate a sufficient check.
3. In a Planner Execution, return the test intent, test level, fixture or boundary, oracle, command, and expected outcome without mutating the repository.
4. In a Worker Execution, when practical, add or run the focused reproducing/failing check inside the approved Write Scope before changing source. Make the smallest approved source/test change, then rerun the focused check.
5. Run relevant existing regression checks permitted by the request. Record actual `passed`, `failed`, `skipped`, or `unavailable` status and command/output refs.
6. Compare the resulting change with the check matrix and Write Scope. Refactor only within approved scope when the checks support it. If a check exposes ambiguous requirements, unsafe design, or scope expansion, stop and surface it instead of weakening the check.

## Expected Output and Evidence

Return a check/test matrix with behavior, precondition/action, oracle, Acceptance Criterion or constraint traceability, test level, fixture/boundary, command, expected result, actual result, and limitation. Planner uses normal plan-support result/Artifact fields. Worker uses `execution_checks`, observations, implementation intent, and observable diff/scope evidence. Preserve failed, skipped, and unavailable states and never fabricate a `V-*` identity.

A Worker Test or Check is implementation feedback, not Formal Verification. Do not copy implementation details into a meaningless synthetic test.

## Constraints and Stopping / Escalation

Planner remains read-only. Worker changes only the approved Write Scope and must not perform Git write operations. Do not weaken, delete, or rewrite a Check merely to obtain a pass; do not claim success for skipped, unavailable, or failed required behavior. Do not widen authority, permissions, Tools, or Write Scope, create Steps, mutate Workflow State, contact the User, or make an off-plan D2/D3 choice. Stop with `blocked`, `failed`, or escalation when the oracle, environment, capability, authority, or scope is insufficient.
