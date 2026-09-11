# pi-workflow implementation specification

This document describes the implementation currently present in the repository.
It is intentionally concrete where code and package contracts matter; the
architecture and Main policy are in the [basic design](pi-workflow-basic-design.md)
and [Skill](../skills/pi-workflow/SKILL.md).

## 1. Package contract

`package.json` exposes a Pi package with:

- extension entry point `./src/index.ts`;
- Skill directory `./skills`;
- package-owned Agent directory `./agents`;
- runtime dependencies `pi-ketch` and the Pi peer API;
- exact `pi-subagents` `0.67.0` peer and development dependency;
- no bundled Mission runner, Plannotator, or Human-question package.

The published package contents are `src`, `runtime`, `workflow-scripts`, `skills`,
`agents`, and `README.md`. The `docs` and validation scripts are repository
assets, not runtime package resources.

## 2. Package layout

```text
src/index.ts                         registration-only extension entry point
src/commands/workflow.ts             /wf-* kickoff adapters
src/tools/plan-review.ts             pi_workflow_plan_review tool
src/runtime/workflow-resources.ts    named-resource definitions and lifecycle
src/runtime/plannotator/              external Plan Review event bridge
src/research/researcher-extension.ts Research-only Ketch wrapper
src/core/phases/                     phase args and output policies
src/core/state/                      Mission state and opaque references
src/core/planning/                   PlanningDecisionV1 and Plan bounds
workflow-scripts/                    resource-owned execution templates
runtime/plan-artifact.mjs             canonical Plan renderer
skills/pi-workflow/SKILL.md           Main Session policy
skills/pi-planning/SKILL.md           Planning child contract
agents/researcher.md                 package-owned Research Agent
scripts/native-smoke.mjs              native command-registration smoke
```

`src/core` has no dependency on Pi adapters, commands, tools, or runtime bridge
layers. Plain Node runtime assets stay outside `src`.

## 3. Extension entry point and lifecycle

`src/index.ts` only calls:

1. `registerCommands(pi)`;
2. `registerTools(pi)`;
3. `registerWorkflowResourceLifecycle(pi)`.

`src/commands/workflow.ts` registers `wf-feature`, `wf-bug`, `wf-chore`, and
`wf-hotfix`. Each handler trims the request, reports usage for an empty request,
and sends a Main-session kickoff message. It does not create a Mission or invoke
a resource.

`src/runtime/workflow-resources.ts` registers all three named resources on
`session_start` and disposes them on `session_shutdown`. Registrations are tracked
per session, duplicate active registration is rejected, partial registration is
rolled back, and disposal runs in reverse order. The public boundary is the
`pi-subagents/workflow-resources` API.

## 4. Commands and Plan Review tool

The only registered tool is `pi_workflow_plan_review`. Its closed input is:

```text
missionId: bounded reference string
round: integer 1..3
planRef: bounded reference string
```

It accepts no Plan body, PlanningDecision, output path, or caller-owned execution
input. `src/runtime/plannotator/plan-review.ts` reads the explicit `planRef`,
requests a Plan Review through the event bridge, waits for the matching terminal
result, and returns either approval or a feedback reference.

## 5. Named resources and invocation contract

The definitions in `src/runtime/workflow-resources.ts` are exactly:

```text
pi-workflow.discovery
pi-workflow.research
pi-workflow.planning
```

Every resource resolver validates its phase-specific args, injects only
package-owned schemas and bounds, and returns a resource-owned execution plan.
Main invokes them with the same `missionId`, project `cwd`, and `async: false`.
The caller supplies no Artifact body or upstream body; resources read same-Mission
state and references.

### Discovery args

```json
{ "requestType": "feature|bug|chore|hotfix", "request": "...", "attempt": 1 }
```

`attempt` is optional and bounded. The request is non-empty and byte-bounded.

### Research args

```json
{ "attempt": 1 }
```

All fields are optional and bounded. The resource itself rejects invocation when
Discovery does not require external research or when the same-Mission Discovery
handoff is incomplete.

### Planning args

The default operation is `plan` when `operation` is omitted:

```json
{
  "operation": "plan",
  "round": 1,
  "humanInputs": [{ "id": "...", "value": "..." }],
  "feedbackRef": "..."
}
```

The optional `humanInputs` and `feedbackRef` are bounded. Control operations use
these closed shapes:

```text
prepare-review: round, planRef
record-review: round, planRef, reviewId, status(approved|rejected), feedbackRef?
review-status: round, planRef
```

Control operations are zero-child state operations. `record-review` accepts one
terminal transition only; rejection requires `feedbackRef`, approval forbids it.

## 6. Mission state and references

The package-owned `MissionStateV1` keys are:

```text
version, requestType, request, phase, humanDecisions,
discoveryRef, discoveryMeta, researchRef, researchMeta,
planRef, planningDecision, planReview
```

`phase` is `discovery | research | planning | plan-review`. `requestType` is
`feature | bug | chore | hotfix`. `humanDecisions` is a bounded list of `{ id,
value }` entries.

`discoveryMeta` contains `version`, `status`,
`externalResearchRequired`, `humanClarificationRequired`, `uncertainties`, and
`researchQuestions`. `researchMeta` contains `version`, `status`, and
`unresolvedQuestions`. `planReview` contains a round-bound `status`, `planRef`,
and the applicable `reviewId` or `feedbackRef`.

`src/core/state/references.ts` treats a reference as an opaque bounded string.
`ArtifactBody` is a separate type and never belongs in Mission state. Native
Mission status is not represented as a package state key.

## 7. Bounds and validation ownership

The canonical constants are in `src/core/validation.ts`,
`src/core/state/contracts.ts`, and `src/core/planning/limits.ts`:

