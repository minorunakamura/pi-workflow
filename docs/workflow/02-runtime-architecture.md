# Runtime Architecture

## Purpose

This document defines runtime components, their responsibilities, dependency direction, the Control Plane loop, and the separation between domain rules, application orchestration, Ports, concrete Adapters, and Monitoring.

## Scope

Logical entity semantics are defined in `03-domain-model.md`. Execution rules are defined in `04-orchestration.md`. Physical TypeScript mapping is defined in `10-implementation-specification.md`.

## Architectural Principles

> **Invariant**
>
> Only the Orchestrator may commit authoritative Workflow State.

> **Invariant**
>
> `pi-subagents` is an Agent execution mechanism. It MUST NOT own the Workflow State Machine.

- **MUST:** Runtime dependencies follow Ports and Adapters / dependency inversion.
- **MUST NOT:** Domain logic import filesystem, Git, HTTP, SQLite, Pi, Ketch, or `pi-subagents` implementations.
- **MUST NOT:** Application services import concrete Adapters directly.
- **MUST NOT:** Concrete Adapters call back into the Orchestrator to mutate Workflow State.
- **MUST:** Monitoring depend only on read-side contracts/readers/evaluation and not on write-side runtime services.

## Pi Package Boundary

The Workflow Runtime is distributed as a Pi Package. Packaging is an integration/distribution concern and MUST NOT leak into Domain rules.

```text
Pi Package repository
├── package.json          ← Pi resource manifest
├── src/                  ← Runtime implementation
└── skills/               ← Pi Skill resources
          │
          │ install / local package reference
          ▼
Consuming repository
└── .pi/runs/             ← Run State / Artifacts / Events
```

- **MUST:** Pi-facing command registration enter through a thin package Extension entry point.
- **MUST NOT:** Application, Domain, Agent definitions, or Playbooks depend on `.pi/` source-layout conventions.
- **MUST NOT:** Package implementation modules be placed under `.pi/workflows/` merely to make Pi discover them.
- **MUST:** Skills be exposed as package resources and resolved through `SkillCatalog`, not hard-coded `.pi/agent/skills/` paths.
- **MAY:** A consuming repository contain `.pi/settings.json` for project-local Pi package configuration; that file is not package source.
- **MUST:** Authoritative Run data remain project-local under `.pi/runs/` as defined in `06-persistence-and-artifacts.md#run-store-layout`.

Physical package layout and manifest rules are defined in `10-implementation-specification.md#runtime-layout` and `10-implementation-specification.md#package-manifest`.

## Control Plane

The Main Session owns only compact control information:

- current Run status and revision;
- current/ready Step information;
- unresolved blocking Uncertainties, Decisions, and Gates;
- current Plan/Change/Verification/Review references;
- compact progress and user-approval interaction.

It SHOULD NOT perform normal `read`, `rg`, `find`, repository browsing, or full Agent transcript forwarding. Detailed work is delegated and persisted.

## Runtime Components

### Router

Initial request classification and initial Playbook selection. It MAY suggest or initiate a later Playbook switch through the Orchestrator but does not schedule Steps.

### Orchestrator

The central application/control authority. Responsibilities include:

- loading and validating current state;
- recovery and drift reconciliation coordination;
- Requirement updates and decision application;
- dynamic graph mutation;
- Gate reconciliation;
- dispatch preparation;
- Agent result validation/normalization;
- Artifact finalization coordination;
- authoritative State commit;
- Event emission;
- completion/failure/cancellation terminalization.

### Scheduler

A pure/pure-ish selector. Given structured state and policy, it returns one ready Step or an idle reason. It does not mutate state, dispatch Agents, ask the user, or interpret repository files.

### Context Builder

Builds a minimal correct Context Pack from authoritative state and finalized Artifact references. It selects context; it does not investigate the repository.

### Agent Runtime

Port used to execute one Agent Execution Request and return one Step Result. The Phase 1 concrete implementation is a Pi `pi-subagents` adapter.

### State Store

Commits the entire next logical Workflow State through immutable state snapshots plus the atomic `run.yaml` pointer. It does not contain orchestration decisions.

### Artifact Store

Stages, validates, redacts, and atomically finalizes semantic Artifacts. It does not update Workflow State by itself.

### Event Writer

Appends compact observability Events after state transitions. Events are not the state authority.

### Repository Adapter

Provides mechanical repository facts such as HEAD, branch, status, snapshots, diffs, and relevant-file fingerprints. It MUST NOT decide whether a semantic re-plan is required.

### Workspace Manager

Abstracts the repository workspace. Phase 1 uses the current tree; Phase 2 may use Git worktrees without changing the Orchestrator contract.

### User Interaction

Port for D3 approval and clarification. The adapter returns user input; the Orchestrator applies it to Decisions, Uncertainties, Requirements, and Gates.

## Context Layers

The runtime distinguishes three layers:

1. **Control Context** — compact Main Session orchestration state.
2. **Step Context** — only the data required by the current Agent/Step.
3. **Artifact Context** — detailed persisted evidence and results under the Run directory.

> **Invariant**
>
> Full conversation history is not a normal Context Builder input and is not required to resume a Run.

## Context Builder

Context selection priority:

```text
Current authoritative State / Requirement
  ↓
Resolved Decisions and constraints
  ↓
Current applicable Plan
  ↓
Current relevant Change Set / Verification / Review
  ↓
Required analysis or research Artifacts
  ↓
Supporting evidence
  ↓
Optional context
```

