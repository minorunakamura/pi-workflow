# Workflow Overview

## Purpose

This specification defines a workflow orchestration runtime for the Pi coding agent that is developed and distributed as an installable **Pi Package**. The package exposes Pi extension entry points and Skills while each consuming repository keeps authoritative Run state and Artifacts project-locally. The runtime evolves the existing change workflow into an explicit state-driven engine that keeps the Pi Main Session small, delegates detailed work to subagents, persists durable handoff Artifacts, and supports deterministic recovery, verification, review, telemetry, and comparison.

## Scope

Phase 1 delivers a complete sequential workflow engine as one Pi Package with six Playbooks, seven Agents, nine packaged Skills, durable project-local Run state, recovery, repository safety, verification, review, telemetry, and a local Monitoring application.

Phase 2 adds parallel scheduling, `arena`, `swarm`, resource-conflict handling, and worktree isolation. Phase 3 adds Operational Skills and advanced operations/evaluation capabilities.

## Core Principles

> **Invariant**
>
> The Pi Main Session is the workflow **Control Plane**. It MUST NOT perform normal repository exploration or accumulate detailed Agent transcripts as its working context.

- **MUST:** Detailed repository investigation, planning, implementation, verification, and review are delegated to Agents.
- **MUST:** Persisted Workflow State plus finalized Artifacts are the durable source for handoff and resume.
- **MUST NOT:** Conversation history be the source of truth for a Run.
- **MUST:** `pi-subagents` is treated as an **Agent Execution Engine**, not as the Workflow Engine.
- **MUST NOT:** The entire workflow be implemented as one giant `workflowScript`.
- **MUST:** The Orchestrator remains the single logical writer of authoritative Workflow State.
- **MUST:** Worker completion alone is insufficient for Run completion; required Verification, Review, Gates, and Completion conditions must also pass.
- **MUST:** Monitoring is read-only and cannot become a second Control Plane.
- **MUST:** Package implementation source lives outside `.pi/`; Pi-facing resources are exposed through the package manifest.
- **MUST:** `.pi/runs/` in the consuming repository is runtime data, not the package source tree.

## Terminology

| Term | Meaning |
|---|---|
| Workflow Run | One persisted execution of a user request. |
| Playbook | Execution strategy defining the base Step graph, rules, policies, and invariants for a request class. |
| Step | Orchestration unit with an objective, inputs, outputs, dependencies, completion criteria, Agent, and lifecycle. |
| Agent | A subagent execution role that performs one Step. |
| Skill | Reusable specialist procedure describing *how* an Agent performs work. |
| Tool | Concrete mechanism used to inspect or change code/files or obtain external information. |
| Orchestrator | Main-session Control Plane that selects Playbooks, schedules Steps, dispatches Agents, resolves control decisions, mutates authoritative state, and handles Gates. |
| Gate | A semantic condition controlling Step dispatch or Run completion. |
| Artifact | Finalized semantic handoff/evidence record stored under the Run directory. |
| Execution | One attempt to execute a Step with a specific Agent request. |

Logical hierarchy:

```text
Workflow Run
  → Playbook
    → Step
      → Agent
        → Skills / Tools
```

The hierarchy is logical; not every layer must create a separate runtime object for every action.

## High-Level Architecture

```text
Pi Package
  ├─ Extension entry point / `/wf-*` commands
  ├─ Packaged Skills
  └─ Workflow Runtime
       │
       ▼
User / consuming repository
  │
  ▼
/wf-* command
  │
  ▼
Main Session / Orchestrator  ← Control Plane
  │
  ├─ Playbook / Scheduler
  ├─ Context Builder
  ├─ State / Gate / Recovery decisions
  │
  ▼
Agent Runtime (`pi-subagents` adapter)
  │
  ├─ Scout / Researcher / Planner / Oracle
  ├─ Worker / Verifier / Reviewer
  └─ Skills / Tools
  │
  ▼
<consumer-repository>/.pi/runs/<run-id>/
  ├─ Current State
  ├─ Immutable Artifacts
  └─ Append-only Events
  │
  ▼
Read-only Monitoring / Evaluation
```