| Contract | Bound |
| --- | ---: |
| resource args JSON | 16 KiB |
| Mission state JSON | 256 KiB |
| reference | 2 KiB |
| regular text | 1 KiB |
| request | 8 KiB |
| Human entries / value | 8 / 2 KiB |
| Plan Review rounds | 3 |
| JSON depth | 8 |
| PlanningDecision JSON | 32 KiB |

TypeBox handles structure. Core validators add UTF-8, serialized JSON, duplicate
ID, cross-reference, WorkUnit, and Plan Review binding checks. Resource templates
repeat the checks needed after a child result is returned. `PlanningDecisionV1`
is defined once in `src/core/planning/planning-decision-schema.ts`; its semantic
validation is in `planning-decision.ts`.

## 8. Discovery resource

`workflow-scripts/discovery.js`:

1. reads and validates the existing allowlisted Mission state;
2. rejects mismatched request data or an existing/incomplete Discovery handoff;
3. runs fresh read-only `scout` with `outputMode: "file-only"`;
4. preserves the complete output as `discoveryRef`;
5. runs a second fresh `scout` to normalize only `discoveryMeta` with
   `outputSchema`;
6. persists the bounded state and returns compact status, run ID, reference, and
   metadata.

Full Discovery is an Artifact, not structured output. Main receives the compact
handoff only.

## 9. Research resource and extension boundary

`workflow-scripts/research.js` requires a ready same-Mission Discovery handoff,
requires `externalResearchRequired`, and rejects existing Research state. It
runs fresh `pi-workflow.researcher` with file-only output, persists `researchRef`
and completed `researchMeta`, and returns compact metadata.

`agents/researcher.md` makes the Agent read-only and limits it to
`pi_workflow_ketch_search`, `ketch_code`, `ketch_docs`, and `ketch_scrape`.
`src/research/researcher-extension.ts` owns the consumer-specific search wrapper:

- one configured/default backend or one explicit backend per search;
- a closed supported backend list;
- duplicate exact-search rejection;
- retention of non-recoverable failures;
- no automatic retry, aggregation, or provider probing.

The extension is loaded only in the Research Agent context. Research does not
invoke Human-question or Plan Review capabilities.

## 10. Planning resource

`workflow-scripts/planning.js` validates the same-Mission Discovery handoff,
conditional Research state, Human decisions, and round/feedback binding. It runs
a fresh `reviewer` with `skill: "pi-planning"`, `outputSchema` set to the
package-owned `PlanningDecisionSchema`, and file-only output.

A schema-invalid result fails immediately. A schema-valid result with semantic or
byte errors gets one correction run. If the correction is still invalid, the
resource fails closed. The accepted decision is validated again before state is
written.

For a `plan` operation, the resolver creates resource-owned temporary paths for
the decision input, optional correction input, and Plan Artifact. It registers a
host command for `runtime/plan-artifact.mjs`, then the resource persists
`planningDecision`, `planRef`, and the appropriate `planReview`/`phase` fields.

Round 1 enters `plan-review`. Rounds 2 and 3 require the previous rejected
`feedbackRef` and create a new pending Plan Review binding. Control operations
validate current `planRef`, round, phase, and binding before changing state.

## 11. Plan Artifact renderer

`runtime/plan-artifact.mjs` is a plain Node renderer. It reads the validated
PlanningDecision JSON input, renders request, scope, acceptance criteria,
constraints, WorkUnits, verification, risks, and non-goals as Markdown, and
writes the canonical Plan file with restricted file permissions. The Planning
resource invokes it through a package-owned host command; Main does not transport
its input or output body.

## 12. Plannotator bridge

`src/runtime/plannotator/request.ts` and `plan-review.ts` provide a dependency-free
Pi event bridge. The request channel is `plannotator:request`; the result channel
is `plannotator:review-result`. Supported actions are `plan-review` and
`review-status`.

The bridge validates the exact Plan Review input and reads only the supplied
regular file. It verifies matching review IDs, requires non-empty rejection
feedback, writes that feedback to a package-owned file-backed Artifact, and
returns only `approved`, `reviewId`, `planRef`, and optional `feedbackRef`.
Plannotator is an external capability; it is not a package dependency.

## 13. Artifact and reference ownership

| Owner | May write | Main-visible result |
| --- | --- | --- |
| Discovery resource | Discovery report and metadata | `discoveryRef`, `discoveryMeta` |
| Research resource | Research report and metadata | `researchRef`, `researchMeta` |
| Planning resource | Planning decision and Plan | `planningDecision`, `planRef` |
| Plan Review bridge | rejection feedback | `feedbackRef` |
| Main Session | Human decisions and native status calls | bounded decisions/status |

No component copies a large Artifact body into Mission state or into a public
Main call. References are passed and checked as bounded opaque values.

## 14. Test and validation boundary

The repository has deterministic tests for:

- core bounds, schemas, references, and PlanningDecision semantics;
- command and tool contracts;
- resource templates and state handoffs;
- Plannotator and Plan Artifact runtime behavior;
- Research Agent extension behavior;
- package contents and public `pi-subagents` compatibility.

The normal gate is:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm check
pnpm validate:native
git diff --check
```

`scripts/native-smoke.mjs` runs Pi offline in RPC mode, loads `src/index.ts`, and
checks only extension loading and registration of `wf-feature`, `wf-bug`,
`wf-chore`, and `wf-hotfix`. It does not claim a full Mission, resource, Human,
or Plannotator run.

## 15. Current scope

The implementation contains only the Planning MVP described here. No runtime
contract is defined in this specification for execution, verification,
automated review, operational monitoring, or release. See the short
[roadmap](pi-workflow-roadmap.md) for the current/deferred boundary.
