import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
} from "pi-subagents/delegation";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { FileArtifactStore } from "../../src/adapters/persistence/write/file-artifact-store.js";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import { FileStateStore } from "../../src/adapters/persistence/write/file-state-store.js";
import { PiSubagentsAdapter } from "../../src/adapters/pi/pi-subagents-adapter.js";
import {
  buildContext,
  type ContextBuildResult,
} from "../../src/application/context/context-builder.js";
import { Orchestrator, type OrchestratorRunResult } from "../../src/application/orchestrator.js";
import {
  ResumeLifecycle,
  type ResumeFreshnessPhase,
} from "../../src/application/recovery/resume-lifecycle.js";
import type {
  AgentExecutionRequestV1,
  StepResultV1,
} from "../../src/contracts/execution/agent-execution.js";
import type { ArtifactRef } from "../../src/ports/artifact-store.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import { selectNextStep } from "../../src/domain/scheduling/scheduler.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";
import type { RepositoryFixture } from "../fixtures/temp-repository.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const RUN_ID = "run-001" as RunId;
const FIRST_STEP_ID = "step-001" as StepId;
const SECOND_STEP_ID = "step-002" as StepId;
const FIRST_EXECUTION_ID = "exec-001" as ExecutionId;
const SECOND_EXECUTION_ID = "exec-002" as ExecutionId;
const PRIOR_ARTIFACT_PATH = "research/prior-exec-001.md";
const CREATED_AT = "2026-08-30T03:02:10.123+09:00";
const STATE_FILES = [
  "requirement.yaml",
  "steps.yaml",
  "uncertainties.yaml",
  "decisions.yaml",
  "gates.yaml",
  "findings.yaml",
] as const;

function initialState(): WorkflowState {
  const header = {
    schema_version: 1 as const,
    run_id: RUN_ID,
    state_revision: 1,
  };
  const priorArtifact: ArtifactRef = {
    runId: RUN_ID,
    path: PRIOR_ARTIFACT_PATH,
    status: "complete",
  };

  return {
    run: {
      ...header,
      request: { id: "request-001", type: "feature" },
      status: "blocked",
      finalized: false,
      graph_revision: 1,
      playbook: { initial: { id: "feature", version: 1 }, current: { id: "feature", version: 1 } },
      current_step: { id: SECOND_STEP_ID, status: "ready" },
      current_plan: { applicability: { status: "current" } },
      current_changes: { relevant_change_sets: [], external_reconciliation: null },
      repository: { freshness: "unknown" },
      blocked: { reason: "awaiting-resume" },
      failure: null,
      cancellation: null,
      limits: {},
      counters: {},
      telemetry: { degraded: false },
      outcome: null,
      timestamps: { created_at: CREATED_AT },
    },
    snapshot: {
      requirement: {
        ...header,
        revision: 1,
        goal: "continue from persisted workflow state",
        scope: { in: ["workflow"], out: [] },
        constraints: [],
        acceptance_criteria: [{ id: "AC-001", status: "open" }],
        non_goals: [],
        supplied_evidence: [],
        assumptions: [],
        open_questions: [],
      },
      steps: {
        ...header,
        graph_revision: 1,
        steps: [
          {
            id: FIRST_STEP_ID,
            type: "research",
            objective: "collect prior evidence",
            agent: "researcher",
            skills: [],
            inputs: [],
            outputs: [],
            depends_on: [],
            completion_criteria: [],
            status: "completed",
            blocked_by: [],
            result: {
              outcome: "completed",
              summary: "prior step completed before the resume",
              artifacts: [priorArtifact],
            },
          },
          {
            id: SECOND_STEP_ID,
            type: "planning",
            objective: "continue using the persisted handoff",
            agent: "planner",
            skills: [],
            inputs: [],
            outputs: [],
            depends_on: [FIRST_STEP_ID],
            completion_criteria: [],
            status: "ready",
            blocked_by: [],
            result: null,
          },
        ],
      },
      uncertainties: { ...header, uncertainties: [] },
      decisions: { ...header, decisions: [] },
      gates: { ...header, gates: [] },
      findings: { ...header, findings: [] },
      manifest: {
        ...header,
        previous_state_revision: 0,
        created_at: CREATED_AT,
        files: STATE_FILES,
      },
    },
  };
}

function artifactContents(): string {
  return `---
schema_version: 1
run_id: ${RUN_ID}
step_id: ${FIRST_STEP_ID}
execution_id: ${FIRST_EXECUTION_ID}
execution_state_revision: 1
agent:
  id: researcher
  version: 1
artifact:
  type: research
  status: complete
created_at: "${CREATED_AT}"
skills: []
---
Persisted research evidence for the subsequent Step.
`;
}

