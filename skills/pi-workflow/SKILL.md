---
name: pi-workflow
description: Main-session control-plane policy for the read-only pi-workflow Planning MVP.
---

# pi-workflow

Use this Skill only from the Main Session. The Main Session owns control flow and
Human decisions; `pi-subagents` owns named-resource execution, Mission
persistence, and run metadata. Do not create another workflow engine, state
store, Agent registry, fallback CLI, or custom Mission runtime.

## Planning MVP boundary

The supported flow is:

```text
/wf-* → Discovery → optional Research → optional Human clarification → Planning → Human Plan Review → approved Plan
```

This flow is read-only. It ends after an approved canonical Plan is recorded.
Do not start Implementation, Verification, Verification Fix, Code Review, or
any other future runtime.

## Startup

For each `/wf-*` kickoff:

1. Call `subagent({ action: "mission.list" })` and stop if a current Mission is
   `planned`, `active`, `waiting`, or `needs_decision`. Report its ID, title,
   and native status; do not create a second Mission. Native Mission statuses
   are `planned`, `active`, `waiting`, `needs_decision`, `completed`, `failed`,
   and `cancelled`.
2. Call `subagent({ action: "list", capabilities: true })`. Require executable
   `scout` and `reviewer` Agents and the loaded
   `pi-workflow` and `pi-planning` Skills. Do not require `worker`,
   `pi-verification`, `ponytail-review`, the Research Agent,
   `ask_user_question`, or Plannotator at startup.
3. Do not require a clean working tree. The clean-tree gate belongs to the
   future Implementation flow.
4. Create exactly one native Mission with
   `subagent({ action: "mission.create", missionStatus: "active", mission: { title, objective } })`.
   Keep its Mission ID and pass it to every named-resource invocation.

Native Mission status is authoritative. Never copy it into pi-workflow state.
The pi-workflow Mission state contains only:

```text
version, requestType, request, phase, humanDecisions,
discoveryRef, discoveryMeta, researchRef, researchMeta,
planRef, planningDecision, planReview
```

The only phase values are `discovery`, `research`, `planning`, and `plan-review`.

A startup or machine-phase failure is fail-closed: report the exact failure and
use native `needs_decision` only when owner intervention is required:

```js
subagent({
  action: "mission.update",
  missionId,
  missionUpdate: { status: "needs_decision" },
});
```

Do not use an alternate runtime.

## Named-resource dispatch

Invoke resources directly with bounded args, the same Mission ID, the project
`cwd`, and `async: false`. Never pass a caller-owned script, schema, output
path, Artifact body, or upstream reference when the resource resolves it from
Mission state.

### Discovery

```js
subagent({
  workflow: "pi-workflow.discovery",
  args: { requestType, request, attempt: 1 },
  missionId,
  cwd,
  async: false,
});
```

The resource runs a fresh read-only `scout`, writes a file-only Discovery
Artifact, normalizes bounded `discoveryMeta`, and persists `discoveryRef` and
`discoveryMeta` in the same Mission. Read only that compact metadata in Main.
Discovery never invokes Research, Human clarification, or Planning.

`discoveryMeta` is bounded and contains `status`,
`externalResearchRequired`, `humanClarificationRequired`, `uncertainties`, and
`researchQuestions`. A non-`ready` Discovery or a missing handoff is
fail-closed.

### Optional Research

If and only if `discoveryMeta.externalResearchRequired === true`, check the
package-owned Research Agent and its restricted Ketch capabilities, then call:

```js
subagent({
  workflow: "pi-workflow.research",
  args: { attempt: 1 },
  missionId,
  cwd,
  async: false,
});
```

The resource resolves the same-Mission Discovery references, launches one
fresh read-only `pi-workflow.researcher`, and persists a valid `researchRef`
and completed `researchMeta`. Missing Discovery state, missing output, invalid
references, unavailable capability, or child failure is fail-closed.

When `discoveryMeta.externalResearchRequired === false`, do not invoke the
Research resource. Treat absent `researchRef` and `researchMeta` as the normal
skip. Do not create skipped Research state. Planning must reject Research state
that is present in this branch.

### Optional Human clarification

