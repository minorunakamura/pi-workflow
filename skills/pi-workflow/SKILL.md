---
name: pi-workflow
description: Main-session control-plane policy for pi-workflow planning, native Mission ownership, capability gates, and fail-closed Human decisions.
---

# pi-workflow

Use this Skill only from the Main Session. The Main Session is the control plane;
`pi-subagents` owns child execution, workflowScript execution, Mission persistence,
worktrees, and run metadata. Do not create a second workflow engine, state store,
Agent registry, fallback CLI, or custom Mission runtime.

## Planning-flow boundary

The current Unit 5 Planning Flow is read-only. It ends when a valid canonical
`plan.md` Artifact and `planRef` are stored. Do not start Plan Review, a Worker,
mutate source files, verify an implementation, run automated code review, run
final Code Review, or close the Mission as success in this flow.

## Startup gates

For each `/wf-*` kickoff, perform these checks in order:

1. Call `subagent({ action: "mission.list" })` for the current project.
2. The official `pi-subagents` v0.66.0 Mission statuses are `planned`, `active`,
   `waiting`, `needs_decision`, `completed`, `failed`, and `cancelled`.
   Block a new workflow when a Mission is `planned`, `active`, `waiting`, or
   `needs_decision`. Report its Mission ID, title, and status; do not resume,
   cancel, close, or create another Mission.
3. `completed` on a phase workflow is not proof that pi-workflow is complete.
   The native top-level phase run can make the Mission terminal before the Main
   Control Plane advances to the next phase. If recovery sees a pi-workflow
   Mission in that condition, call `mission.show`, inspect its native linked
   run/phase metadata, and continue or recover with the same Mission ID. Do not
   create a replacement Mission merely because a phase run says `completed`.
   Only the final Main Control Plane completion may close the Mission.
4. `paused` is not a Mission status in this contract; it is a native goal status
   value. Do not use or invent `status: "paused"` for a Mission.
5. Call `subagent({ action: "list", capabilities: true })`. Require executable
   `scout`, `reviewer`, and `worker` rows. For this Planning Flow, `worker` is
   checked at startup even though it is not started yet. A capability-ceiling
   denial is missing capability. Do not silently switch agents or execution
   modes.
6. Check the loaded skill inventory for `pi-workflow`, `pi-planning`,
   `pi-verification`, and `ponytail-review`. Missing own Skills or the required
   Ponytail review capability is a start blocker.
7. Run `git status --porcelain` with the Main Session's minimal safety check.
   A command error or any output is a blocker. Do not create a Mission for a
   dirty tree.
8. Create exactly one explicit native Mission with
   `subagent({ action: "mission.create", missionStatus: "active", mission: { title, objective } })`.
   Do not set `goal: true`. Keep the returned Mission ID and pass it explicitly
   to every later phase workflow.

A failed startup gate is fail-closed: report the exact blocker and do not use a
fallback runtime or CLI.

## Phase dispatch

The migrated Discovery phase uses the canonical named resource directly:

```js
subagent({
  workflow: "pi-workflow.discovery",
  args: { requestType, request, attempt: 1 },
  missionId,
  cwd,
  async: false,
});
```

Do not add `agent`, `task`, `workflowScript`, `workflowScriptPath`,
`outputSchema`, `output`, or an arbitrary Artifact path to this invocation. The
resource owns its script, schema, child policy, and Artifact location. Its
result is compact; read `discoveryRef` and `discoveryMeta`, not a report body.

The remaining, not-yet-migrated phases—Implementation, Verification, Verification
Fix, and Review—still use `pi_workflow_prepare_phase` with validated JSON
payloads. Discovery, Research, and Planning are not legacy calls. Never provide
a template path, JavaScript, or an arbitrary workflow script. Each remaining
legacy phase call uses the returned `workflowScript` with the same `missionId`
and project `cwd`.

The phase workflow is sequential because its structured result is needed by the
next phase. Use a blocking native workflow invocation when the next decision is
needed immediately; do not invent a parallel scheduler.

Before launching a prepared phase, call `subagent({ action: "validate", workflowScript })` with the exact returned script. The script passed to validation and execution must be byte-for-byte identical to the `pi_workflow_prepare_phase` result; do not retype, edit, or reconstruct it. If validation fails, report the validation error and stop without launching the phase.

### Explicit user stop

