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

- **MUST:** Stable array fields be present even when empty.
- **MUST:** A `failed` outcome contain structured failure information.
- **MUST:** A `blocked` outcome identify the blocking reason/ref.
- **MUST NOT:** Agent candidates use authoritative `U-*`, `D-*`, `F-*`, or other State IDs; the Orchestrator allocates them.
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
- **MUST NOT:** Produce the final implementation design, final Plan, or source change.
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

## Core Skills

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
