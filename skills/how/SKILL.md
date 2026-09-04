---
name: how
version: 1.0.0
description: Trace current repository behavior and explain its control, data, configuration, and error flows from evidence.
dependencies: []
capabilities: []
preferred_artifacts:
  - analysis
requirements:
  - A bounded behavior question and inspection boundary
  - Evidence-backed facts separated from inference and assumptions
---
# how

## Purpose and Responsibility

`Agent = who; Skill = how; Tool = mechanism.` This document supplies procedure only and does not change the invoking Agent's role.

Answer the primary question: **How does the current mechanism behave?** Describe the actual entry point, control flow, data flow, relevant branches, boundaries, outputs, and observable side effects. Explain what the repository does; do not explain why it was chosen or design a replacement.

## When to Use

Use for a bounded behavior question or behavior uncertainty, normally in a Scout read-only Execution. It is suitable for tracing an existing execution path, locating contract enforcement, or explaining current success and error behavior. Do not use it as a substitute for `why`, `blast-radius`, `architect`, or `interrogate`.

## Inputs and Evidence

Start with the immutable Agent Execution Request: objective, completion criteria, authority, permissions, Write Scope, Tool policy, and output contract. Use only the selected Context/Artifact refs, current repository evidence, and permitted Tools. Treat documentation as intended behavior unless implementation or an allowed check corroborates it.

## Procedure

1. Restate the behavior question and bound the subject, entry and exit conditions, relevant repository area, and required handoff.
2. Use structural/search-first inspection to locate entry points, callers, callees, configuration, contracts, tests, and relevant State or Artifact references.
3. Trace the normal path and the relevant error or edge branches through observable outputs. Record control flow, data flow, State/Artifact interaction, Tool boundaries, and permission boundaries that are actually observed.
4. Corroborate the trace with implementation, tests, permitted commands, and authoritative context. Record each material claim with a source or command reference.
5. Separate `Fact`, `Inference`, and `Assumption`. Compare observed behavior with the completion criteria and list gaps or contradictory observations without resolving them by guesswork. Admit an Uncertainty candidate only when the gap is relevant to the current Requirement/Run and a different answer could materially change correctness, requested behavior, scope, architecture/authority, verification, security/safety, concrete compatibility, completion eligibility, or required authority.
6. Treat a missing convention, caller, CI, or external contract as an observation/evidence boundary rather than a blocking Uncertainty unless concrete evidence or the current Requirement makes its impact material. A required current-Requirement behavior or verification check unavailable to this Execution is material and should be surfaced for later authorized evidence. Use a bounded local choice/assumption only when that is semantically appropriate; do not create a Requirement assumption merely to avoid a candidate.
7. Describe the bounded end-to-end behavior map, including the branches needed to answer the objective.
8. Stop once the behavior map is supported or a missing or contradictory basis must be surfaced.

## Expected Output and Evidence

Return the normal `step-result-v1` handoff, normally an `analysis` Artifact with purpose `how`, containing:

- a `## Handoff Summary`;
- a concise behavior map from entry to observable exit;
- source, Artifact, and relevant command/test refs;
- factual observations, with `Fact`/`Inference`/`Assumption` labels where useful;
- scope limitations and `uncertainty_candidates` only for unresolved behavior gaps, contradictions, or missing access that are material to the current Requirement/Run; omit non-material unknowns or record them as observations when useful.

Do not return an implementation Plan, architecture decision, or design recommendation. Use `blocked` when required evidence or capability is unavailable.

## Constraints and Stopping / Escalation

Remain read-only. Do not mutate source, State, graph, or Artifacts, create runtime Steps, select a Decision, contact the User, or widen authority, permissions, Write Scope, or Tool access. Do not infer historical rationale; that belongs to `why`. Stop and surface a material behavior Uncertainty or a `blocked` result when the entry point, relevant branch, current evidence, or required Tool is unavailable, or when evidence conflicts materially; do not promote absence of evidence alone. Selected Skills are procedures in this Execution and must not call one another or create an implicit workflow.
