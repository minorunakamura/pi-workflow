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

The current Planning Flow is read-only. It ends at an explicitly approved
canonical `plan.md`. Do not start a Worker, mutate source files, verify an
implementation, run automated code review, run final Code Review, or close the
Mission as success in this flow.

## Startup gates

For each `/wf-*` kickoff, perform these checks in order:

1. Call `subagent({ action: "mission.list" })` for the current project.
2. The official `pi-subagents` v0.65.1 Mission statuses are `planned`, `active`,
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

The remaining, not-yet-migrated phases still use `pi_workflow_prepare_phase`
with validated JSON payloads. Never provide a template path, JavaScript, or an
arbitrary workflow script. Each legacy phase call uses the returned
`workflowScript` with the same `missionId` and project `cwd`.

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
Mission status from the v0.65.1 contract; do not substitute an invented status.
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

### External research

Read the Discovery result. If and only if `externalResearch.required === true`,
first confirm that the exact `pi-ketch.researcher` agent is present and
executable. Then prepare `phase: "research"` and run the fresh
`pi-ketch.researcher`. Pass the bounded questions and a durable output path.
The researcher collects evidence only and never owns product, architecture,
policy, or risk-acceptance decisions. If research is not required, do not start
it. After a Research workflow returns, normalize the Mission to native `active`
before continuing.

### Main-only Human clarification

After discovery and any required research, escalate only material uncertainties
that repository evidence and primary sources cannot resolve. Call the Main-only
`ask_user_question` tool. Continue only when `details.cancelled === false` and
at least one actual answer is present. Cancel, unavailable, malformed, or empty
answers leave the decision unresolved and stop the flow. Do not let a child call
this tool, and do not use it as a Plannotator approval fallback.

### Planning

Prepare `phase: "planning"` with the discovery/research references and resolved
Human decisions. The fresh built-in `reviewer` runs with `skill: "pi-planning"`,
returns only structured `PlanningDecisionV1`, and does not edit files. Require
these fields and relationships:

- unique acceptance-criterion, verification, WorkUnit, and decision IDs
- every referenced ID exists
- dependency-free WorkUnits use `dependsOn: []`
- non-empty `finalVerificationIds`
- valid WorkUnit write scopes
- no dependencies between parallel lane WorkUnits
- no unresolved decisions for Plan Review

The native `outputSchema` validates schema shape. Immediately after receiving
that structured result, also perform semantic cross-reference validation. If
semantic validation fails, return the exact validation errors to the
Planning reviewer and run one automatic correction at most. Revalidate the
corrected result with both gates. If it is still invalid, stop with an explicit
`planning-invalid` failure, update the Mission to `needs_decision` when owner
intervention is required, and do not call Plan Review. Never add a generic retry
framework or a second automatic correction.

Do not parse reviewer prose as a plan. `pi_workflow_plan_review` performs the
canonical schema and semantic validation again and is the approval boundary.
After a valid Planning workflow returns, normalize the Mission to native
`active` before entering the Human Plan Gate.

## Human Plan Gate

For `phase: "planning"`, `pi_workflow_prepare_phase` injects the package-owned
`PlanningDecisionSchema`; do not hand-author, replace, or edit that schema in
Main.

The planning phase's `outputSchema` must describe the complete
`PlanningDecisionV1` contract: `version`, `requestSummary`, `scope.inScope`,
`scope.outOfScope`, `acceptanceCriteria[{id,text}]`, `constraints`, `risks`,
`verification[{id,description,command,timeoutMs?}]`,
`implementation.mode`, `implementation.workUnits[{id,title,objective,dependsOn,writeScope,acceptanceCriteriaIds,focusedVerificationIds}]`,
`implementation.finalVerificationIds`, and
`unresolvedDecisions[{id,question,reason}]`. Set `additionalProperties: false`
for every object, make `workUnits` and `finalVerificationIds` non-empty, and
make `version` exactly `1`. JSON Schema cannot express all reference and
uniqueness rules; `pi_workflow_plan_review` is the authoritative semantic
validator.

Before waiting for Plan Review, set the native Mission to `waiting` with
`mission.update`; this is a Human approval wait, not a terminal workflow state.
Call `pi_workflow_plan_review` with `missionId`, the complete
`planningDecision`, and a positive `round`. The tool deterministically renders
`plan.md` and writes it under:

`.pi/pi-workflow/<missionId>/plan-r<round>.md`

It then uses only Plannotator's shared event API:

- `plannotator:request` with `action: "plan-review"`
- `plannotator:review-result`
- `plannotator:request` with `action: "review-status"` for recovery

Only an explicit boolean `approved: true` is approval. `false`, unavailable,
error, cancel, close, timeout, missing, malformed, or mismatched results are
not approval. A rejection returns its feedback to a new Planning round; first
restore the current Mission to native `active`, retain the current Mission, and
do not create a second Mission. Human rejection feedback is not an automatic
machine-invalid correction and does not consume that correction count. Keep the
re-plan loop bounded: allow at most three total Plan Review rounds, then stop
and report the last feedback for a Main/Human decision. Never auto-approve or
fall back to `ask_user_question`.

After explicit Plan approval, restore the Mission to native `active` and report
the approved plan. Step 2 must not call `mission.close`; implementation,
verification, review, and final Human Code Review remain outstanding.

If a pending review may have crossed a restart or event race, query
`review-status` using its `reviewId` before creating another review. A completed
status with explicit `approved: true` is authoritative; never duplicate a
pending browser review merely because the event was missed.

## Completion of this flow

Report the approved `planPath`, `reviewId`, Mission ID, and any feedback. Do not
start implementation or close the Mission as terminal success; those belong to
later Steps. If a phase, native child, event bridge, or capability fails, retain
the exact failure and stop under the same protocol. A phase-run terminal status
must not be reported as pi-workflow completion; only the final successful flow
may use native `mission.close`.
