---
name: blast-radius
version: 1.0.0
description: Bound the direct, indirect, and uncertain impact of current behavior, proposed changes, or repository mutations with evidence.
dependencies: []
capabilities: []
preferred_artifacts:
  - analysis
requirements:
  - A supplied or discoverable subject and impact basis or baseline
  - Evidence for affected boundaries and confidence
---
# blast-radius

## Purpose and Responsibility

`Agent = who; Skill = how; Tool = mechanism.` This document supplies procedure only and does not change the invoking Agent's role.

Answer the primary question: **What could this behavior or change affect?** Map direct and indirect code paths, contracts, Acceptance Criteria, State/Artifact/Event flows, verification/review scope, and safety boundaries. This is impact analysis, not architecture selection or implementation.

## When to Use

Use when a Scout or Reviewer must bound consequences, assess affected areas, identify regression exposure, or determine whether evidence covers a subject. The subject and basis may be a Requirement, Plan, Change Set, repository snapshot, or investigation evidence. Do not use it to choose a design or to expand scope merely because references exist.

## Inputs and Evidence

Read the immutable Agent Execution Request, objective, completion criteria, authority, permissions, Write Scope, selected Context/Artifacts, and the supplied subject/baseline. Inspect current repository state, actual diff when available, contracts, configuration, persistence, security, operational, and verification boundaries relevant to that subject.

## Procedure

1. Identify the subject, comparison or baseline, repository or Plan revision, and exact impact question. Use a supplied proposal as-is when the basis is a proposed change.
2. Enumerate direct references and immediate consumers, then follow only relevant callers/dependents and configuration, data/State, Artifact/Event, persistence, Tool, permission, and user-interaction edges.
3. Compare the actual current diff or snapshot with the stated scope. Record both affected areas and inspected-but-not-affected areas; touched files are not the impact boundary by themselves.
4. Classify each impact as `direct`, `indirect`, or `unknown`, and record the affected contract or behavior, confidence, and evidence. Check relevant correctness, security, compatibility, operational, and verification/review consequences without inventing risks. Surface an impact Uncertainty only when a different answer could materially change the current Requirement/Run and concrete repository/supplied evidence or an explicit compatibility requirement ties the unknown to that impact.
5. Treat a repository search finding no caller, CI integration, convention, or external contract as an absence-of-evidence observation, not proof of absence and not a blocker by itself. Do not promote a hypothetical external consumer into an Uncertainty without that material tie.
6. Map material impacts to Acceptance Criteria and constraints. List the smallest checks or additional evidence needed to confirm them.
7. Return the bounded impact handoff with scope limits and residual impact uncertainty. Stop when further transitive expansion is speculative.

## Expected Output and Evidence

Return the normal `step-result-v1` handoff, normally an `analysis` Artifact with purpose `blast-radius`, containing:

- subject, basis, baseline, and impact question;
- an impact map with direct/indirect/unknown classification, confidence, and evidence refs;
- affected and inspected-but-not-affected areas;
- traceability to relevant Acceptance Criteria and constraints;
- risks only where evidence supports them and the smallest required checks;
- `observations` for established impacts and `uncertainty_candidates` only for unknown reach or incomplete dependency evidence that is material to the current Requirement/Run; hypothetical reach remains a scoped limitation.

When used by a Reviewer, include evidence sufficient for any `finding_candidates`, but do not allocate a Finding identity or choose disposition.

## Constraints and Stopping / Escalation

Remain read-only and independent of implementation and design authority. Do not treat a text-reference count as semantic impact, silently broaden scope, mutate source, State, graph, or Artifacts, create recovery Steps, resolve uncertainty with `figure-it-out`, contact the User, or widen authority, permissions, Write Scope, or Tools. Stop and escalate when the subject or baseline is ambiguous, a critical boundary cannot be inspected, or impact remains materially unknown with a concrete current-Requirement tie. `figure-it-out` is unavailable to Reviewer in Phase 1; surface the material uncertainty instead.
