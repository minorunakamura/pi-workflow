---
name: why
version: 1.0.0
description: Investigate evidence-backed rationale for current implementations, constraints, compatibility paths, and design choices.
dependencies: []
capabilities: []
preferred_artifacts:
  - analysis
requirements:
  - A specific choice or constraint whose rationale is in question
  - Current or permitted historical evidence with provenance
---
# why

## Purpose and Responsibility

`Agent = who; Skill = how; Tool = mechanism.` This document supplies procedure only and does not change the invoking Agent's role.

Answer the primary question: **Why does this current implementation or constraint exist?** Explain causal drivers and supported trade-offs for an implementation, compatibility path, guard, or design choice. Describe rationale, not the mechanics themselves and not a new design.

## When to Use

Use for an unresolved rationale question in a Scout read-only Execution. The question must identify the exact choice or constraint and its relevant time or version basis. Do not use `why` to infer author intent from code alone, decide what should be built, or map downstream impact.

## Inputs and Evidence

Begin with the immutable Agent Execution Request and the selected Requirements, constraints, Decisions, Context, and Artifacts. Use current code, documentation, comments, tests, and—only when the Agent Request permits it—Git history, blame, and commit context. Record each source, its revision or time basis, and whether it is direct or indirect evidence.

## Procedure

1. State the exact choice or constraint and the time or version basis of the rationale question.
2. Gather relevant Requirement, constraint, Decision, documentation, comment, test, implementation, and permitted Git evidence.
3. For each candidate rationale, connect the choice to supporting evidence and label it as `Fact`, `Inference`, or `Assumption`. Include a trade-off only when evidence supports it.
4. Check each candidate against current behavior and available historical evidence. Look for stale, contradicting, or missing rationale evidence.
5. Synthesize the strongest supported explanation, confidence, limits, and any material question requiring Orchestrator, Oracle, or User authority.
6. Return the rationale handoff without converting it into a requirement, implementation recommendation, or authoritative Decision.

## Expected Output and Evidence

Return the normal `step-result-v1` handoff, normally an `analysis` Artifact with purpose `why`, containing:

- a concise evidence-backed rationale and confidence/limits;
- cited local refs, permitted history refs, and command/test results;
- supported constraints or trade-offs;
- explicit `Fact`/`Inference`/`Assumption` labels;
- `uncertainty_candidates` for unresolved or conflicting evidence;
- `decision_requests` only when a material unresolved choice needs routing, never as a resolved Decision.

If no causal evidence was found, say so explicitly and preserve the result as `unknown` or uncertain.

## Constraints and Stopping / Escalation

Do not invent author intent, treat a historical commit message as current authority, or turn a plausible explanation into a requirement. Do not mutate source, State, graph, or Artifacts, create Steps, contact the User, resolve D2/D3, or widen permissions, Tools, Write Scope, or authority. Stop when causal evidence is absent or materially conflicting and return the residual Uncertainty or required escalation instead of selecting a convenient rationale. This procedure must not call another Skill or create an implicit workflow.