function fixtureFor(state: WorkflowState): RepositoryFixture {
  const directory = `.pi/runs/${RUN_ID}/state/snapshots/${state.run.state_revision}`;
  return {
    [`.pi/runs/${RUN_ID}/run.yaml`]: stringify(state.run),
    [`${directory}/requirement.yaml`]: stringify(state.snapshot.requirement),
    [`${directory}/steps.yaml`]: stringify(state.snapshot.steps),
    [`${directory}/uncertainties.yaml`]: stringify(state.snapshot.uncertainties),
    [`${directory}/decisions.yaml`]: stringify(state.snapshot.decisions),
    [`${directory}/gates.yaml`]: stringify(state.snapshot.gates),
    [`${directory}/findings.yaml`]: stringify(state.snapshot.findings),
    [`${directory}/manifest.json`]: JSON.stringify(state.snapshot.manifest),
    [`.pi/runs/${RUN_ID}/${PRIOR_ARTIFACT_PATH}`]: artifactContents(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function persistedArtifact(step: WorkflowState["snapshot"]["steps"]["steps"][number]): ArtifactRef {
  const artifacts = step.result?.artifacts;
  const value = Array.isArray(artifacts) ? artifacts[0] : undefined;
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    typeof value.path !== "string" ||
    value.status !== "complete"
  ) {
    throw new Error(`Missing persisted Artifact for ${step.id}`);
  }
  return { runId: value.runId as RunId, path: value.path, status: "complete" };
}

function requestFor(context: ContextBuildResult): AgentExecutionRequestV1 {
  return {
    identity: {
      runId: RUN_ID,
      stepId: SECOND_STEP_ID,
      executionId: SECOND_EXECUTION_ID,
      agentId: "planner",
      agentVersion: "1.0.0",
    },
    objective: {
      objective: "continue using the persisted handoff",
      type: "planning",
      completionCriteria: [],
    },
    retry: { attempt: 1, context: null },
    execution: { mode: "read-only", timeoutMs: 1_000, cancellationPolicy: {} },
    authority: { maximumDLevel: "D1", escalationRules: [] },
    permissions: {
      filesystem: [],
      shell: [],
      git: [],
      network: [],
      repositoryTargets: [],
    },
    skills: { required: [], optional: [] },
    tools: { resolved: [], policy: {} },
    model: {
      requested: "test-model",
      actual: "test-model",
      thinkingLevel: "low",
      allowedFallback: [],
    },
    context: {
      pack: context.pack,
      manifest: context.manifest,
      artifactRefs: context.artifactRefs,
    },
    outputs: { expectedArtifactTypes: [], outputContract: {} },
  };
}

function completedResult(): StepResultV1 {
  return {
    identity: {
      runId: RUN_ID,
      stepId: SECOND_STEP_ID,
      executionId: SECOND_EXECUTION_ID,
    },
    outcome: "completed",
    mode: "read-only",
    summary: "subsequent Step completed from persisted handoff",
    artifacts: [],
    uncertainty_candidates: [],
    decision_requests: [],
    requirement_candidates: { acceptance_criteria: [], constraints: [], assumptions: [] },
    finding_candidates: [],
    finding_rechecks: [],
    plan_deviations: [],
    skill_requests: [],
    execution_checks: [],
    observations: [],
    blocked: null,
    failure: null,
    runtime: {},
  };
}

function schedulerSteps(state: WorkflowState) {
  return state.snapshot.steps.steps.map((step) => ({
    id: step.id,
    type: step.type,
    objective: step.objective,
    agent: step.agent,
    skills: [],
    inputs: [],
    outputs: [],
    dependsOn: step.depends_on as readonly StepId[],
    completionCriteria: [],
    status: step.status,
    blockedBy: step.blocked_by as readonly string[],
    result: step.result,
    origin: "base" as const,
  }));
}

async function resumeAndContinue(repositoryRoot: string): Promise<{
  result: OrchestratorRunResult;
  requests: readonly AgentExecutionRequestV1[];
  delegations: readonly SubagentDelegationRequest[];
  state: WorkflowState;
}> {
  const reader = new FileRunReader(repositoryRoot);
  const stateStore = new FileStateStore(repositoryRoot);
  const artifactStore = new FileArtifactStore(repositoryRoot);
  const resumeFreshness: ResumeFreshnessPhase = (state) => ({
    ...state,
    run: { ...state.run, repository: { ...state.run.repository, freshness: "fresh" } },
  });
  const lifecycle = new ResumeLifecycle({
    runReader: reader,
    stateStore,
    recheckRepositoryAndFreshness: resumeFreshness,
  });
  const resumed = await lifecycle.resume(RUN_ID);
  expect(resumed.run.status).toBe("running");

  const requests: AgentExecutionRequestV1[] = [];
  const events = createEventBus();
  const delegations: SubagentDelegationRequest[] = [];
  events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
    const delegation = payload as SubagentDelegationRequest;
    delegations.push(delegation);
    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      requestId: delegation.requestId,
      ownerRunId: delegation.ownerRunId,
      nodeId: delegation.nodeId,
      status: "completed",
      result: { kind: "structured", value: completedResult() },
    } satisfies SubagentDelegationResponse);
  });

  const runResult = await new Orchestrator({
    runReader: reader,
    stateStore,
    agentRuntime: new PiSubagentsAdapter({ events }, { cwd: repositoryRoot }),
    buildRequest: async ({ state, step }) => {
      if (step.id !== SECOND_STEP_ID) throw new Error(`Unexpected Step ${step.id}`);
      const previous = state.snapshot.steps.steps.find(({ id }) => id === FIRST_STEP_ID);
      if (previous === undefined) throw new Error("Persisted prior Step is missing");
      const priorRef = persistedArtifact(previous);
      const priorArtifact = await artifactStore.read(priorRef);
      const context = buildContext({
        budget: 20,
        requirementRevision: state.snapshot.requirement.revision,
        decisionRefs: state.snapshot.decisions.decisions
          .filter(({ status }) => status === "resolved")
          .map(({ id }) => id),
        uncertaintyRefs: state.snapshot.uncertainties.uncertainties
          .filter(({ status }) => status === "resolved")
          .map(({ id }) => id),
        candidates: [
          {
            ref: "requirement",
            content: state.snapshot.requirement,
            priority: "authoritative-state",
            estimatedTokens: 1,
          },
          {
            ref: "current-plan",
            content: state.run.current_plan ?? {},
            priority: "current-plan",
            estimatedTokens: 1,
          },
          {
            ref: "previous-step",
            content: previous,
            priority: "current-evidence",
            estimatedTokens: 1,
          },
          {
            ref: "prior-artifact",
            content: priorArtifact.body,
            priority: "required-artifact",
            artifactRef: priorRef.path,
            estimatedTokens: 1,
          },
        ],
      });
      const request = requestFor(context);
      requests.push(request);
      return request;
    },
    completion: async (state) => {
      const completed = state.snapshot.steps.steps.some(
        (step) => step.id === SECOND_STEP_ID && step.status === "completed",
      );
      return { eligible: completed, blockers: completed ? [] : ["STEP_INCOMPLETE"] };
    },
    schedule: async (state) => selectNextStep({ steps: schedulerSteps(state) }),
    postconditions: async ({ state, result, step }) => ({
      ...state,
      run: {
        ...state.run,
        status: "running",
        current_step: {
          id: step.id,
          execution_id: result.identity.executionId,
          status: result.outcome,
        },
      },
      snapshot: {
        ...state.snapshot,
        steps: {
          ...state.snapshot.steps,
          steps: state.snapshot.steps.steps.map((current) =>
            current.id === step.id
              ? {
                  ...current,
                  status: "completed" as const,
                  result: {
                    outcome: result.outcome,
                    summary: result.summary,
                    artifacts: result.artifacts,
                  },
                }
              : current,
          ),
        },
      },
    }),
    finalize: async ({ state, completion }) =>
      completion.eligible
        ? {
            ...state,
            run: {
              ...state.run,
              outcome: {
                status: "completed",
                summary: "resumed without conversation history",
              },
            },
          }
        : state,
    artifactReader: artifactStore,
    events: async () => [],
    fixCycle: false,
    maxIterations: 3,
  }).run(RUN_ID);

  return { result: runResult, requests, delegations, state: await reader.load(RUN_ID) };
}

