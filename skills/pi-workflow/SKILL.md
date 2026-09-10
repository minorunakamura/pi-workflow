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

Plan Review remains a Main-only Unit 6 concern. Do not migrate or invoke the
current Plan Review tool as part of Unit 5. Unit 6 will replace its legacy
full-decision/full-path interface with the small `missionId` + `round` +
`planRef` contract and will own explicit Plannotator approval.

## Completion of this flow

Report the compact Planning result, `planRef`, and Mission ID. Do not report or
relay the Plan body. Do not start Plan Review, Implementation, Verification,
Review, or close the Mission; those belong to later Units. If a prerequisite,
native child, Artifact command, or state update fails, retain the exact failure
and stop under the same protocol. A phase-run terminal status must not be
reported as pi-workflow completion.
