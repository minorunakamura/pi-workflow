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
2. If any non-terminal Mission is active, waiting, paused, or needs a decision,
   stop. Do not resume, cancel, close, or create another Mission. Report its
   Mission ID, title, and status.
3. Call `subagent({ action: "list", capabilities: true })`. Require executable
   `scout`, `reviewer`, and `worker` rows. For this Planning Flow, `worker` is
   checked at startup even though it is not started yet. A capability-ceiling
   denial is missing capability. Do not silently switch agents or execution
   modes.
4. Check the loaded skill inventory for `pi-workflow`, `pi-planning`,
   `pi-verification`, and `ponytail-review`. Missing own Skills or the required
   Ponytail review capability is a start blocker.
5. Run `git status --porcelain` with the Main Session's minimal safety check.
   A command error or any output is a blocker. Do not create a Mission for a
   dirty tree.
6. Create exactly one explicit native Mission with
   `subagent({ action: "mission.create", mission: { title, objective } })`.
   Do not set `goal: true`. Keep the returned Mission ID and pass it explicitly
   to every later phase workflow.

A failed startup gate is fail-closed: report the exact blocker and do not use a
fallback runtime or CLI.

## Phase dispatch

Use `pi_workflow_prepare_phase` to render an allowlisted phase script. Pass only
validated JSON payloads; never provide a template path, JavaScript, or an
arbitrary workflow script. Each phase call uses the returned `workflowScript`
with the native model-facing `subagent` tool, the same `missionId`, and the
project `cwd`.

The phase workflow is sequential because its structured result is needed by the
next phase. Use a blocking native workflow invocation when the next decision is
needed immediately; do not invent a parallel scheduler.

### Discovery

Prepare `phase: "discovery"` with a task containing the request and a
`DiscoveryResultV1` JSON schema. The schema passed to the phase must be
machine-readable and reject extra fields; its essential shape is:

```json
{
  "type": "object",
  "properties": {
    "version": { "const": 1 },
    "summary": { "type": "string", "minLength": 1 },
    "entryPoints": { "type": "array", "items": { "type": "string" } },
    "affectedAreas": { "type": "array", "items": { "type": "string" } },
    "tests": { "type": "array", "items": { "type": "string" } },
    "constraints": { "type": "array", "items": { "type": "string" } },
    "risks": { "type": "array", "items": { "type": "string" } },
    "uncertainties": { "type": "array", "items": {
      "type": "object",
      "properties": {
        "id": { "type": "string", "minLength": 1 },
        "question": { "type": "string", "minLength": 1 },
        "material": { "type": "boolean" }
      },
      "required": ["id", "question", "material"],
      "additionalProperties": false
    } },
    "externalResearch": { "type": "object", "properties": {
      "required": { "type": "boolean" },
      "questions": { "type": "array", "items": { "type": "string" } }
    }, "required": ["required", "questions"], "additionalProperties": false }
  },
  "required": ["version", "summary", "entryPoints", "affectedAreas", "tests", "constraints", "risks", "uncertainties", "externalResearch"],
  "additionalProperties": false
}
```

The fresh `scout` must return structured output with:

- `version: 1`
- `summary`
- `entryPoints`
- `affectedAreas`
- `tests`
- `constraints`
- `risks`
- `uncertainties` with `id`, `question`, and `material`
- `externalResearch` with `required` and `questions`

Accept only the native structured result and its run/reference metadata. Do not
treat scout prose as a contract. Discovery is read-only.

The scout follows this CodeGraph policy: `codegraph status` first; if usable,
use `codegraph explore` for structural questions; read exact source only when
needed; otherwise use bounded `read`/`grep`/`find`/`ls`. Never run
`codegraph init`, `index`, `sync`, or `upgrade`.

### External research

Read the Discovery result. If and only if `externalResearch.required === true`,
first confirm that the exact `pi-ketch.researcher` agent is present and
executable. Then prepare `phase: "research"` and run the fresh
`pi-ketch.researcher`. Pass the bounded questions and a durable output path.
The researcher collects evidence only and never owns product, architecture,
policy, or risk-acceptance decisions. If research is not required, do not start
it.

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
- non-empty `finalVerificationIds`
- valid WorkUnit write scopes
- no dependencies between parallel lane WorkUnits
- no unresolved decisions for Plan Review

Do not parse reviewer prose as a plan. `pi_workflow_plan_review` performs the
canonical semantic validation again and is the approval boundary.

## Human Plan Gate

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
not approval. A rejection returns its feedback to a new Planning round; retain
the current Mission and do not create a second Mission. Keep the re-plan loop
bounded: allow at most three total Plan Review rounds, then stop and report the
last feedback for a Main/Human decision. Never auto-approve or fall back to
`ask_user_question`.

If a pending review may have crossed a restart or event race, query
`review-status` using its `reviewId` before creating another review. A completed
status with explicit `approved: true` is authoritative; never duplicate a
pending browser review merely because the event was missed.

## Completion of this flow

Report the approved `planPath`, `reviewId`, Mission ID, and any feedback. Do not
start implementation or close the Mission as terminal success; those belong to
later Steps. If a phase, native child, event bridge, or capability fails, retain
the exact failure and stop under the same protocol.