When `discoveryMeta.humanClarificationRequired === false`, do not invoke
`ask_user_question`. When it is `true`, verify that capability only then, set
native Mission status to `waiting`, and ask only the bounded uncertainty
questions from Main. Accept only a non-cancelled result with actual bounded
answers, persist `humanDecisions`, and launch Planning with the same Mission ID.
Cancellation, unavailable capability, malformed or empty answers, and bounds
failures are unresolved: do not invent `No`, `Skip`, or `Continue`.

Children never invoke `ask_user_question` or Plannotator.

### Planning

```js
subagent({
  workflow: "pi-workflow.planning",
  args: { round: 1 },
  missionId,
  cwd,
  async: false,
});
```

Add only bounded `humanInputs` or the previous rejected `feedbackRef` when
present. The resource resolves Discovery, optional Research, Human decisions,
and feedback from the same Mission. If external research is required, valid
`researchRef` plus completed `researchMeta` are mandatory. If it is not
required, both Research fields must be absent.

Planning uses a fresh built-in `reviewer` with `skill: "pi-planning"` and the
resource-owned `PlanningDecisionV1` schema. The decision remains the approved
Plan's bounded content: scope, acceptance criteria, risks, verification
Definitions, implementation mode, WorkUnits and their `writeScope`, final
verification IDs, and unresolved decisions. One automatic machine-invalid
correction is allowed inside the resource; a second failure stops the flow.

The resource writes only `planningDecision`, the canonical file-backed
`planRef`, and the phase marker. It never invokes Plannotator. Planning rounds
2 and 3 reuse the same resource and receive only the previous rejected
`feedbackRef`.

After a successful machine phase, launch the next workflow with the same
Mission ID. Do not issue an explicit `mission.update({ status: "active" })`
normalization between machine phases; native Mission activity is authoritative.

## Human Plan Review

The normal path is:

```text
prepare-review → Mission waiting → pi_workflow_plan_review → record-review terminal result
```

Before every review, call the zero-child control operation:

```js
subagent({
  workflow: "pi-workflow.planning",
  args: { operation: "prepare-review", round, planRef },
  missionId,
  cwd,
  async: false,
});
```

Only `ready` permits starting a new review. Then set native Mission status to
`waiting`:

```js
subagent({
  action: "mission.update",
  missionId,
  missionUpdate: { status: "waiting" },
});
```

Call `pi_workflow_plan_review` with exactly `missionId`, `round`, and the
validated canonical `planRef`. Check Plannotator capability immediately before
this call, not at startup. The bridge reads the supplied Plan Artifact and
returns a bounded terminal result or a bounded `feedbackRef`.

Record the terminal result exactly once; do not record `status: "pending"`
first:

```js
subagent({
  workflow: "pi-workflow.planning",
  args: { operation: "record-review", round, planRef, reviewId, status: "approved" },
  missionId,
  cwd,
  async: false,
});
```

For an explicit rejection, record once with the returned `feedbackRef`:

```js
subagent({
  workflow: "pi-workflow.planning",
  args: {
    operation: "record-review",
    round,
    planRef,
    reviewId,
    status: "rejected",
    feedbackRef,
  },
  missionId,
  cwd,
  async: false,
});
```

A bridge, Artifact, or state failure is not a rejection and must fail-closed.

Approval means:

```text
record-review(approved) → mission.close(completed) → STOP
```

Close the native Mission with
`subagent({ action: "mission.close", missionId, missionStatus: "completed" })`;
do not launch another resource after that. A rejection with `round < 3` starts the next Planning round with only
`feedbackRef`. A round-3 rejection transitions to native `needs_decision` and
stops; never launch round 4.

`review-status` remains a zero-child recovery/status operation. It is not
required on the happy path. Missing or stale Mission binding, review ID, round,
or Plan reference fails closed without starting a replacement review.

## Stop and recovery

Classify native stop, cancellation, and interruption before any retry or state
transition. Return the exact native stop result and do not normalize, retry,
prepare another phase, create another Mission, or close the Mission.

Native `completed` for one workflow run is not proof that the Planning MVP is
complete. Continue or recover with the same Mission ID. Only an approved Plan
may close the Mission as `completed`.
