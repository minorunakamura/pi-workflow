# Implementation Specification

## Purpose

This document maps the design specification into a Phase 1 TypeScript implementation: module layout, Ports, Adapters, application/domain services, configuration, validation, testing, and implementation milestones.

> **Invariant**
>
> This document maps the design; it MUST NOT weaken or redefine contracts owned by `01` through `09`.

## Scope

Phase 1 is one installable **Pi Package** and one TypeScript project with explicit module boundaries rather than a monorepo of internal packages. Architecture tests enforce dependency direction.

## Runtime Layout

Recommended package-development layout:

```text
pi-workflow/
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── oxlint.json
├── biome.json
│
├── src/
│   ├── extensions/
│   │   ├── workflow.ts          ← Pi Package Extension entry point
│   │   └── commands/            ← thin command registration/helpers
│   ├── domain/
│   ├── contracts/
│   ├── application/
│   ├── ports/
│   ├── adapters/
│   ├── agents/
│   ├── playbooks/
│   ├── telemetry/
│   ├── evaluation/
│   ├── read-model/
│   ├── bootstrap/
│   └── monitor/
│       ├── backend/
│       ├── indexer/
│       └── frontend/
│
├── skills/
│   ├── how/SKILL.md
│   ├── why/SKILL.md
│   ├── blast-radius/SKILL.md
│   ├── architect/SKILL.md
│   ├── tdd/SKILL.md
│   ├── interrogate/SKILL.md
│   ├── figure-it-out/SKILL.md
│   ├── show-me-your-work/SKILL.md
│   └── reflect/SKILL.md
│
├── docs/workflow/
├── tests/
└── scripts/
```

> **Invariant**
>
> `.pi/` is not the package implementation source root. Runtime TypeScript belongs under `src/`, and Pi Skill resources belong under `skills/`.

A `.pi/` directory MAY appear while developing the package for local Pi project settings or generated Run data, but those files are development/runtime state rather than distributable source modules.

## Package Manifest

The package MUST declare the resources that Pi loads from the package root. The recommended manifest is:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/extensions/workflow.ts"],
    "skills": ["./skills"]
  }
}
```

The resource paths are package-root-relative. Using one explicit Extension entry point prevents helper modules under `src/extensions/` from accidentally becoming independent Pi Extension entry points.

- **MUST:** `src/extensions/workflow.ts` remain a thin Pi integration layer that registers `/wf-*` commands and delegates to `src/bootstrap/` / Application use cases.
- **MUST NOT:** Multi-Agent orchestration logic live in the Extension registration file.
- **MUST:** All nine Core Skills be included under the package's declared Skill resources.
- **SHOULD:** `package.json` include the `pi-package` keyword for package discoverability.
- **MUST NOT:** Installation require copying authored Skill/runtime source into `.pi/agent/skills/` or `.pi/workflows/`.
- **MAY:** Phase 1 distribute the Pi Extension as TypeScript source directly; a `dist/` build directory is not an architectural requirement. If a later build step changes the distributed entry path, the `pi` manifest and package-install tests MUST be updated together.

### Package Dependencies

- **MUST:** Third-party runtime libraries required by the installed package be declared in `dependencies`.
- **MUST:** Pi core packages imported by Extension/Skill implementation be declared in `peerDependencies` with the Pi-supported `"*"` range and not bundled as duplicate core runtimes. The current Pi core set includes `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`; only packages actually imported need to be declared.
- **MUST:** Development-only tooling such as TypeScript, linter, formatter, and test framework remain in `devDependencies`.
- **SHOULD:** `packageManager` pin the pnpm version used to develop the repository.
- **MUST:** Any dependency on another Pi Package follow Pi Package dependency/bundling rules; the Workflow Runtime MUST NOT assume separately installed Pi Packages share a module root.

### Local Package Development

During development, the repository SHOULD be consumed by Pi as a local-path package instead of copying files into Pi discovery directories. A project-local Pi install may create/use `.pi/settings.json`; that file is only local package configuration. For example, `pi install -l .` can register the current package locally when that matches the development setup.

The development loop is:

```text
pnpm check
   ↓
Pi loads the repository as a local package
   ↓