## Seven Agents

| Agent | Primary responsibility |
|---|---|
| Scout | Read-only repository understanding and evidence collection using `how`, `why`, and `blast-radius`. |
| Researcher | Read-only external or missing knowledge acquisition with source/evidence requirements. |
| Planner | Produces an executable, verifiable Plan within D0/D1 authority. |
| Oracle | Provides options, trade-offs, risks, and recommendation for high-uncertainty or high-impact decisions. |
| Worker | Applies approved source changes within Write Scope. |
| Verifier | Performs formal verification and records evidence; does not fix source. |
| Reviewer | Independently evaluates implementation/evidence and creates or rechecks Findings; does not fix source. |

Detailed Agent contracts are defined in `05-agents-and-skills.md#agent-definitions`.

## Decision Authority

| Class | Meaning | Authority |
|---|---|---|
| `D0` | Local operational choice | Agent may resolve within its contract. |
| `D1` | Plan-bounded implementation choice | Agent may resolve within the approved Plan and constraints; material choices are recorded when useful. |
| `D2` | Design decision | Orchestrator decides, usually with Planner/Oracle evidence. |
| `D3` | Explicit approval/user decision | User decision through the Orchestrator. |

Agents MUST NOT contact the user directly. The control path is always:

```text
Agent → Orchestrator → User
```

## Six Playbooks

| Playbook | Primary flow |
|---|---|
| Feature | Scout → Planner → Worker → Verifier → Reviewer |
| Bug | Scout understand/reproduce/root-cause → Planner → Worker → Verifier → Reviewer |
| Hotfix | Rapid Scout/root-cause → minimal Planner → Worker → critical Verifier → Reviewer |
| Chore | Scout → Planner → Worker → Verifier → policy-based Reviewer |
| Refactor | Scout structure/invariants/blast-radius → Planner → Worker → preservation Verifier → Reviewer |
| Investigation | Scout/investigate/synthesize → Reviewer; normally no Worker or Verifier |

Researcher and Oracle are conditional. Dynamic Steps may be inserted at runtime for research, decisions, re-planning, fixes, re-verification, re-review, or recovery.

The authoritative Playbook rules are defined in `04-orchestration.md#playbooks`.

## Phase 1 Scope

Phase 1 MUST include:

- an installable Pi Package manifest exposing the workflow Extension entry point and nine Core Skills;
- six `/wf-*` start commands plus `/wf-status`, `/wf-resume`, `/wf-cancel`;
- seven Agents;
- nine Core Skills;
- sequential DAG-compatible Scheduler;
- dynamic Steps and Gates;
- state snapshots, Artifacts, Event log, schema validation, migration hooks;
- repository drift and dirty-tree protection;
- Change Set, Verification Run, Review Run, Finding, and Outcome contracts;
- blocked/resumable failure/cancellation/recovery semantics;
- telemetry, deterministic metrics aggregation, evaluation, and two-Run comparison;
- read-only local Monitoring application.

## Phase 2 and Phase 3

### Phase 2

- parallel ready-Step scheduling;
- resource conflict detection;
- `arena` and `swarm` orchestration strategies;
- worktree isolation;
- parallel execution aggregation.

### Phase 3

- Operational Skills;
- advanced operational automation;
- richer monitoring/evaluation and long-term workflow optimization.

> **Invariant**
>
> Parallelism MUST NOT be introduced before the sequential Phase 1 runtime, recovery behavior, repository attribution, and evaluation baseline are stable.

## Non-goals

Phase 1 does not include:

- a general plugin framework;
- an internal event-bus architecture;
- remote/multi-repository Monitoring;
- automatic workflow winner selection or a single 0–100 workflow score;
- automatic Git commit/push/merge/rebase operations;
- reconstruction of Workflow State from Events;
- migration of legacy chat/session transcripts into the new State model.

## Documentation Map

The authoritative document for each subsystem is listed in `README.md#source-of-truth-matrix`.
