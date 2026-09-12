# pi-workflow basic design

## 1. Purpose

`pi-workflow` is a Planning-oriented Pi package. Its current architecture turns
one `/wf-*` request into a bounded, Human-reviewed Plan and then closes the
native Mission. This document describes the supported runtime, ownership
boundaries, and recovery rules. Runtime contracts live in the
[implementation specification](pi-workflow-implementation-spec.md); Main Session
instructions live in [the Skill](../skills/pi-workflow/SKILL.md).

## 2. Supported Planning MVP

```text
/wf-feature
/wf-bug
/wf-chore
/wf-hotfix
        ↓
Mission → Discovery → optional Research → optional Human clarification
        → Planning → Human Plan Review → approved Plan → mission.close(completed)
```

The MVP supports repository discovery, conditional external research, conditional
Human clarification, bounded planning, and explicit Plan Review. It does not
execute the approved Plan.

The following are explicitly outside the current product boundary:

- Implementation execution
- Verification and Verification Fix
- automated Review
- Ponytail
- Human Code Review
- worker execution and parallel implementation lanes
- deployment and release

These capabilities are not partial stages of the current runtime. They require a
new design decision when a future product needs them.

## 3. Architecture principles

### Thin Main

Main is the control plane. It owns request intake, Mission conflict checks,
capability checks, phase selection, named-resource invocation, Human decisions,
Plan Review, and final Mission close.

Main does not transport Artifact bodies, perform repository exploration as its
own workflow implementation, duplicate native Mission state, maintain a second
workflow engine, or parse child prose into machine state.

### Native Mission ownership

`pi-subagents` owns Mission persistence, native status, named-resource execution,
and run metadata. The package stores only its bounded Planning MVP state in that
Mission.

### Named resources

The public workflow boundary contains exactly these resources:

```text
pi-workflow.discovery
pi-workflow.research
pi-workflow.planning
```

Each is invoked in the foreground with the same Mission ID. Resource arguments
are validated at the package boundary; resource code resolves same-Mission state
and references.

### Artifact/reference separation

Large Discovery, Research, Plan, and rejection feedback bodies are file-backed
Artifacts. Mission state and Main carry references plus bounded metadata, never
those bodies. A reference is opaque to Main except where a public bridge
explicitly consumes the referenced file.

### Fail closed

Missing capabilities, malformed bounded data, stale references, missing handoffs,
child interruption, bridge errors, and invalid state stop the current flow. Main
must not invent Human answers, retry an ambiguous transition, or treat a partial
handoff as success.

## 4. Components

| Component | Responsibility |
| --- | --- |
| Main Session | Request, decisions, dispatch, review, and close |
| `pi-subagents` Mission | Durable state, native lifecycle, resource runs, run metadata |
| `pi-workflow.discovery` | Read-only repository Discovery and compact handoff |
| `pi-workflow.research` | Conditional external evidence collection |
| `pi-workflow.planning` | Bounded PlanningDecision, Plan Artifact, and review state |
| `scout` | Fresh read-only repository inspection |
| `reviewer` + `pi-planning` | Fresh read-only Planning decision |
| package Research Agent | Read-only external research with restricted Ketch access |
| Plannotator bridge | Human Plan Review request/result boundary |

## 5. Main Session responsibilities

For each command, Main:

1. checks for a conflicting non-terminal Mission;
2. checks core `scout`/`reviewer` and Skill capabilities;
3. creates exactly one native Mission with status `active`;
4. invokes Discovery, then the conditional Research and clarification branches;
5. invokes Planning and inspects its bounded review-readiness handoff;
6. enters the Main-only Plan Review loop only when the handoff is ready;
7. closes the Mission as `completed` only after approval.

Main may set native status to `waiting` while asking a Human and to
`needs_decision` when owner intervention is required. It does not copy native
status into package state.

## 6. Native Mission lifecycle

An explicit Mission is created with status `active`. Launching a named workflow
with the same `missionId` activates the Mission through native behavior. A
successful foreground workflow can leave native status `completed`; that is the
completion of that workflow run or phase, not proof that Main's whole control
flow is finished. Main continues with the same Mission ID and does not manually
normalize status between machine phases.

`waiting` represents a Human interaction. `needs_decision` represents a blocked
or ambiguous condition that the owner must resolve. Native stop, cancellation,
interruption, `failed`, and `cancelled` results are returned as-is and are not
silently retried. Only the approved Plan path performs:

```text
record-review(approved) → mission.close(completed) → STOP
```

## 7. Discovery

`pi-workflow.discovery` accepts `requestType`, `request`, and an optional bounded
`attempt`. It launches a fresh read-only `scout` and stores the complete report
as a file-backed Artifact. A separate normalization run returns only bounded
`discoveryMeta`:

- `version`, `status`
- `externalResearchRequired`
- `humanClarificationRequired`
- `uncertainties`
- `researchQuestions`

The resource persists `discoveryRef` and `discoveryMeta` in the same Mission.
Planning cannot proceed from a missing or non-`ready` Discovery handoff.

## 8. Optional Research

Main invokes `pi-workflow.research` only when Discovery sets
`externalResearchRequired` to `true`. The resource resolves Discovery state from
the same Mission, launches the package-owned fresh Research Agent, and stores a
file-backed Research Artifact plus completed `researchMeta`.

The Research Agent is read-only and may use the package's restricted Ketch
boundary for documentation, code examples, known URLs, and general web search.
It does not ask a Human, edit the repository, or make product decisions.