/wf-* integration smoke test
```

Package-install smoke tests belong to Pi Adapter integration/hardening, not Domain tests.

## Domain Modules

Recommended logical tree:

```text
src/domain/
├── primitives/
├── graph/
├── scheduling/
├── requirements/
├── uncertainty/
├── decisions/
├── gates/
├── findings/
├── freshness/
├── completion/
└── validation/
```

Domain modules MUST remain IO-free and deterministic where practical.

Representative services:

| Service | Responsibility |
|---|---|
| Graph validator/mutator rules | DAG/reference/invariant validation |
| Scheduler | deterministic ready-Step selection |
| Requirement impact classifier | classify refinement/amendment effects |
| Gate evaluators | evaluate semantic conditions |
| Applicability/Freshness evaluator | Plan/CS/VR/RR derived currentness |
| CompletionEvaluator | side-effect-free completion blocker computation |
| Reference validator | typed ID/reference integrity |

## Contracts

Recommended:

```text
src/contracts/
├── execution/
├── state/
├── artifacts/
└── events/
```

Contracts contain versioned shapes/runtime schemas and minimal schema utilities, not orchestration behavior.

Important contracts:

```text
AgentExecutionRequestV1
StepResultV1
RunYamlV1
RequirementSnapshotV1
StepsSnapshotV1
UncertaintiesSnapshotV1
DecisionsSnapshotV1
GatesSnapshotV1
FindingsSnapshotV1
SnapshotManifestV1
ArtifactFrontMatterV1
EventEnvelopeV1 / DomainEvent union
EffectiveConfigV1
```

Persisted/Agent boundaries MUST use runtime schema validation rather than TypeScript static types alone.

## Domain vs Persistence DTO

Serialized DTOs SHOULD map to logical domain state rather than becoming the mutable domain model directly. This keeps migrations/physical file layout out of domain rules.

```text
serialized DTO
   ↓ mapper/validator
logical WorkflowState
   ↓
Domain/Application rules
```

## Application Modules

Recommended:

```text
src/application/
├── orchestrator/
├── use-cases/
├── context/
├── execution/
├── normalization/
└── recovery/
```

### Orchestrator

Implements the state-driven control loop from `02-runtime-architecture.md#runtime-control-loop`. It delegates scheduling/freshness/completion to domain services and IO to Ports.

### Use Cases

```text
start-workflow
resume-workflow
cancel-workflow
get-workflow-status
```

`/wf-*` commands are thin wrappers around these use cases.

### Context Builder

Selects requirement/decision/plan/artifact references, performs context classification/budgeting, and returns Context Pack + Manifest. It does not search the repository.

### Result Normalization

Conceptual pipeline:

```text
parse / schema
  ↓
identity validation
  ↓
role validation
  ↓
reference validation
  ↓
permission/repository postconditions
  ↓
normalize candidates / allocate IDs
  ↓
finalize Plan/CS/VR/RR/etc. Artifacts
  ↓
next State transition
```

Dedicated finalizers SHOULD exist for Change Set, Verification Run, and Review Run because they merge Agent semantic results with runtime facts.

## Ports

Representative conceptual interfaces:

```ts
interface AgentRuntime {
  run(
    request: AgentExecutionRequestV1,
    signal: AbortSignal,
  ): Promise<StepResultV1>;
}

interface StateStore {
  load(runId: RunId): Promise<WorkflowState>;
  commit(input: {
    expectedRevision: number;
    next: WorkflowState;
    events: DomainEventDraft[];
  }): Promise<WorkflowState>;
}

interface RunReader {
  load(runId: RunId): Promise<WorkflowState>;
}

interface ArtifactStore {
  stage(draft: ArtifactDraft): Promise<StagedArtifact>;
  finalize(
    staged: StagedArtifact,
    destination: RunRelativeArtifactPath,
  ): Promise<ArtifactRef>;
}

interface ArtifactReader {
  read(ref: ArtifactRef): Promise<ArtifactContent>;
}

interface EventWriter {
  append(event: DomainEventDraft): Promise<DomainEvent>;
  appendBatch(events: DomainEventDraft[]): Promise<DomainEvent[]>;
}

interface EventReader {
  readAfter(runId: RunId, sequence: number): Promise<DomainEvent[]>;
}

interface RepositoryAdapter {
  getRoot(): Promise<string>;
  getHead(): Promise<string>;
  getBranch(): Promise<string | null>;
  captureSnapshot(scope?: RepositoryScope): Promise<RepositorySnapshot>;
  diff(before: RepositorySnapshot, after: RepositorySnapshot): Promise<RepositoryDiff>;
}

interface WorkspaceManager {
  acquire(runId: RunId): Promise<WorkspaceHandle>;
}

interface UserInteraction {
  ask(request: UserInteractionRequest): Promise<UserInteractionResult>;
}
```