describe("Context and conversation independence E2E", () => {
  it("resumes and continues using only persisted State and Artifact handoff", async () => {
    await withTempRepository(fixtureFor(initialState()), async (repositoryRoot) => {
      const { result, requests, delegations, state } = await resumeAndContinue(repositoryRoot);

      expect(result).toMatchObject({ kind: "completed", iterations: 2 });
      expect(state.run).toMatchObject({
        status: "completed",
        finalized: true,
        outcome: { summary: "resumed without conversation history" },
      });
      expect(state.snapshot.steps.steps.find(({ id }) => id === SECOND_STEP_ID)).toMatchObject({
        status: "completed",
        result: { summary: "subsequent Step completed from persisted handoff" },
      });

      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.context.pack).toMatchObject({
        requirement: expect.objectContaining({ goal: "continue from persisted workflow state" }),
        "previous-step": expect.objectContaining({
          result: expect.objectContaining({ summary: "prior step completed before the resume" }),
        }),
      });
      expect(request.context.pack["prior-artifact"]).toContain(
        "Persisted research evidence for the subsequent Step.",
      );
      expect(request.context.artifactRefs).toEqual([PRIOR_ARTIFACT_PATH]);
      expect(request).not.toHaveProperty("chatHistory");
      expect(JSON.stringify(request.context)).not.toMatch(/conversation|chat history/i);

      expect(delegations).toHaveLength(1);
      expect(delegations[0]).toMatchObject({ context: "fresh" });
      expect(delegations[0]!.task).toContain(
        "Persisted research evidence for the subsequent Step.",
      );
      expect(delegations[0]!.task).not.toMatch(/conversation|chat history/i);
    });
  });
});
