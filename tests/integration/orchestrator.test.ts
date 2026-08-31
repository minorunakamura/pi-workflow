import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { Orchestrator } from "../../src/application/orchestrator.js";
import type {
  AgentExecutionRequestV1,
  StepResultV1,
} from "../../src/contracts/execution/agent-execution.js";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import { JsonlEventReader } from "../../src/adapters/persistence/read/jsonl-event-reader.js";
import { FileStateStore } from "../../src/adapters/persistence/write/file-state-store.js";
import { JsonlEventWriter } from "../../src/adapters/persistence/write/jsonl-event-writer.js";
import { createStep } from "../../src/domain/graph/step-graph.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const RUN_ID = "run-001" as RunId;
const STEP_ID = "step-001" as StepId;
const EXECUTION_ID = "exec-001" as ExecutionId;
const RUN_DIRECTORY = `.pi/runs/${RUN_ID}`;

function workflowState(stateRevision = 1): WorkflowState {
  const header = { schema_version: 1, run_id: RUN_ID, state_revision: stateRevision } as const;
  return {
    run: {
      schema_version: 1,
      run_id: RUN_ID,
      request: { id: "request-001", type: "feature" },
      status: "running",
      finalized: false,
      state_revision: stateRevision,
      graph_revision: 1,
      playbook: { initial: {}, current: {} },
      current_step: {},
      current_plan: null,
      current_changes: { relevant_change_sets: [], external_reconciliation: null },
      repository: {},
      blocked: null,
      failure: null,
      cancellation: null,
      limits: {},
      counters: {},
      telemetry: { degraded: false },
      outcome: null,
      timestamps: {},
    },
    snapshot: {
      requirement: {
        ...header,
        revision: 1,
        goal: "goal",
        scope: { in: [], out: [] },
        constraints: [],
        acceptance_criteria: [],
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
            id: STEP_ID,
            type: "implementation",
            objective: "implement",
            agent: "worker",
            skills: [],
            inputs: [],
            outputs: [],
            depends_on: [],
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
        previous_state_revision: Math.max(0, stateRevision - 1),
        created_at: "2026-08-30T03:02:10.123+09:00",
        files: [
          "requirement.yaml",
          "steps.yaml",
          "uncertainties.yaml",
          "decisions.yaml",
          "gates.yaml",
          "findings.yaml",
        ],
      },
    },
  };
}

function fixtureFor(state: WorkflowState): Record<string, string> {
  const directory = `${RUN_DIRECTORY}/state/snapshots/${state.run.state_revision}`;
  return {
    [`${RUN_DIRECTORY}/run.yaml`]: stringify(state.run),
    [`${directory}/requirement.yaml`]: stringify(state.snapshot.requirement),
    [`${directory}/steps.yaml`]: stringify(state.snapshot.steps),
    [`${directory}/uncertainties.yaml`]: stringify(state.snapshot.uncertainties),
    [`${directory}/decisions.yaml`]: stringify(state.snapshot.decisions),
    [`${directory}/gates.yaml`]: stringify(state.snapshot.gates),
    [`${directory}/findings.yaml`]: stringify(state.snapshot.findings),
    [`${directory}/manifest.json`]: JSON.stringify(state.snapshot.manifest),
  };
}

function request(): AgentExecutionRequestV1 {
  return {
    identity: {
      runId: RUN_ID,
      stepId: STEP_ID,
      executionId: EXECUTION_ID,
      agentId: "worker",
      agentVersion: "1.0.0",
    },
    objective: { objective: "implement", type: "implementation", completionCriteria: [] },
    retry: { attempt: 1, context: null },
    execution: { mode: "write", timeoutMs: 1_000, cancellationPolicy: {} },
    authority: { maximumDLevel: "D1", escalationRules: [] },
    permissions: { filesystem: [], shell: [], git: [], network: [], repositoryTargets: [] },
    skills: { required: [], optional: [] },
    tools: { resolved: [], policy: {} },
    model: { requested: "test", actual: "test", thinkingLevel: "low", allowedFallback: [] },
    context: { pack: {}, manifest: {}, artifactRefs: [] },
    outputs: { expectedArtifactTypes: [], outputContract: {} },
  };
}

function result(): StepResultV1 {
  return {
    identity: { runId: RUN_ID, stepId: STEP_ID, executionId: EXECUTION_ID },
    outcome: "completed",
    summary: "done",
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

describe("Orchestrator persistence integration", () => {
  it("commits before appending Events and reloads the committed state", async () => {
    const initial = workflowState();

    await withTempRepository(fixtureFor(initial), async (repositoryRoot) => {
      const eventWriter = new JsonlEventWriter(repositoryRoot);
      const stateStore = new FileStateStore(repositoryRoot, { eventWriter });
      const runReader = new FileRunReader(repositoryRoot);
      const step = createStep({
        id: STEP_ID,
        type: "implementation",
        objective: "implement",
        agent: "worker",
        status: "ready",
      });
      let runtimeCalls = 0;

      const outcome = await new Orchestrator({
        runReader,
        stateStore,
        agentRuntime: {
          run: async () => {
            runtimeCalls += 1;
            return result();
          },
        },
        buildRequest: async () => request(),
        recover: async (state) => state,
        reconcile: async (state) => state,
        trigger: async (state) => state,
        completion: async (state) => ({
          eligible: state.snapshot.steps.steps[0]?.status === "completed",
          blockers:
            state.snapshot.steps.steps[0]?.status === "completed" ? [] : ["STEP_INCOMPLETE"],
        }),
        schedule: async () => ({ kind: "dispatch", step }),
        postconditions: async ({ state, result: agentResult }) => ({
          ...state,
          snapshot: {
            ...state.snapshot,
            steps: {
              ...state.snapshot.steps,
              steps: state.snapshot.steps.steps.map((currentStep) => ({
                ...currentStep,
                status: "completed" as const,
                result: { summary: agentResult.summary },
              })),
            },
          },
        }),
        finalize: async ({ state, completion }) =>
          completion.eligible
            ? { ...state, run: { ...state.run, outcome: { summary: "done" } } }
            : state,
        events: async ({ after, result: agentResult }) => [
          {
            schema_version: 1,
            type: agentResult === null ? "run.completed" : "step.completed",
            timestamp: "2026-08-30T03:02:10.123+09:00",
            run_id: RUN_ID,
            source: { component: "orchestrator" },
            state_revision: after.run.state_revision,
            data: agentResult === null ? {} : { step_id: STEP_ID },
          },
        ],
      }).run(RUN_ID);

      expect(outcome).toMatchObject({ kind: "completed", iterations: 2 });
      expect(runtimeCalls).toBe(1);

      const committed = await runReader.load(RUN_ID);
      expect(committed.run).toMatchObject({
        state_revision: 3,
        status: "completed",
        finalized: true,
        outcome: { summary: "done" },
      });
      expect(committed.snapshot.steps.steps[0]).toMatchObject({
        status: "completed",
        result: { summary: "done" },
      });

      const events = await new JsonlEventReader(repositoryRoot).readAfter(RUN_ID, 0);
      expect(events.map(({ type, state_revision }) => ({ type, state_revision }))).toEqual([
        { type: "step.completed", state_revision: 2 },
        { type: "run.completed", state_revision: 3 },
      ]);
    });
  });
});