These are representative signatures; exact method decomposition is an implementation choice so long as contract boundaries remain intact.

## Adapters

Recommended tree:

```text
src/adapters/
├── pi/
├── persistence/
│   ├── read/
│   └── write/
├── repository/
└── tools/
    ├── ketch/
    └── codegraph/
```

### PiSubagentsAdapter

Implements one `AgentRuntime.run()` call. `pi-subagents` imports SHOULD be restricted to this adapter area.

A giant multi-Agent workflow script is forbidden. Any native Pi workflow mechanism is internal to one Execution only.

### Persistence Read Adapters

```text
FileRunReader
FileArtifactReader
JsonlEventReader
```

### Persistence Write Adapters

```text
FileStateStore
FileArtifactStore
JsonlEventWriter
FileRunLockManager
```

Monitoring imports read-side adapters only.

### Repository Adapter

Git process invocation for Control Plane repository facts is isolated here.

### Tool Adapters

Ketch and CodeGraph are concrete mechanisms bound to Tool capabilities. They do not update Workflow State.

## Workspace Manager

Phase 1 implementation:

```text
CurrentTreeWorkspaceManager
```

Phase 2 may add:

```text
GitWorktreeWorkspaceManager
```

without redesigning the Orchestrator.

## Prompt Assembler

Dedicated service accepts resolved inputs only:

```text
Agent Definition
Execution Request
Context Pack
Skill content
```

It returns final prompt content/fingerprint and does not perform repository discovery.

## Skill Catalog

Responsibilities:

- discover project-local Skill metadata/content;
- resolve versions and dependencies;
- validate Agent allowlist;
- load only selected Skills;
- reject missing required Skills/dependency cycles.

No separate Skill Router Agent is required.

## Model Resolver

Deterministic model resolution uses effective config + Agent policy + runtime availability. It records requested/actual model and only uses configured fallbacks.

Provider discovery is behind `ModelCatalog`; the resolver itself SHOULD remain policy-focused.

## User Interaction Adapter

Phase 1 Pi implementation uses the project-provided `ask_user_question` mechanism through a `UserInteraction` adapter. The adapter returns answers/cancellation; it never mutates Decisions/Requirements directly.

## Configuration

Precedence:

```text
Built-in < Project < Playbook < Run Override
```

An optional consuming-repository Workflow config is expected at:

```text
<consumer-repository>/.pi/workflows/config.ts
```

This file is a project override loaded by the installed package; it is not part of the package source layout.

Effective configuration covers runtime limits, Agent/model policy, permissions, telemetry, and monitoring.

Hard invariants are not configurable.

Unknown configuration keys SHOULD fail validation instead of being silently ignored.

A Run persists its effective config snapshot and resumes against that snapshot; current project defaults do not silently rewrite an existing Run.

Representative finite limits:

```text
max_dynamic_steps
retry limits
uncertainty resolution attempts
fix cycles
model/tool timeouts
artifact soft/hard size
```

## Error Handling

Expected domain outcomes use typed result values rather than exceptions. Exceptions are reserved primarily for programming/infrastructure faults.

Adapters normalize infrastructure errors into structured Workflow `ERR-*` records at the Application boundary. Domain evaluators return waiting/blocked/failed conditions without throwing normal control-flow exceptions.

## Runtime Schema Validation

Validation is required at:

- configuration load;
- persisted snapshot/Run load;
- Agent Execution Request construction;
- Step Result acceptance;
- Artifact finalization;
- Event envelope write/read;
- monitoring/API boundaries as applicable.

Specific validation library is an implementation choice; Phase 1 does not require a particular library.

## Composition Root

Recommended entry:

```text
src/bootstrap/create-workflow-runtime.ts
```

