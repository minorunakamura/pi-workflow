# pi-workflow

## What is pi-workflow?

`pi-workflow` is a Planning-oriented Pi package. It turns a feature, bug, chore,
or hotfix request into a bounded, human-approved Plan while keeping Mission state
and large Artifacts in native `pi-subagents` resources.

## Supported flow

```text
/wf-* → Discovery → optional Research → optional clarification
      → Planning → Plan Review → approved Plan
```

The supported runtime ends after the approved Plan is persisted and the Mission
is closed as `completed`. Implementation, Verification, automated Review, worker
execution, parallel implementation lanes, and deployment/release are out of
scope.

## Commands

```text
/wf-feature <request>
/wf-bug <request>
/wf-chore <request>
/wf-hotfix <request>
```

Example:

```text
/wf-feature Add CSV export to the reports page
```

## Requirements

- A Pi-compatible runtime; the development/test target is
  `@earendil-works/pi-coding-agent` 0.85.x.
- `pi-subagents` 0.67.0.
- Executable `scout` and `reviewer` capabilities, plus the `pi-workflow` and
  `pi-planning` Skills.
- When Discovery requires external evidence: the package-owned Research Agent
  and its `pi-ketch` capabilities.
- When clarification or Plan Review is needed: Main Session access to
  `ask_user_question` and the external Plannotator integration, respectively.

## Architecture

- Main Session is the thin control plane and the only owner of Human decisions.
- `pi-subagents` Mission is the durable lifecycle and state owner.
- Named resources are `pi-workflow.discovery`, `pi-workflow.research`, and
  `pi-workflow.planning`.
- Discovery, Research, Plan, and rejection feedback bodies are file-backed
  Artifacts; Main and Mission state carry compact references and bounded metadata.

See [the Main Session Skill](skills/pi-workflow/SKILL.md),
[basic design](docs/pi-workflow-basic-design.md),
[implementation specification](docs/pi-workflow-implementation-spec.md), and
[current roadmap](docs/pi-workflow-roadmap.md).

## Validation

```bash
pnpm check
pnpm validate:native
```

`validate:native` starts Pi in offline RPC mode, loads the extension, and checks
that the four canonical commands are registered. It does not run a Mission or a
full workflow.

## Current scope

`pi-workflow` is a Planning MVP. It stops at the approved Plan; any later runtime
requires a new design decision.
