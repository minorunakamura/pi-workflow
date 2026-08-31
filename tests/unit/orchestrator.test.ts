import { describe, expect, it } from "vitest";
import { Orchestrator, type OrchestratorDependencies } from "../../src/application/orchestrator.js";
import type {
  AgentExecutionRequestV1,
  StepResultV1,
} from "../../src/contracts/execution/agent-execution.js";
import { createStep } from "../../src/domain/graph/step-graph.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";
import type { StateStoreCommitInput } from "../../src/ports/state-store.js";
import type { SchedulerStep } from "../../src/domain/scheduling/scheduler.js";

const RUN_ID = "run-001" as RunId;
const STEP_ID = "step-001" as StepId;
const EXECUTION_ID = "exec-001" as ExecutionId;

function workflowState(stateRevision = 1, status: "ready" | "completed" = "ready"): WorkflowState {
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
            status,
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

function scheduledStep(): SchedulerStep {
  return createStep({
    id: STEP_ID,
    type: "implementation",
    objective: "implement",
    agent: "worker",
    status: "ready",
  });
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

type Harness = {
  current: WorkflowState;
  log: string[];
  dependencies: OrchestratorDependencies;
};

function harness(agentResult: unknown = result()): Harness {
  const log: string[] = [];
  let current = workflowState();
  const step = scheduledStep();
  const reader = {
    load: async () => {
      log.push("load");
      return current;
    },
  };
  const stateStore = {
    load: reader.load,
    commit: async ({ next, events }: StateStoreCommitInput) => {
      log.push("commit");
      current = next;
      if ((events?.length ?? 0) > 0) {
        log.push("event");
      }
      return next;
    },
  };

  return {
    get current() {
      return current;
    },
    log,
    dependencies: {
      runReader: reader,
      stateStore,
      agentRuntime: {
        run: async () => {
          log.push("dispatch");
          return agentResult;
        },
      },
      buildRequest: async () => request(),
      recover: async (state) => {
        log.push("recover");
        return state;
      },
      reconcile: async (state) => {
        log.push("reconcile");
        return state;
      },
      trigger: async (state) => {
        log.push("trigger");
        return state;
      },
      completion: async (state) => {
        log.push("completion");
        return { eligible: state.run.state_revision > 1, blockers: [] };
      },
      schedule: async () => {
        log.push("schedule");
        return { kind: "dispatch", step };
      },
      postconditions: async (input) => {
        log.push("postconditions");
        return input.state;
      },
      finalize: async (input) => {
        log.push("finalize");
        return input.state;
      },
      events: async ({ after }) => [
        {
          schema_version: 1,
          type: "step.completed",
          timestamp: "2026-08-30T03:02:10.123+09:00",
          run_id: RUN_ID,
          source: { component: "orchestrator" },
          state_revision: after.run.state_revision,
          data: {},
        },
      ],
    },
  };
}

describe("Orchestrator control loop", () => {
  it("preserves phase order and processes one dispatch per iteration", async () => {
    const test = harness();
    const orchestrator = new Orchestrator(test.dependencies);

    const outcome = await orchestrator.run(RUN_ID);

    expect(outcome).toMatchObject({ kind: "completed", iterations: 2 });
    expect(test.log).toEqual([
      "load",
      "recover",
      "reconcile",
      "trigger",
      "completion",
      "schedule",
      "dispatch",
      "postconditions",
      "finalize",
      "commit",
      "event",
      "load",
      "recover",
      "reconcile",
      "trigger",
      "completion",
      "finalize",
      "commit",
      "event",
    ]);
    expect(test.log.filter((entry) => entry === "dispatch")).toHaveLength(1);
    expect(test.log.filter((entry) => entry === "commit")).toHaveLength(2);
  });

  it("does not finalize, commit, or emit an invalid Agent result", async () => {
    const test = harness({});
    const orchestrator = new Orchestrator(test.dependencies);

    await expect(orchestrator.run(RUN_ID)).rejects.toThrow(/StepResultV1 validation failed/);
    expect(test.log).toEqual([
      "load",
      "recover",
      "reconcile",
      "trigger",
      "completion",
      "schedule",
      "dispatch",
    ]);
  });

  it("rejects a structurally valid result for another Execution", async () => {
    const test = harness({
      ...result(),
      identity: { runId: RUN_ID, stepId: "step-002" as StepId, executionId: EXECUTION_ID },
    });
    const orchestrator = new Orchestrator(test.dependencies);

    await expect(orchestrator.run(RUN_ID)).rejects.toThrow(/identity/);
    expect(test.log).not.toContain("postconditions");
    expect(test.log).not.toContain("finalize");
    expect(test.log).not.toContain("commit");
    expect(test.log).not.toContain("event");
  });

  it("does not finalize or commit when postconditions reject a validated result", async () => {
    const test = harness();
    test.dependencies = {
      ...test.dependencies,
      postconditions: async () => {
        test.log.push("postconditions");
        throw new Error("postcondition failed");
      },
    };
    const orchestrator = new Orchestrator(test.dependencies);

    await expect(orchestrator.run(RUN_ID)).rejects.toThrow("postcondition failed");
    expect(test.log).not.toContain("finalize");
    expect(test.log).not.toContain("commit");
    expect(test.log).not.toContain("event");
  });
});