Responsibilities:

```text
load/validate config
load/validate static registries
construct Stores/Readers
construct Repository/Workspace/Pi/User adapters
construct Domain/Application services
construct Orchestrator/use cases
```

Use manual constructor injection. A DI container or Service Locator SHOULD NOT be introduced for Phase 1.

### Default Production Composition

The package default path MUST construct an operational production runtime without test-only dependency injection. Calling `workflowExtension(pi)` from the installed Package MUST reach the production Composition Root and construct the Application use cases required by `/wf-*`.

The production Composition Root MUST connect, as applicable:

```text
Pi Extension / command context
  ↓
validated configuration and static registries
  ↓
Run/State/Artifact/Event stores and readers
  ↓
Run/Workspace locks + Repository/Workspace adapters
  ↓
Pi Agent Runtime + User Interaction + Skill/Model/Tool resolution
  ↓
Application use cases + Orchestrator
```

- **MUST:** Start create the initial Run/State required by the selected Playbook before entering the Orchestrator control loop.
- **MUST:** Status, resume, and cancel resolve the same project-local Run Store used by start.
- **MUST:** Pi execution facilities required by concrete Pi adapters, including Agent execution events, be supplied by the Pi-facing composition boundary rather than invented inside Domain/Application code.
- **MUST:** Command execution resolve the consuming repository/workspace explicitly; test-only defaults MUST NOT silently substitute for the real command context.
- **MUST NOT:** `FakeAgentRuntime`, injected command stubs, or a `NOT_IMPLEMENTED` placeholder be part of the normal installed-package path used to satisfy a release gate.
- **MAY:** Tests provide alternate factories/compositions, provided they are structurally separated from the default production path.

## Static Definitions

`src/agents/` contains seven versioned Agent definitions. `src/playbooks/` contains six versioned Playbook definitions. Registries validate duplicate IDs, versions, Agent/Skill references, Step types, and base graph validity at startup.

Static definitions MUST NOT import concrete Adapters.

## Commands

Start commands:

```text
/wf-feature
/wf-bug
/wf-hotfix
/wf-chore
/wf-refactor
/wf-investigation
```

Runtime commands:

```text
/wf-status
/wf-resume
/wf-cancel
```

Commands parse input, build/call runtime use cases, and render compact progress/final output. They MUST NOT contain Playbook-specific orchestration logic.

The package Extension entry point `src/extensions/workflow.ts` registers these commands through thin shims that call Application use cases. Command registration MUST NOT become a second orchestration layer.

## Read Model

A read-only layer MAY expose:

```text
RunSummary
RunDetail
ExecutionGraphView
ArtifactMetadata
```

for `/wf-status` and Monitoring. Read models are not used to mutate Workflow State.

## Telemetry and Evaluation Modules

`src/telemetry/` contains Event factories/policy/redaction/normalization; concrete JSONL writing remains an Adapter.

`src/evaluation/` contains deterministic `RunMetricsAggregator` and `RunEvaluator`. It is read-only and reusable by Monitoring.

## Monitoring Modules

Monitoring has its own bootstrap and MUST NOT call the workflow runtime bootstrap. It constructs only Run/Artifact/Event readers, SQLite indexer, evaluator, API, and live-update infrastructure.

## Architecture Tests

Phase 1 MUST mechanically verify:

```text
domain !→ application/adapters
application !→ adapters
adapters !→ application
playbooks/agents !→ adapters
monitor !→ persistence/write/orchestrator
no circular imports
pi-subagents imports only in Pi adapter area
control-plane Git process invocation only in repository adapter area
package manifest resource paths resolve
package source does not depend on authored `.pi/agent/skills` or `.pi/workflows` modules
```

Concrete test tool is an implementation choice.

## Testing Strategy

### L1 Domain

Pure unit/property tests for graph, Scheduler, lifecycle, Gates, freshness, completion, references.

### L2 Application

Orchestrator and use-case tests using `FakeAgentRuntime`, fake repository/user/store Ports.

### L3 Adapter Integration

File persistence, Git repository adapter, Pi adapter contract, Pi Package manifest/local-package loading, Ketch/CodeGraph adapters.

### L4 End-to-End