Classify every native phase result before any Mission normalization, correction, retry, resume, or new phase preparation. A native result with state/status/terminal reason `stopped`, `cancelled`, or `interrupted`, or an explicit `user stop` / `Subagent stopped by user.` reason, is an explicit user stop. It is not a semantic-validation failure and is not retryable.

For an explicit user stop, stop the current pi-workflow execution and return the exact native stop result to the Main Session/Human. Do not run automatic Planning correction, retry or resume the run, call `mission.update`, prepare a new phase, create another Mission, or close the Mission. This rule applies to the observed terminal result; do not infer a different ordering when an action was already started before the stop.

### Native Mission lifecycle between phases

A phase workflow's top-level `completed` result is only a phase-run outcome.
It must never be treated as pi-workflow completion. Immediately after every
successful phase workflow returns, before branching or starting the next phase,
the Main Control Plane must call:

```js
subagent({
  action: "mission.update",
  missionId,
  missionUpdate: { status: "active" },
});
```

If the next action is a Human input or approval gate, use the native
`mission.update` with `missionUpdate: { status: "waiting" }` while waiting.
After the Human result, restore `active` before continuing. `waiting` is a
Mission status from the v0.66.0 contract; do not substitute an invented status.
If a machine-invalid phase result stops the flow, use native
`missionUpdate: { status: "needs_decision" }` when owner intervention is
required and report the explicit failure. Do not leave the Mission's transient
phase `completed` status as if the whole workflow succeeded.

This normalization is required after Discovery, optional Research, and
Planning, including after a Plan rejection before re-planning. A Human Plan
rejection is a separate re-planning control and does not consume the single
automatic Planning correction.

### Discovery

Invoke `pi-workflow.discovery` with only bounded request args and the current
Mission. The resource owns the full investigation, metadata schema, output
policy, and state handoff:

- full Discovery is a `file-only` Artifact with no `outputSchema`;
- a fresh built-in `scout` runs with explicit `async: false`;
- a second fresh `scout` reads only the Artifact Reference and returns the
  bounded `DiscoveryMetadataV1` schema;
- `discoveryRef` and `discoveryMeta` are written to the same Mission state;
- the Main result contains only compact status, run ID, Reference, and bounded
  metadata.

`DiscoveryMetadataV1` is the only structured contract exposed by this resource:

```ts
{
  version: 1,
  status: "ready" | "blocked",
  externalResearchRequired: boolean,
  humanClarificationRequired: boolean,
  uncertainties: Array<{ id: string; question: string; material: boolean }>,
  researchQuestions: string[],
}
```

Its strings, arrays, Reference, and aggregate JSON size are bounded by the
shared Unit 2 contract. Do not pass a Discovery schema, Artifact path, report,
transcript, or `workflowScript` from Main. Do not parse prose as metadata.
Discovery remains read-only and never invokes Research, Human clarification, or
Planning itself.

The full scout follows this CodeGraph policy: `codegraph status` first; if
usable, use `codegraph explore` for structural questions; read exact source only
when needed; otherwise use bounded `read`/`grep`/`find`/`ls`. Never run
`codegraph init`, `index`, `sync`, or `upgrade`.

### Conditional Research

Read only the compact `discoveryMeta` result from the Discovery resource. If and
only if `discoveryMeta.externalResearchRequired === true`, first confirm that
the exact `pi-ketch.researcher` capability is present and executable. Then
invoke the active named resource:

```js
subagent({
  workflow: "pi-workflow.research",
  args: { attempt: 1 },
  missionId,
  cwd,
  async: false,
});
```

The Research resource resolves `discoveryRef`, `discoveryMeta`, and bounded
`researchQuestions` from the same Mission state. Main never reads, copies, or
relays the Discovery Artifact body, path, or report into the invocation. The
resource launches one fresh `pi-ketch.researcher` with explicit `async: false`,
read-only policy, and a fixed `file-only` Artifact output. Its result is only a
bounded `researchRef` and `researchMeta`; the full report is not returned to
Main or stored in Mission state.

When `externalResearchRequired === false`, invoke the same named resource only
as its control-only skip path. It must launch zero children, create no
`researchRef`, and persist canonical `researchMeta.status === "skipped"` in the
same Mission. Do not add a `mark-research-skipped` Tool or use another Mission's
state. A missing required reference, missing capability, child failure, missing
Artifact/outputReference, invalid Reference, or `state.set` failure is
fail-closed and must not produce a completed Research result.