When external research is not required, both `researchRef` and `researchMeta`
are absent. There is no skipped Research state.

## 9. Human clarification

Discovery decides whether clarification is material. Main is the only component
that invokes `ask_user_question`, and only for the bounded uncertainty questions
returned in `discoveryMeta`. Main sets native status to `waiting`, validates a
non-cancelled bounded answer, persists `humanDecisions`, and then invokes
Planning with the same Mission ID. Empty, malformed, cancelled, or unavailable
answers fail closed.

Children never invoke Human-question or Plan Review tools.

## 10. Planning

`pi-workflow.planning` resolves the same-Mission Discovery handoff, optional
Research handoff, Human decisions, and (for later rounds) the previous rejected
feedback reference. It launches a fresh `reviewer` with `pi-planning` and the
package-owned `PlanningDecisionV1` schema.

The decision contains request summary, scope, acceptance criteria, constraints,
risks, verification commands, implementation mode, ordered WorkUnits and their
write scopes, final verification references, and unresolved decisions. Only
Human product, architecture, policy, or risk-acceptance decisions belong in
`unresolvedDecisions`; repository inspection, build, test, packaging, and
verification can resolve technical uncertainty mechanically, which belongs in
risks, verification, or WorkUnit objectives instead. The resource validates
schema, byte bounds, IDs, and cross-references. One automatic correction is
allowed for a schema-valid but semantically or byte-invalid result; a second
failure stops the flow.

The resource renders a canonical file-backed Plan from the validated decision,
persists `planningDecision` and `planRef`, and returns this bounded compact
handoff without transporting either Artifact body or the full decision:

```json
{
  "status": "completed",
  "runId": "...",
  "planRef": "...",
  "planningCorrectionCount": 0,
  "reviewReady": true,
  "unresolvedDecisions": []
}
```

When `reviewReady` is `false`, the resource keeps the package phase as
`planning` and does not create a pending binding for the current round. Main
reports the bounded decisions, sets native Mission status to `needs_decision`,
and stops without `prepare-review` or Plannotator. This is a normal owner-
decision boundary, not a Mission failure. The behavior applies to round 1 and
replan rounds. Only `reviewReady: true` enters Plan Review.

## 11. Plan Review

After the Planning readiness gate permits review, Main calls the zero-child
`prepare-review` operation with the current `planRef` and round. A successful
preparation binds the Plan in Mission state. Main then sets native status to
`waiting` and calls `pi_workflow_plan_review` with exactly `missionId`, `round`,
and `planRef`. Main never calls this operation or Plannotator while unresolved
Human decisions remain.

The bridge reads the canonical Plan file and sends it to the external Plannotator
integration. It returns a terminal approval or rejection. Main records that
terminal result exactly once with `record-review`; a rejected result must include
a file-backed `feedbackRef`.

Approval closes the Mission. A rejection on rounds 1 or 2 starts the next
Planning round with only the previous feedback reference. Round 3 rejection ends
in native `needs_decision`; round 4 does not exist.

`review-status` is a zero-child recovery/status operation. It may recover a
prepared review binding but never replaces a missing or stale binding.

## 12. State and Artifact model

### Mission state

The package-owned state keys are:

```text
version
requestType
request
phase
humanDecisions
discoveryRef
discoveryMeta
researchRef
researchMeta
planRef
planningDecision
planReview
```

All fields except `version` are optional at the state-schema level and appear
only when relevant. The phase is one of `discovery`, `research`, `planning`, or
`plan-review`. Native Mission status is not duplicated here.

`planReview` binds `status`, `round`, `planRef`, and terminal `reviewId` or
`feedbackRef` as applicable. The state and resource argument schemas enforce
reference size, JSON size/depth, text bounds, and cross-reference validity.

### File-backed Artifacts

| Artifact | State reference |
| --- | --- |
| Discovery report | `discoveryRef` |
| Research report | `researchRef` |
| canonical Plan | `planRef` |
| rejected-review feedback | `planReview.feedbackRef` |

Only compact metadata is relayed to Main. A resource or bridge reads an Artifact
from its explicit reference when its contract permits it.

## 13. Failure and recovery boundaries

- Startup conflict: report the existing Mission and stop.
- Capability or argument failure: do not create an alternate execution path.
- Resource failure or incomplete handoff: fail closed; keep the native failure
  context available for owner intervention.
- Human cancellation or malformed input: do not invent a decision.
- Plan Review bridge failure: it is neither approval nor rejection.
- Native stop/interruption: return the native result and do not retry blindly.
- Rejected Plan: carry only the validated `feedbackRef` into the next round.

The flow has no general transaction spanning native Mission state, child runs,
files, and the external review system. Recovery therefore relies on explicit
references, binding checks, and the native `needs_decision` boundary.

## 14. Validation strategy

The deterministic layer validates TypeBox structure, semantic cross-references,
UTF-8 and serialized JSON bounds, reference shapes, and the Plan Review binding.
Resource execution repeats the relevant checks at the resource boundary so a
child result cannot bypass package-owned contracts.

The test suite covers core contracts, resource scripts, runtime bridges, command
registration, package contents, and packed resources. `pnpm validate:native` is a
small native Pi smoke check for extension loading and the four command names; it
is not a full Mission or workflow test.

## 15. Explicitly deferred scope

The current product intentionally does not define runtime behavior for
Implementation, Verification, automated Review, parallel execution, operational
monitoring, or deployment/release. The short
[roadmap](pi-workflow-roadmap.md) records only this boundary; each addition needs
its own design decision before implementation.