The Context Builder MUST exclude stale/superseded material from authoritative context and MUST fail with a structured context error if required context cannot fit without dropping authoritative information.

## Ports and Adapters

```text
Commands
   │
   ▼
Application / Control Plane
   │
   ├──────────────► Domain Rules
   │
   └──────────────► Ports
                       ▲
                       │ implements
                       │
                    Adapters
```

Typical Ports:

- `AgentRuntime`
- `StateStore`
- `RunReader`
- `ArtifactStore`
- `ArtifactReader`
- `EventWriter`
- `EventReader`
- `RepositoryAdapter`
- `RunLockManager`
- `WorkspaceManager`
- `UserInteraction`
- `SkillCatalog`
- `ModelCatalog`
- `Clock`

Reader and Writer interfaces SHOULD be separate so Monitoring can import read-side capabilities without write authority.

## Agent Runtime Boundary

Conceptual interface:

```ts
interface AgentRuntime {
  run(
    request: AgentExecutionRequestV1,
    signal: AbortSignal,
  ): Promise<StepResultV1>;
}
```

- **MUST:** One `run()` call represents one Agent Execution attempt.
- **MUST NOT:** The adapter modify authoritative state.
- **MUST NOT:** A native `workflowScript` implement the whole multi-Agent workflow.
- **MAY:** A `workflowScript` or equivalent Pi mechanism be used internally to implement the mechanics of a single Agent Execution.

## Repository and Workspace Boundary

```text
Orchestrator
   │
   ├─ WorkspaceManager → WorkspaceHandle
   │
   └─ RepositoryAdapter(workspace)
          ├─ HEAD / branch / status
          ├─ snapshots / diffs
          └─ fingerprints
```

Control-plane Git commands MUST go through the Repository Adapter. Repository semantic interpretation remains in Domain/Application services.

## User Interaction Boundary

```text
Agent
  ↓ structured Decision/Uncertainty request
Orchestrator
  ↓
UserInteraction Port
  ↓
User
  ↓ response
Orchestrator
  ↓
State transition
```

Agents MUST NOT directly invoke user-interaction tools.

## Runtime Control Loop

The canonical logical loop is:

```text
Load current Run
      ↓
Validate / migrate / recover
      ↓
Process pending user input or cancellation
      ↓
Reconcile derived applicability / freshness / Gates
      ↓
Process dynamic triggers
      ↓
Evaluate completion
      ↓
Scheduler selects ready Step
      ↓
Pre-dispatch checks
  repository drift / permission / model / context
      ↓
Persist running Execution intent
      ↓
AgentRuntime.run(...)
      ↓
Validate untrusted Agent result
      ↓
Repository postconditions / normalization
      ↓
Finalize required Artifacts
      ↓
Compute + validate next Workflow State
      ↓
StateStore.commit(...)
      ↓
Append Events
      ↓
Next iteration
```

The Agent executes outside the State Store transaction. At most one major state transition is processed per loop iteration in Phase 1.

## Prompt Assembly Boundary

Final Agent prompt:

```text
Agent Definition
+ Agent Execution Request
+ Resolved Context Pack
+ Selected Skill content
= Final Prompt
```

Prompt assembly MUST NOT perform repository discovery or silently add unrelated Artifact context.

## Monitoring Boundary

```text
Authoritative Run Store
       │ read only
       ▼
Monitoring Readers / Indexer / Evaluator
       │
       ▼
Derived SQLite Index
       │
       ▼
REST / SSE / Web UI
```

> **Invariant**
>
> Monitoring MUST NOT import or invoke State/Artifact/Event writer operations.

Monitoring-specific behavior is defined in `09-monitoring.md#read-only-boundary`.

## Dependency Direction

| From | Allowed dependencies |
|---|---|
| Domain | Domain primitives only |
| Contracts | primitive/schema utilities |
| Application | Domain, Contracts, Ports, static definitions |
| Ports | Domain/Contract types |
| Adapters | Ports, Contracts, low-level primitives |
| Playbooks | domain/definition contracts |
| Agent definitions | domain/definition contracts |
| Commands | bootstrap/application facade |
| Evaluation | read models/contracts |
| Monitoring | read ports/read adapters/evaluation/API DTOs |
| Bootstrap | application plus all concrete adapters |

### Forbidden dependency examples

- **MUST NOT:** `domain → application`
- **MUST NOT:** `domain → adapters`
- **MUST NOT:** `application → adapters`
- **MUST NOT:** `adapters → application`
- **MUST NOT:** `monitor → persistence/write`
- **MUST NOT:** `playbooks → adapters`
- **MUST NOT:** `agents → adapters`
- **MUST NOT:** runtime modules form circular imports.

## Composition Root

Concrete implementations are assembled in one bootstrap/composition layer. Manual constructor injection is preferred for Phase 1.

```text
load config
   ↓
validate Agent/Playbook registries
   ↓
create read/write stores
   ↓
create Repo/Workspace/Pi/User adapters
   ↓
create Domain/Application services
   ↓
create Orchestrator/use cases
```

A generic DI container or Service Locator is not required and SHOULD NOT be introduced in Phase 1.

## Architecture Tests

Phase 1 MUST include import/dependency tests that enforce the forbidden edges above, forbid domain Node IO dependencies, restrict `pi-subagents` imports to Pi adapter code, restrict control-plane Git process execution to the repository adapter, and verify zero circular dependencies.