After either completed or skipped Research, normalize the Mission to native
`active` before continuing.

### Main-only Human clarification

After Discovery and the conditional Research path, evaluate only bounded
`discoveryMeta.humanClarificationRequired` and its bounded `uncertainties`.
When it is `false`, do not invoke `ask_user_question`; its unavailable state is
not a blocker. When it is `true`, check the conditional `ask_user_question` capability, set
the Mission to native `waiting`, and ask only those bounded questions from the
Main Session. Do not read the full Discovery Artifact to construct questions.

Accept answers only when `details.cancelled === false`, the result is valid, and
there is at least one actual answer. Normalize them to the Unit 2 bounded
Human decision contract (maximum 8 entries, each value at most 2,048 UTF-8
bytes), using canonical `humanDecisions` when persisted, and carry them as
Main-origin control data for the next phase / Mission state. Cancel, unavailable,
non-TUI unsupported paths, malformed answers,
empty answers, oversized values, and too many answers are unresolved and
fail-closed: never invent `No`, `Skip`, `Continue`, or another default, and do
not advance the phase. Restore native `active` only after a valid answer.

Children, including Discovery and Research resources, never call
`ask_user_question`, Plannotator, or any interactive prompt. Human
clarification is not a Plannotator approval fallback.

### Planning

Once Discovery, Research, and any required bounded Human decisions are ready,
invoke the active named resource directly:

```js
subagent({
  workflow: "pi-workflow.planning",
  args: {
    round: 1,
    // Add bounded humanInputs/feedbackRef only when each is present.
  },
  missionId,
  cwd,
  async: false,
});
```

Omit optional `humanInputs` and `feedbackRef` when they are not present. Do not
add `task`, Discovery/Research bodies, `discoveryRef`, `researchRef`,
`planningDecision`, Plan prose, `outputSchema`, `outputPath`, or
`workflowScript`. The resource owns the schema, child policy, Artifact location,
and all workflow code.

The Planning resource resolves `discoveryRef`, `discoveryMeta`, the resolved
Research state (`completed` with `researchRef` or explicit `skipped`), bounded
`humanDecisions`, and any same-Mission feedback Reference internally. Missing
Research state is not an implicit skip, and cross-Mission references fail
closed. Main never reads or relays the Discovery or Research Artifact bodies.

Planning uses a fresh built-in `reviewer` with `skill: "pi-planning"` and
explicit `async: false`. Its resource-owned `PlanningDecisionV1` schema is
bounded and its result passes schema, UTF-8, aggregate-size, and existing
semantic validation. One automatic semantic/byte correction is allowed inside
the resource; a second invalid result fails closed. Do not parse reviewer prose
as a plan or construct correction prompts in Main.

On success the resource deterministically renders the canonical human-readable
Plan, stores it as a resource-owned file-backed Artifact, writes only its
bounded `planRef` and `planningDecision` to the same Mission state, and returns
only a compact result. The Plan body is not placed in Mission state or
`workflow.value`. `PlanningDecisionV1` may remain visible as bounded native
structured output under the S2 policy; it is not the Plan Artifact.

Unit 5 ends after `planRef` is available. The Planning resource does not invoke
Plannotator, `pi_workflow_plan_review`, `ask_user_question`, or approval logic.
Do not start Implementation or close the Mission from this path.

## Deferred Human Plan Gate (Unit 6)

Unit 5 stops after the Planning resource returns a canonical `planRef`. Unit 6
continues from that reference, but remains a Main-only Human Gate. Main is the
sole authority for starting Plannotator, interpreting its result, advancing the
phase, and deciding whether to re-plan. Main never calls native Mission
`state.get` or `state.set`; the Planning resource owns those operations.

### Prepare the Plan Review

Before every Plan Review start, call the existing Planning resource with its
control operation:

```js
subagent({
  workflow: "pi-workflow.planning",
  args: {
    operation: "prepare-review",
    round,
    planRef,
  },
  missionId,
  cwd,
  async: false,
});
```

This operation launches zero children. It validates the same-Mission current
`planRef`, exact round, valid `PlanningDecisionV1`, empty
`unresolvedDecisions`, and the existing `planReview` binding. A `ready` result
is the only permission to start a new review. A `pending` or terminal result is
handled as recovery; never start a second review. Missing state, stale refs,
wrong round, invalid state, or a failed `state.set` is fail-closed.

