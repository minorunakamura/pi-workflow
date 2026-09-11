---
name: pi-workflow
description: Main-session control-plane policy for the read-only pi-workflow Planning MVP.
---

# pi-workflow

Use this Skill only from the Main Session. Main owns control flow and Human
decisions; `pi-subagents` owns named-resource execution, Mission persistence, and
run metadata. Do not create another workflow engine or state store.

## Planning MVP boundary

```text
/wf-* → Discovery → optional Research → optional Human clarification
      → Planning → Human Plan Review → approved Plan
```

Stop after an approved Plan is persisted. Do not start Implementation,
Verification, Verification Fix, automated Review, Ponytail, Human Code Review,
worker execution, parallel implementation lanes, or deployment/release.

## Startup

For each `/wf-*` kickoff:

1. Call `subagent({ action: "mission.list" })`. If a current Mission is
   `planned`, `active`, `waiting`, or `needs_decision`, report its ID, title, and
   native status and stop; do not create a second Mission.
2. Call `subagent({ action: "list", capabilities: true })`. Require executable
   `scout` and `reviewer` Agents and the loaded `pi-workflow` and `pi-planning`
   Skills. Check Research, clarification, and Plan Review capabilities only when
   their branches are needed.
3. Create exactly one native Mission and keep its ID for every resource call:

   ```js
   subagent({
     action: "mission.create",
     missionStatus: "active",
     mission: { title, objective },
   });
   ```

Native Mission status is authoritative. Its possible statuses are `planned`,
`active`, `waiting`, `needs_decision`, `completed`, `failed`, and `cancelled`.
The workflow state contains only:

```text
version, requestType, request, phase, humanDecisions,
discoveryRef, discoveryMeta, researchRef, researchMeta,
planRef, planningDecision, planReview
```

The only phase values are `discovery`, `research`, `planning`, and `plan-review`.
A startup or machine-phase failure is fail-closed; use native `needs_decision`
only when owner intervention is required:

```js
subagent({
  action: "mission.update",
  missionId,
  missionUpdate: { status: "needs_decision" },
});
```

## Named-resource dispatch

Invoke only the named resources with bounded arguments, the same `missionId`, the
project `cwd`, and `async: false`. Do not pass Artifact bodies or caller-owned
execution definitions; resources resolve their inputs from the same Mission.

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

Discovery runs a fresh read-only `scout`, writes a file-backed Discovery
Artifact, normalizes bounded `discoveryMeta`, and persists `discoveryRef` and
`discoveryMeta`. Main uses only that compact metadata. A non-`ready` result or a
missing handoff is fail-closed.

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

A successful Research run persists `researchRef` and completed `researchMeta`.
When `discoveryMeta.externalResearchRequired === false`, do not invoke the
Research resource. Do not create skipped Research state; both Research fields
remain absent.

### Optional Human clarification

When `discoveryMeta.humanClarificationRequired === false`, do not invoke
`ask_user_question`. When it is `true`, verify that capability and set native
Mission status to `waiting`:

```js
subagent({
  action: "mission.update",
  missionId,
  missionUpdate: { status: "waiting" },
});
```

Ask only the bounded questions from Main.
Persist only a non-cancelled result with bounded answers, then continue with the
same Mission ID. Cancellation, unavailable capability, malformed answers, and
bounds failures are unresolved; never invent an answer. Children never invoke
`ask_user_question` or Plannotator.

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
present. Planning resolves Discovery, optional Research, Human decisions, and
feedback from the same Mission. It writes a bounded `PlanningDecisionV1` and a
canonical file-backed `planRef`; the resource may make one automatic correction
for a machine-invalid result, then fails closed.

## Human Plan Review

The review sequence is:

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

Only `ready` permits a new review. Then set native Mission status to `waiting`,
check Plannotator capability immediately before calling
`pi_workflow_plan_review`, and pass exactly `missionId`, `round`, and the
validated canonical `planRef`.
Record the terminal result exactly once; never record `pending` first.

For approval, record the terminal result with `status: "approved"`:

```text
record-review(approved) → mission.close(completed) → STOP
```

Use:

```js
subagent({
  action: "mission.close", missionId, missionStatus: "completed",
});
```

For rejection, record the returned `feedbackRef`. If `round < 3`, start the next
Planning round with only that reference. A round-3 rejection transitions to
native `needs_decision` and stops; never start round 4. A bridge, Artifact, or
state failure is not a rejection and must fail-closed.

## Stop and recovery

Classify native stop, cancellation, and interruption before retrying or changing
state. Return the exact native result and do not normalize, retry, prepare
another phase, create another Mission, or close the Mission. A successful
foreground resource run is not proof that the whole Planning MVP is complete;
continue with the same Mission ID. Only an approved Plan may close the Mission
as `completed`.

Do not issue an explicit `mission.update({ status: "active" })` normalization
between machine phases; native Mission activity is authoritative.
