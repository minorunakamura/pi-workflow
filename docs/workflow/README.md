# Workflow Documentation

## Purpose

This directory is the documentation entry point for the Pi workflow orchestration runtime distributed as an installable **Pi Package**. The documentation is intentionally split by subsystem so that a human or Agent can load only the specification relevant to the current implementation Story.

## Recommended Reading

- Start with `01-overview.md` for goals, terminology, Agents, Playbooks, and phase scope.
- Read `02-runtime-architecture.md` for runtime components, Ports and Adapters, the Control Plane, and dependency direction.
- Read `03-domain-model.md` for authoritative logical entities, lifecycles, identities, and invariants.
- Read `04-orchestration.md` for Scheduler rules, Gates, dynamic Steps, Playbooks, retry/re-plan, and completion flow.
- Read `05-agents-and-skills.md` for Agent contracts, Skills, Tools, permissions, prompts, and model routing.
- Read `06-persistence-and-artifacts.md` for `run.yaml`, state snapshots, Artifacts, Events persistence, and crash consistency.
- Read `07-security-recovery-and-repository.md` for repository mutation safety, drift, locks, recovery, resume, cancellation, and failure.
- Read `08-observability-and-evaluation.md` for Event semantics, telemetry, metrics, evaluation, and comparison.
- Read `09-monitoring.md` for the local read-only Monitoring application.
- Read `10-implementation-specification.md` for TypeScript module mapping, Ports, Adapters, configuration, tests, and build order.
- Read `11-implementation-backlog.md` for Epics, Stories, Acceptance Criteria, dependencies, and `spec_refs`.

## Source-of-Truth Matrix

| Area | Authoritative document |
|---|---|
| Goals and terminology | `01-overview.md` |
| Runtime components and dependency direction | `02-runtime-architecture.md` |
| Domain entities and lifecycles | `03-domain-model.md` |
| Execution flow, Playbooks, Scheduler, and Gates | `04-orchestration.md` |
| Agents, Skills, Tools, model policy, execution contracts | `05-agents-and-skills.md` |
| State, Artifact, and Event physical persistence | `06-persistence-and-artifacts.md` |
| Repository safety, security, recovery, and failure | `07-security-recovery-and-repository.md` |
| Event semantics, telemetry, metrics, evaluation | `08-observability-and-evaluation.md` |
| Monitoring application | `09-monitoring.md` |
| TypeScript implementation and Pi Package mapping | `10-implementation-specification.md` |
| Work tracking | `11-implementation-backlog.md` |

> **Invariant**
>
> `01` through `10` are the specification. `11-implementation-backlog.md` is an implementation-tracking projection and MUST NOT redefine the architecture.

## Package Source vs Project Runtime Data

The package repository and a consuming project's runtime data are intentionally separate:

```text
Pi Package source repository
├── src/                  ← TypeScript implementation
├── skills/               ← packaged Pi Skills
├── docs/
└── tests/

Consuming project
└── .pi/
    ├── settings.json     ← optional Pi project settings/package reference
    └── runs/             ← authoritative workflow Run data
```

- **MUST NOT:** Package implementation source be organized under `.pi/agent/skills/` or `.pi/workflows/`.
- **MUST:** Pi-visible extension and Skill resources be declared by the package manifest described in `10-implementation-specification.md#package-manifest`.
- **MUST:** `.pi/runs/` remain project-local runtime data and not package source.

## Documentation Rules

- **MUST:** A concept has one authoritative document. Other documents use a short summary and cross-reference.
- **MUST:** Final specifications describe the current contract only; superseded design alternatives are not retained as active requirements.
- **MUST:** Implementation Stories load only their required `spec_refs` instead of all documents by default.
- **MUST NOT:** Conversation history be required to understand, resume, implement, or review the workflow.
- **SHOULD:** Major cross-reference headings remain stable.
- **SHOULD:** ASCII diagrams be treated as the canonical text representation when both ASCII and Mermaid diagrams exist.

## Specification Vocabulary

The normative keywords **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used consistently across these documents. `Invariant` marks a hard architectural rule that configuration, Playbooks, Agents, or user approval cannot override.