### Main-facing Plan Review bridge

When `prepare-review` returns `ready`, set the native Mission to `waiting` while
Human review is in progress, then call the Main-only
`pi_workflow_plan_review` Tool with exactly:

```json
{
  "missionId": "<native Mission ID>",
  "round": 1,
  "planRef": "<validated canonical Plan Artifact reference>"
}
```

Do not pass `planningDecision`, `planContent`, `planBody`, `planMarkdown`,
`planPath`, `feedbackText`, `feedbackBody`, `outputPath`, `workflowScript`, or
any unknown field. The bridge reads only the explicitly supplied `planRef`,
verifies it is a regular readable file, and supplies its body transiently to
the current Plannotator `planContent` input. It never searches for the latest Plan, guesses a path,
re-renders a decision, or returns the Plan body to Main. `savedPath` is not the
canonical feedback reference.

Only `approved === true` is approval. A valid `approved: false` result is an
explicit rejection only when the bridge has written its feedback to a
package-owned Feedback Artifact and returned a bounded `feedbackRef`. Missing
`approved`, cancellation, timeout, unavailable, malformed result, transport
failure, unreadable Plan Artifact, or Feedback Artifact failure is not
rejection and must not trigger automatic re-planning.

When the bridge returns, restore the native Mission to `active` only after its
result is valid. If it failed, leave the Mission in an explicit fail-closed /
`needs_decision` state. When the bridge has a `reviewId`, persist
`status: "pending"` through the Planning resource before interpreting its
terminal result. Persist only the compact status/reference values; never copy
the Plan or feedback body. Then record the terminal result. First persist pending:

```js
subagent({
  workflow: "pi-workflow.planning",
  args: { operation: "record-review", round, planRef, reviewId, status: "pending" },
  missionId,
  cwd,
  async: false,
});
```

For an approval, persist the terminal status:

```js
subagent({
  workflow: "pi-workflow.planning",
  args: { operation: "record-review", round, planRef, reviewId, status: "approved" },
  missionId,
  cwd,
  async: false,
});
```

For an explicit rejection, include only the bridge's `feedbackRef`:

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

`record-review` launches zero children. It revalidates current `planRef`,
round, `reviewId`, status transition, and the bounded feedback reference. It
does not decide what approval or rejection means. A state write failure means
that no phase advancement or re-plan succeeded.

### Re-plan and recovery

When rejection is explicit and `round < 3`, reuse the same Planning resource:

```js
subagent({
  workflow: "pi-workflow.planning",
  args: { round: round + 1, feedbackRef },
  missionId,
  cwd,
  async: false,
});
```

The omitted `operation` is still `plan`, so the Unit 5 `{ round: 1 }`
invocation remains valid. The next Planning round receives only `feedbackRef`,
never the feedback body. Round 1 may launch round 2 and round 2 may launch
round 3. A round 3 rejection stops in the canonical fail-closed/
`needs_decision` state; never launch round 4, silently reset the round, or
invoke `pi-workflow.implementation`.

For recovery, first call Planning `review-status` with the current round and
`planRef`:

```js
subagent({
  workflow: "pi-workflow.planning",
  args: { operation: "review-status", round, planRef },
  missionId,
  cwd,
  async: false,
});
```

This zero-child operation returns only Mission-bound `status`, `round`,
`planRef`, `reviewId`, and optional `feedbackRef`. Main then asks the bridge to
call Plannotator `review-status(reviewId)` and interprets the result. Pending
bindings prevent a duplicate start. Missing `reviewId`, incomplete or stale
binding, cross-Mission/cross-round/cross-Plan evidence, or an unrecoverable
start/persistence crash window fails closed without a replacement review.
Never use a latest/global result or a private Mission API.

Unit 6 completion is an approved Plan state established through
`record-review(status: "approved")`. Stop there. Do not start the
Implementation, Verification, Verification Fix, Automated Review, Code Review,
or Mission success close phases from this Skill path.

## Completion of this flow

Report the compact Planning/Plan Review result, `planRef`, review status, and
Mission ID. Do not report or relay the Plan body or feedback body. If a
prerequisite, bridge call, native child, Artifact command, or state update
fails, retain the exact failure and stop under the same protocol. A phase-run
terminal status must not be reported as pi-workflow completion.