Golden repository scenarios for six Playbooks, dirty tree, recovery, security, and selected real Pi executions.

Real LLM-dependent tests SHOULD be few and focused; most runtime correctness tests remain deterministic.

## FakeAgentRuntime

`FakeAgentRuntime` is a long-lived test utility, not a temporary scaffold. It can deterministically return completed/blocked/failed/invalid results by Step/Agent and is used for orchestration regression tests and generation of Monitoring fixtures.

## Implementation Milestones

| Milestone | Scope | Gate |
|---|---|---|
| M0 | Pi Package skeleton / Architecture guardrails | — |
| M1 | Contracts / Domain types | — |
| M2 | Pure Domain engine | — |
| M3 | Persistence / Run Store | — |
| M4 | Orchestrator + Fake Runtime | Gate A: six fake Playbooks work |
| M5 | Pi Package / Agent Runtime integration | — |
| M6 | Write / Verify / Review | Gate B: real mutation safety |
| M7 | Recovery / Resume / Cancel | — |
| M8 | Commands / User interaction | Gate C: operational readiness |
| M9 | Telemetry / Evaluation | — |
| M10 | Monitoring | Gate D: observe/compare Runs |
| M11 | Hardening / legacy cutover | Phase 1 release |

### Early Vertical Slice

During M3/M4, run a minimal fake Feature flow:

```text
Fake Scout → Fake Planner → Fake Worker → Fake Verifier → Fake Reviewer → Outcome
```

Start linear, then add Gates/dynamic Steps/re-plan/D3/fix paths.

## Hardening

M11 includes:

```text
Golden repositories
crash matrix
permission/security matrix
conversation-independent context/resume checks
macOS/Linux/Windows filesystem/Git behavior
monitoring rebuild tests
local/packed Pi Package installation smoke tests
legacy cutover
```

Legacy `/wf-*` should switch to the new runtime only after real write safety/recovery gates pass. Legacy sessions are not migrated into the new State model.

### Release Evidence Contract

Hardening and release claims MUST be backed by reproducible Evidence rather than source inspection alone. Each platform/release Evidence record SHOULD capture:

```text
OS
Node version
pnpm version
Git version
filesystem/environment
test command
result
artifact/log location
```

For cross-platform validation, Phase 1 MUST execute the relevant persistence/Git/package-install checks on actual macOS, Linux, and Windows environments (for example CI runners or equivalent hosts). Host-independent path simulation alone is insufficient. At minimum, Evidence MUST cover state snapshot commit/pointer replacement, crash boundaries, Run/Workspace locks and process liveness, space/Unicode paths, Git status/diff/rename behavior, packed Package installation/loading, and packaged Skill discovery without authored `.pi/agent/skills/` copies.

Packed Package Evidence MUST exercise an artifact produced by the package process (for example `pnpm pack`) from a clean consumer context. Source-checkout resource existence or manually injected package roots do not by themselves satisfy packed-installation Evidence.

### Legacy Cutover Certification

Legacy cutover is evaluated as separate conditions rather than a single source-file absence check:

```text
LEGACY_PATH_ABSENT
NEW_RUNTIME_OPERATIONAL
CUTOVER_ELIGIBLE
NO_LEGACY_FALLBACK
```

- `LEGACY_PATH_ABSENT` requires obsolete Workflow runtime paths such as `workflow-tui.ts` to be absent.
- `NEW_RUNTIME_OPERATIONAL` requires installed/default `/wf-*` execution to reach the new production runtime without manual use-case injection.
- `CUTOVER_ELIGIBLE` requires Gates A-D plus required hardening Evidence, including packed-installation and cross-platform validation, to pass.
- `NO_LEGACY_FALLBACK` requires the normal path not to silently invoke an obsolete/compatibility Workflow runtime.

A cutover result MUST distinguish `PASS`, `FAIL`, `INSUFFICIENT EVIDENCE`, and `NOT ELIGIBLE` where applicable. Legacy path absence alone MUST NOT be reported as completed operational cutover.

## Phase 1 Exclusions

Do not implement as core Phase 1 functionality:

```text
parallel execution
arena / swarm
worktree isolation
multi-repository monitoring
remote monitoring/control
generic plugin framework
internal event bus
automatic workflow winner score
Operational Skills
```
