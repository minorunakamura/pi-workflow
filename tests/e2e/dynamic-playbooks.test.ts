import { describe, expect, it } from "vitest";
import {
  FakeAgentRuntime,
  type FakeAgentRuntimeFixture,
} from "../../src/adapters/fake-agent-runtime.js";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import { JsonlEventReader } from "../../src/adapters/persistence/read/jsonl-event-reader.js";
import { FileStateStore } from "../../src/adapters/persistence/write/file-state-store.js";
import { JsonlEventWriter } from "../../src/adapters/persistence/write/jsonl-event-writer.js";
import { Orchestrator } from "../../src/application/orchestrator.js";
import {
  type AgentExecutionRequestV1,
  type JsonObject,
  type StepResultV1,
} from "../../src/contracts/execution/agent-execution.js";
import {
  type DomainEvent,
  type DomainEventDraft,
  type EventType,
} from "../../src/contracts/events/event.js";
import type { RequirementSnapshotV1 } from "../../src/contracts/state/workflow-state.js";
import {
  addDynamicStep,
  addStep,
  createStep,
  createStepGraph,
  obsoleteStepInGraph,
  transitionStepInGraph,
  type Step,
  type StepGraph,
  type StepStatus,
  type StepType,
} from "../../src/domain/graph/step-graph.js";
import { createDecision, transitionDecision } from "../../src/domain/decisions/decision.js";
import {
  evaluatePlanApplicability,
  type PlanApplicabilityStatus,
} from "../../src/domain/freshness/freshness.js";
import { createRequirement, reviseRequirement } from "../../src/domain/requirements/requirement.js";
import type { SchedulerStep } from "../../src/domain/scheduling/scheduler.js";
import { selectNextStep } from "../../src/domain/scheduling/scheduler.js";
import type {
  DecisionId,
  ExecutionId,
  GateId,
  RunId,
  StepId,
} from "../../src/domain/primitives/ids.js";
import {
  evaluateCompletion,
  type CompletionEvaluation,
} from "../../src/evaluation/completion-evaluator.js";
import { AGENT_DEFINITIONS, type AgentId } from "../../src/agents/definitions.js";
import type { PlaybookId } from "../../src/playbooks/definitions.js";
import type { AgentRuntime } from "../../src/ports/agent-runtime.js";
import type { StateStore, StateStoreCommitInput } from "../../src/ports/state-store.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";
import { withTempRepository, type RepositoryFixture } from "../fixtures/temp-repository.js";

const RUN_ID = "run-001" as RunId;
const CREATED_AT = "2026-08-30T03:02:10.123+09:00";
const INITIAL_PLAYBOOK_VERSION = "1.0.0";
const GATE_ID = "G-001" as GateId;

function step(
  id: string,
  type: StepType,
  agent: AgentId,
  dependsOn: readonly StepId[] = [],
  status: StepStatus = "ready",
): Step {
  return createStep({
    id: id as StepId,
    type,
    objective: id,
    agent,
    dependsOn,
    status,
  });
}

function stateStep(stepValue: Step, result: JsonObject | null = null) {
  return {
    id: stepValue.id,
    type: stepValue.type,
    objective: stepValue.objective,
    agent: stepValue.agent,
    skills: [],
    inputs: [],
    outputs: [],
    depends_on: stepValue.dependsOn,
    completion_criteria: [],
    status: stepValue.status,
    blocked_by: stepValue.blockedBy,
    result,
    origin: stepValue.origin,
    ...(stepValue.trigger === undefined ? {} : { trigger: stepValue.trigger }),
    ...(stepValue.skipReason === undefined ? {} : { skip_reason: stepValue.skipReason }),
    ...(stepValue.obsolete === undefined ? {} : { obsolete: stepValue.obsolete }),
  };
}

function initialState(
  graph: StepGraph,
  playbook: PlaybookId,
  decisions: readonly {
    id: DecisionId;
    class: "D1" | "D2" | "D3";
    status: "pending" | "resolved" | "superseded";
  }[] = [],
): WorkflowState {
  const header = { schema_version: 1 as const, run_id: RUN_ID, state_revision: 1 };
  const selectedPlaybook = { id: playbook, version: INITIAL_PLAYBOOK_VERSION };

  return {
    run: {
      ...header,
      request: { id: "request-001", type: playbook },
      status: "running",
      finalized: false,
      graph_revision: graph.graphRevision,
      playbook: { initial: selectedPlaybook, current: selectedPlaybook },
      current_step: {},
      current_plan: { version: 1, applicability: { status: "current" } },
      current_changes: { relevant_change_sets: [], external_reconciliation: null },
      repository: { classification: "clean", resolution: "clear" },
      blocked: null,
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
        goal: "dynamic fake E2E",
        scope: { in: [], out: [] },
        constraints: [{ id: "C-001", description: "preserve the Run" }],
        acceptance_criteria: [{ id: "AC-001", description: "complete the workflow" }],
        non_goals: [],
        supplied_evidence: [],
        assumptions: [],
        open_questions: [],
      },
      steps: {
        ...header,
        graph_revision: graph.graphRevision,
        steps: graph.steps.map((stepValue) => stateStep(stepValue)),
      },
      uncertainties: { ...header, uncertainties: [] },
      decisions: { ...header, decisions },
      gates: {
        ...header,
        gates: [{ id: GATE_ID, type: "completion", status: "passed" }],
      },
      findings: { ...header, findings: [] },
      manifest: {
        ...header,
        previous_state_revision: 0,
        created_at: CREATED_AT,
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

function fixtureFor(state: WorkflowState): RepositoryFixture {
  const directory = `.pi/runs/${RUN_ID}/state/snapshots/${state.run.state_revision}`;
  return {
    [`.pi/runs/${RUN_ID}/run.yaml`]: JSON.stringify(state.run),
    [`${directory}/requirement.yaml`]: JSON.stringify(state.snapshot.requirement),
    [`${directory}/steps.yaml`]: JSON.stringify(state.snapshot.steps),
    [`${directory}/uncertainties.yaml`]: JSON.stringify(state.snapshot.uncertainties),
    [`${directory}/decisions.yaml`]: JSON.stringify(state.snapshot.decisions),
    [`${directory}/gates.yaml`]: JSON.stringify(state.snapshot.gates),
    [`${directory}/findings.yaml`]: JSON.stringify(state.snapshot.findings),
    [`${directory}/manifest.json`]: JSON.stringify(state.snapshot.manifest),
  };
}

function graphStepToSchedulerStep(stepValue: Step): SchedulerStep {
  return stepValue;
}

function outcomeRecord(result: StepResultV1): JsonObject {
  return { outcome: result.outcome, summary: result.summary };
}

type ScenarioContext = Readonly<{
  getGraph: () => StepGraph;
  setGraph: (graph: StepGraph) => void;
  results: Map<StepId, JsonObject>;
  requiredById: ReadonlyMap<StepId, boolean>;
  recordResult: (
    state: WorkflowState,
    step: SchedulerStep,
    result: StepResultV1,
    status?: StepStatus,
  ) => WorkflowState;
  sync: (state: WorkflowState) => WorkflowState;
}>;

type Scenario = Readonly<{
  graph: StepGraph;
  initial: WorkflowState;
  runtime: AgentRuntime;
  requiredById?: ReadonlyMap<StepId, boolean>;
  completion: (state: WorkflowState, context: ScenarioContext) => CompletionEvaluation;
  recover?: (
    state: WorkflowState,
    context: ScenarioContext,
  ) => WorkflowState | Promise<WorkflowState>;
  trigger?: (
    state: WorkflowState,
    context: ScenarioContext,
  ) => WorkflowState | Promise<WorkflowState>;
  postconditions?: (
    input: {
      state: WorkflowState;
      result: StepResultV1;
      step: SchedulerStep;
    },
    context: ScenarioContext,
  ) => WorkflowState | Promise<WorkflowState>;
  afterCommit?: (state: WorkflowState, context: ScenarioContext) => void;
  summary: string;
}>;

type ScenarioRun = Readonly<{
  result: Awaited<ReturnType<Orchestrator["run"]>>;
  state: WorkflowState;
  events: readonly DomainEvent[];
  history: readonly WorkflowState[];
  requests: readonly AgentExecutionRequestV1[];
  context: ScenarioContext;
}>;

function syncGraph(
  state: WorkflowState,
  graph: StepGraph,
  results: ReadonlyMap<StepId, JsonObject>,
): WorkflowState {
  return {
    ...state,
    run: { ...state.run, graph_revision: graph.graphRevision },
    snapshot: {
      ...state.snapshot,
      steps: {
        ...state.snapshot.steps,
        graph_revision: graph.graphRevision,
        steps: graph.steps.map((stepValue) =>
          stateStep(stepValue, results.get(stepValue.id) ?? null),
        ),
      },
    },
  };
}

function statusOf(state: WorkflowState, stepId: StepId): StepStatus | undefined {
  return state.snapshot.steps.steps.find(({ id }) => id === stepId)?.status;
}

function completed(state: WorkflowState, stepId: StepId): boolean {
  return statusOf(state, stepId) === "completed";
}

function completionFor(
  state: WorkflowState,
  context: ScenarioContext,
  options: Readonly<{
    planRequired?: boolean;
    verificationStep?: StepId;
    reviewStep?: StepId;
  }> = {},
): CompletionEvaluation {
  const verification =
    options.verificationStep === undefined
      ? { required: false as const }
      : {
          required: true as const,
          present: completed(state, options.verificationStep),
          freshness: "fresh" as const,
          result: "passed" as const,
        };
  const review =
    options.reviewStep === undefined
      ? { required: false as const }
      : {
          required: true as const,
          present: completed(state, options.reviewStep),
          freshness: "fresh" as const,
          result: "clean" as const,
          complete: true,
          findings: [],
        };

  return evaluateCompletion({
    steps: context.getGraph().steps.map((stepValue) => ({
      status: stepValue.status,
      required: context.requiredById.get(stepValue.id) ?? true,
      skipAuthorized: stepValue.status === "skipped",
      ...(stepValue.obsolete === undefined ? {} : { obsolete: stepValue.obsolete }),
    })),
    requirement: {
      acceptanceCriteria: [{ status: "satisfied" }],
      constraints: [{ status: "respected" }],
    },
    plan: options.planRequired
      ? {
          required: true,
          applicability: state.run.current_plan?.applicability?.status ?? "unknown",
        }
      : { required: false },
    implementation: { reconciled: true, currentChangesExplained: true },
    repository: { classification: "clean", resolution: "clear" },
    verification,
    review,
    controlState: {
      uncertainties: [],
      decisions: state.snapshot.decisions.decisions.map(({ status }) => ({ status })),
      gates: state.snapshot.gates.gates.map(({ status }) => ({ status })),
      terminalError: false,
    },
  });
}

function eventDraft(type: EventType, stateRevision: number, data: JsonObject): DomainEventDraft {
  return {
    schema_version: 1,
    type,
    timestamp: CREATED_AT,
    run_id: RUN_ID,
    source: { component: "dynamic-fake-e2e" },
    state_revision: stateRevision,
    data,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function playbookId(state: WorkflowState): string | undefined {
  return stringValue(state.run.playbook.current.id);
}

function planStatus(state: WorkflowState): PlanApplicabilityStatus | undefined {
  return state.run.current_plan?.applicability?.status;
}

function eventsFor(
  before: WorkflowState,
  after: WorkflowState,
  result: StepResultV1 | null,
  step: SchedulerStep | null,
): readonly DomainEventDraft[] {
  const events: DomainEventDraft[] = [];
  const beforeSteps = new Map(
    before.snapshot.steps.steps.map((stepValue) => [stepValue.id, stepValue]),
  );

  for (const current of after.snapshot.steps.steps) {
    const previous = beforeSteps.get(current.id);
    if (previous === undefined) {
      events.push(
        eventDraft("graph.step-added", after.run.state_revision, { step_id: current.id }),
      );
    } else if (previous.status !== "skipped" && current.status === "skipped") {
      events.push(eventDraft("step.skipped", after.run.state_revision, { step_id: current.id }));
    }
  }

  if (playbookId(before) !== playbookId(after)) {
    events.push(
      eventDraft("playbook.switched", after.run.state_revision, {
        from: playbookId(before) ?? "unknown",
        to: playbookId(after) ?? "unknown",
      }),
    );
  }
  if (before.snapshot.requirement.revision !== after.snapshot.requirement.revision) {
    events.push(
      eventDraft("request.amended", after.run.state_revision, {
        revision: after.snapshot.requirement.revision,
      }),
    );
    events.push(
      eventDraft("requirement.revised", after.run.state_revision, {
        revision: after.snapshot.requirement.revision,
      }),
    );
  }
  if (planStatus(before) !== planStatus(after)) {
    events.push(
      eventDraft("plan.applicability-changed", after.run.state_revision, {
        from: planStatus(before) ?? "unknown",
        to: planStatus(after) ?? "unknown",
      }),
    );
  }

  if (result !== null && step !== null) {
    const type =
      result.outcome === "completed"
        ? "step.completed"
        : result.outcome === "blocked"
          ? "step.blocked"
          : "step.failed";
    events.push(
      eventDraft(type, after.run.state_revision, {
        step_id: step.id,
        outcome: result.outcome,
      }),
    );
  }
  if (before.run.status !== after.run.status) {
    if (after.run.status === "blocked") {
      events.push(eventDraft("run.blocked", after.run.state_revision, {}));
    } else if (before.run.status === "blocked" && after.run.status === "running") {
      events.push(eventDraft("run.resumed", after.run.state_revision, {}));
    } else if (after.run.status === "completed") {
      events.push(eventDraft("run.completed", after.run.state_revision, {}));
    }
  }

  const beforeDecisions = new Map(
    before.snapshot.decisions.decisions.map((decision) => [decision.id, decision.status]),
  );
  for (const decision of after.snapshot.decisions.decisions) {
    if (beforeDecisions.get(decision.id) === "pending" && decision.status === "resolved") {
      events.push(
        eventDraft("decision.resolved", after.run.state_revision, { decision_id: decision.id }),
      );
    }
  }
  return events;
}

async function runScenario(scenario: Scenario): Promise<ScenarioRun> {
  return withTempRepository(fixtureFor(scenario.initial), async (repositoryRoot) => {
    let graph = scenario.graph;
    let current = scenario.initial;
    const history: WorkflowState[] = [current];
    const requests: AgentExecutionRequestV1[] = [];
    const results = new Map<StepId, JsonObject>();
    const requiredById = scenario.requiredById ?? new Map<StepId, boolean>();
    let executionNumber = 0;

    const context: ScenarioContext = {
      getGraph: () => graph,
      setGraph: (next) => {
        graph = next;
      },
      results,
      requiredById,
      recordResult: (state, dispatchedStep, result, status = result.outcome) => {
        let nextGraph = graph;
        const currentStep = nextGraph.steps.find(({ id }) => id === dispatchedStep.id);
        if (currentStep?.status === "ready") {
          nextGraph = transitionStepInGraph(nextGraph, dispatchedStep.id, "running");
        }
        nextGraph = transitionStepInGraph(nextGraph, dispatchedStep.id, status);
        graph = nextGraph;
        results.set(dispatchedStep.id, outcomeRecord(result));
        return syncGraph(
          {
            ...state,
            run: {
              ...state.run,
              current_step: {
                id: dispatchedStep.id,
                execution_id: result.identity.executionId,
                status: result.outcome,
              },
            },
          },
          graph,
          results,
        );
      },
      sync: (state) => syncGraph(state, graph, results),
    };

    const fileReader = new FileRunReader(repositoryRoot);
    const fileStore = new FileStateStore(repositoryRoot, {
      eventWriter: new JsonlEventWriter(repositoryRoot),
    });
    const stateStore: StateStore = {
      load: (runId) => fileReader.load(runId),
      commit: async (input: StateStoreCommitInput) => {
        const committed = await fileStore.commit(input);
        current = committed;
        history.push(current);
        scenario.afterCommit?.(current, context);
        return committed;
      },
    };

    const orchestrator = new Orchestrator({
      runReader: fileReader,
      stateStore,
      agentRuntime: scenario.runtime,
      buildRequest: async ({ step: dispatchedStep }): Promise<AgentExecutionRequestV1> => {
        const definition = AGENT_DEFINITIONS.find(({ id }) => id === dispatchedStep.agent);
        if (definition === undefined) {
          throw new Error(`Missing Agent definition for ${dispatchedStep.agent}`);
        }
        executionNumber += 1;
        const executionId = `exec-${String(executionNumber).padStart(3, "0")}` as ExecutionId;
        const request: AgentExecutionRequestV1 = {
          identity: {
            runId: RUN_ID,
            stepId: dispatchedStep.id,
            executionId,
            agentId: dispatchedStep.agent,
            agentVersion: definition.version,
          },
          objective: {
            objective: dispatchedStep.objective,
            type: dispatchedStep.type,
            completionCriteria: [],
          },
          retry: { attempt: 1, context: null },
          execution: { mode: definition.mode, timeoutMs: 1_000, cancellationPolicy: {} },
          authority: { maximumDLevel: definition.maximumNormalAuthority, escalationRules: [] },
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
            requested: "fake",
            actual: "fake",
            thinkingLevel: "low",
            allowedFallback: [],
          },
          context: { pack: {}, manifest: {}, artifactRefs: [] },
          outputs: { expectedArtifactTypes: [], outputContract: {} },
        };
        requests.push(request);
        return request;
      },
      recover: async (state) => scenario.recover?.(state, context) ?? state,
      reconcile: async (state) => state,
      trigger: async (state) => scenario.trigger?.(state, context) ?? state,
      completion: async (state) => scenario.completion(state, context),
      schedule: async () => selectNextStep({ steps: graph.steps.map(graphStepToSchedulerStep) }),
      postconditions: async ({ state, result, step: dispatchedStep }) =>
        scenario.postconditions?.({ state, result, step: dispatchedStep }, context) ??
        context.recordResult(state, dispatchedStep, result),
      finalize: async ({ state, completion }) =>
        completion.eligible
          ? {
              ...state,
              run: {
                ...state.run,
                outcome: { status: "completed", summary: scenario.summary },
              },
            }
          : state,
      events: async ({ before, after, result, step }) => eventsFor(before, after, result, step),
      maxIterations: 50,
    });

    const result = await orchestrator.run(RUN_ID);
    const state = await fileReader.load(RUN_ID);
    const events = await new JsonlEventReader(repositoryRoot).readAfter(RUN_ID, 0);
    return { result, state, events, history, requests, context };
  });
}

function completedRuntime(fixtures: readonly FakeAgentRuntimeFixture[]): AgentRuntime {
  return new FakeAgentRuntime(fixtures);
}

function fixture(
  stepId: string,
  agentId: AgentId,
  result: FakeAgentRuntimeFixture["result"],
  summary: string,
): FakeAgentRuntimeFixture {
  return { stepId, agentId, result, summary };
}

describe("dynamic Playbook fake E2E", () => {
  it("inserts Researcher and Oracle Steps for their respective triggers", async () => {
    const base = step("step-001", "implementation", "worker");
    const researcherId = "step-002" as StepId;
    const oracleId = "step-003" as StepId;
    const graph = createStepGraph([base]);
    let inserted = false;
    const runtime = completedRuntime([
      fixture(base.id, "worker", "completed", "base-complete"),
      fixture(researcherId, "researcher", "completed", "researcher-inserted"),
      fixture(oracleId, "oracle", "completed", "oracle-inserted"),
    ]);
    const scenario: Scenario = {
      graph,
      initial: initialState(graph, "feature"),
      runtime,
      completion: (state, context) => completionFor(state, context),
      postconditions: async ({ state, result, step: dispatchedStep }, context) => {
        const next = context.recordResult(state, dispatchedStep, result);
        if (!inserted && dispatchedStep.id === base.id) {
          const researcher = addDynamicStep(
            context.getGraph(),
            {
              id: researcherId,
              type: "research",
              objective: "resolve uncertainty",
              agent: "researcher",
              dependsOn: [base.id],
              status: "ready",
              trigger: "uncertainty",
            },
            2,
          );
          context.setGraph(
            addDynamicStep(
              researcher,
              {
                id: oracleId,
                type: "analysis",
                objective: "resolve decision",
                agent: "oracle",
                dependsOn: [researcherId],
                status: "ready",
                trigger: "decision",
              },
              2,
            ),
          );
          inserted = true;
        }
        return context.sync(next);
      },
      summary: "researcher-oracle-insertion",
    };

    const run = await runScenario(scenario);

    expect(run.result.kind).toBe("completed");
    expect(run.requests.map(({ identity }) => identity.agentId)).toEqual([
      "worker",
      "researcher",
      "oracle",
    ]);
    expect(run.context.getGraph()).toMatchObject({ graphRevision: 3 });
    expect(run.context.getGraph().steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: researcherId,
          origin: "dynamic",
          trigger: "uncertainty",
          status: "completed",
        }),
        expect.objectContaining({
          id: oracleId,
          origin: "dynamic",
          trigger: "decision",
          status: "completed",
        }),
      ]),
    );
    expect(
      run.events.filter(({ type }) => type === "graph.step-added").map(({ data }) => data.step_id),
    ).toEqual([researcherId, oracleId]);
    expect(run.state.run.outcome).toMatchObject({
      status: "completed",
      summary: "researcher-oracle-insertion",
    });
  });

  it("blocks on a D3 decision, resolves it as a user action, and resumes", async () => {
    const base = step("step-001", "implementation", "worker");
    const graph = createStepGraph([base]);
    const decisionId = "D-001" as DecisionId;
    const blockedRuntime = new FakeAgentRuntime([
      fixture(base.id, "worker", "blocked", "waiting-for-user"),
    ]);
    const resumedRuntime = new FakeAgentRuntime([
      fixture(base.id, "worker", "completed", "resumed-complete"),
    ]);
    let attempts = 0;
    let userResolved = false;
    const scenario: Scenario = {
      graph,
      initial: initialState(graph, "feature", [{ id: decisionId, class: "D3", status: "pending" }]),
      runtime: {
        run: async (request) => {
          attempts += 1;
          return attempts === 1 ? blockedRuntime.run(request) : resumedRuntime.run(request);
        },
      },
      recover: (state, context) => {
        if (!userResolved || state.run.status !== "blocked") return state;
        const resolved = transitionDecision(
          createDecision({ id: decisionId, class: "D3", status: "pending" }),
          "resolved",
        );
        context.setGraph(transitionStepInGraph(context.getGraph(), base.id, "ready"));
        return context.sync({
          ...state,
          run: { ...state.run, status: "running", blocked: null },
          snapshot: {
            ...state.snapshot,
            decisions: {
              ...state.snapshot.decisions,
              decisions: [{ id: resolved.id, class: resolved.class, status: resolved.status }],
            },
          },
        });
      },
      completion: (state, context) => completionFor(state, context),
      postconditions: async ({ state, result, step: dispatchedStep }, context) => {
        if (result.outcome === "blocked") {
          return context.recordResult(
            {
              ...state,
              run: {
                ...state.run,
                status: "blocked",
                blocked: { decision_id: decisionId, reason: "D3 user resolution required" },
              },
            },
            dispatchedStep,
            result,
          );
        }
        return context.recordResult(state, dispatchedStep, result);
      },
      afterCommit: (state) => {
        if (state.run.status === "blocked") userResolved = true;
      },
      summary: "d3-resume",
    };

    const run = await runScenario(scenario);

    expect(run.result.kind).toBe("completed");
    expect(attempts).toBe(2);
    expect(run.state.run.run_id).toBe(RUN_ID);
    expect(run.state.snapshot.decisions.decisions).toEqual([
      { id: decisionId, class: "D3", status: "resolved" },
    ]);
    expect(run.events.map(({ type }) => type)).toEqual(
      expect.arrayContaining(["run.blocked", "decision.resolved", "run.resumed", "run.completed"]),
    );
  });

  it("executes a verification/review fix cycle after a failed verification", async () => {
    const worker = step("step-001", "implementation", "worker");
    const verifier = step("step-002", "verification", "verifier", [worker.id]);
    const reviewer = step("step-003", "review", "reviewer", [verifier.id]);
    const fixWorkerId = "step-004" as StepId;
    const fixVerifierId = "step-005" as StepId;
    const fixReviewerId = "step-006" as StepId;
    const graph = createStepGraph([worker, verifier, reviewer]);
    const runtime = completedRuntime([
      fixture(worker.id, "worker", "completed", "initial-worker"),
      fixture(verifier.id, "verifier", "failed", "verification-failed"),
      fixture(fixWorkerId, "worker", "completed", "fix-worker"),
      fixture(fixVerifierId, "verifier", "completed", "verification-passed"),
      fixture(fixReviewerId, "reviewer", "completed", "review-clean"),
    ]);
    const requiredById = new Map<StepId, boolean>([
      [worker.id, true],
      [verifier.id, true],
      [reviewer.id, true],
      [fixWorkerId, true],
      [fixVerifierId, true],
      [fixReviewerId, true],
    ]);
    const scenario: Scenario = {
      graph,
      initial: initialState(graph, "feature"),
      runtime,
      requiredById,
      completion: (state, context) =>
        completionFor(state, context, {
          verificationStep: fixVerifierId,
          reviewStep: fixReviewerId,
        }),
      postconditions: async ({ state, result, step: dispatchedStep }, context) => {
        if (result.outcome !== "failed") return context.recordResult(state, dispatchedStep, result);

        let nextGraph = transitionStepInGraph(context.getGraph(), dispatchedStep.id, "running");
        nextGraph = transitionStepInGraph(nextGraph, dispatchedStep.id, "failed");
        nextGraph = transitionStepInGraph(nextGraph, dispatchedStep.id, "ready");
        nextGraph = transitionStepInGraph(
          nextGraph,
          dispatchedStep.id,
          "skipped",
          "superseded by verification fix cycle",
        );
        nextGraph = transitionStepInGraph(
          nextGraph,
          reviewer.id,
          "skipped",
          "superseded by verification fix cycle",
        );
        nextGraph = addDynamicStep(
          nextGraph,
          {
            id: fixWorkerId,
            type: "implementation",
            objective: "fix verification failure",
            agent: "worker",
            dependsOn: [worker.id],
            status: "ready",
            trigger: "verification failure",
          },
          3,
        );
        nextGraph = addDynamicStep(
          nextGraph,
          {
            id: fixVerifierId,
            type: "verification",
            objective: "reverify the fix",
            agent: "verifier",
            dependsOn: [fixWorkerId],
            status: "ready",
            trigger: "verification failure",
          },
          3,
        );
        nextGraph = addDynamicStep(
          nextGraph,
          {
            id: fixReviewerId,
            type: "review",
            objective: "rereview the fix",
            agent: "reviewer",
            dependsOn: [fixVerifierId],
            status: "ready",
            trigger: "review finding",
          },
          3,
        );
        context.setGraph(nextGraph);
        context.results.set(dispatchedStep.id, outcomeRecord(result));
        return context.sync({
          ...state,
          run: {
            ...state.run,
            current_step: {
              id: dispatchedStep.id,
              execution_id: result.identity.executionId,
              status: result.outcome,
            },
          },
        });
      },
      summary: "verification-review-fix-cycle",
    };

    const run = await runScenario(scenario);

    expect(run.result.kind).toBe("completed");
    expect(run.requests.map(({ identity }) => identity.stepId)).toEqual([
      worker.id,
      verifier.id,
      fixWorkerId,
      fixVerifierId,
      fixReviewerId,
    ]);
    expect(run.state.snapshot.steps.steps.find(({ id }) => id === verifier.id)).toMatchObject({
      status: "skipped",
      result: { outcome: "failed", summary: "verification-failed" },
      skip_reason: "superseded by verification fix cycle",
    });
    expect(run.events.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        "step.failed",
        "graph.step-added",
        "step.completed",
        "run.completed",
      ]),
    );
  });

  it("amends the Requirement, marks the Plan for re-plan, and returns it to current", async () => {
    const base = step("step-001", "implementation", "worker");
    const analysisId = "step-002" as StepId;
    const replanId = "step-003" as StepId;
    const graph = createStepGraph([base]);
    const requirement = createRequirement({
      revision: 1,
      goal: "complete the initial behavior",
      acceptanceCriteria: [{ id: "AC-001", description: "initial behavior" }],
      constraints: [{ id: "C-001", description: "preserve the Run" }],
    });
    const amendment = reviseRequirement(requirement, {
      kind: "acceptanceCriteria",
      candidate: {
        operation: "clarify",
        effect: "changing",
        targetId: "AC-001",
        description: "amended behavior",
      },
    });
    const planImpact = evaluatePlanApplicability({
      current: false,
      compatible: false,
      replanRequired: true,
    });
    const runtime = completedRuntime([
      fixture(base.id, "worker", "completed", "initial-work"),
      fixture(analysisId, "scout", "completed", "amendment-analysis"),
      fixture(replanId, "planner", "completed", "amended-plan"),
    ]);
    let amended = false;
    const scenario: Scenario = {
      graph,
      initial: initialState(graph, "feature"),
      runtime,
      completion: (state, context) => completionFor(state, context, { planRequired: true }),
      postconditions: async ({ state, result, step: dispatchedStep }, context) => {
        const next = context.recordResult(state, dispatchedStep, result);
        if (dispatchedStep.id === replanId) {
          return context.sync({
            ...next,
            run: {
              ...next.run,
              current_plan: {
                ...next.run.current_plan,
                version: 2,
                applicability: { status: "current" },
              },
            },
          });
        }
        if (amended || dispatchedStep.id !== base.id) return next;

        let nextGraph = addDynamicStep(
          context.getGraph(),
          {
            id: analysisId,
            type: "analysis",
            objective: "reanalyze amended requirement",
            agent: "scout",
            dependsOn: [base.id],
            status: "ready",
            trigger: "request amendment",
          },
          2,
        );
        nextGraph = addDynamicStep(
          nextGraph,
          {
            id: replanId,
            type: "planning",
            objective: "re-plan amended requirement",
            agent: "planner",
            dependsOn: [analysisId],
            status: "ready",
            trigger: "request amendment",
          },
          2,
        );
        context.setGraph(nextGraph);
        amended = true;
        const amendedRequirement: RequirementSnapshotV1 = {
          ...next.snapshot.requirement,
          revision: amendment.requirement.revision,
          acceptance_criteria: JSON.parse(
            JSON.stringify(amendment.requirement.acceptanceCriteria),
          ) as RequirementSnapshotV1["acceptance_criteria"],
          constraints: JSON.parse(
            JSON.stringify(amendment.requirement.constraints),
          ) as RequirementSnapshotV1["constraints"],
        };
        return context.sync({
          ...next,
          run: {
            ...next.run,
            current_plan: {
              ...next.run.current_plan,
              version: 2,
              applicability: { status: planImpact },
            },
          },
          snapshot: { ...next.snapshot, requirement: amendedRequirement },
        });
      },
      trigger: async (state) => state,
      summary: "requirement-amendment-replan",
    };

    const run = await runScenario(scenario);

    expect(run.result.kind).toBe("completed");
    expect(amendment.impact).toEqual({
      planImpact: "replan-required",
      requiresReclassification: true,
      requiresReplan: true,
    });
    expect(run.state.snapshot.requirement).toMatchObject({
      revision: 2,
      acceptance_criteria: [{ id: "AC-002", supersedes: "AC-001" }],
    });
    expect(run.state.run.current_plan).toMatchObject({
      version: 2,
      applicability: { status: "current" },
    });
    expect(
      run.events
        .filter(({ type }) => type === "plan.applicability-changed")
        .map(({ data }) => ({ from: data.from, to: data.to })),
    ).toEqual(
      expect.arrayContaining([
        { from: "current", to: "replan-required" },
        { from: "replan-required", to: "current" },
      ]),
    );
    expect(run.events.map(({ type }) => type)).toEqual(
      expect.arrayContaining(["request.amended", "requirement.revised"]),
    );
  });

  it("switches Playbook without rebuilding the Run or losing prior history", async () => {
    const question = step("step-001", "analysis", "scout");
    const oldInvestigation = step("step-002", "research", "researcher", [question.id], "pending");
    const planner = step("step-003", "planning", "planner", [question.id], "ready");
    const worker = step("step-004", "implementation", "worker", [planner.id]);
    const verifier = step("step-005", "verification", "verifier", [worker.id]);
    const reviewer = step("step-006", "review", "reviewer", [verifier.id]);
    const initialGraph = createStepGraph([question, oldInvestigation]);
    const featureSteps = [planner, worker, verifier, reviewer];
    const runtime = completedRuntime([
      fixture(question.id, "scout", "completed", "investigation-question"),
      fixture(planner.id, "planner", "completed", "feature-plan"),
      fixture(worker.id, "worker", "completed", "feature-work"),
      fixture(verifier.id, "verifier", "completed", "feature-verification"),
      fixture(reviewer.id, "reviewer", "completed", "feature-review"),
    ]);
    let switched = false;
    const requiredById = new Map<StepId, boolean>([
      [question.id, true],
      [oldInvestigation.id, true],
      ...featureSteps.map((stepValue) => [stepValue.id, true] as const),
    ]);
    const scenario: Scenario = {
      graph: initialGraph,
      initial: initialState(initialGraph, "investigation"),
      runtime,
      requiredById,
      trigger: async (state, context) => {
        if (switched || !completed(state, question.id)) return state;
        let nextGraph = obsoleteStepInGraph(
          context.getGraph(),
          oldInvestigation.id,
          "superseded by Feature Playbook",
        );
        for (const featureStep of featureSteps) {
          nextGraph = addStep(nextGraph, featureStep);
        }
        context.setGraph(nextGraph);
        switched = true;
        return context.sync({
          ...state,
          run: {
            ...state.run,
            playbook: {
              ...state.run.playbook,
              current: { id: "feature", version: INITIAL_PLAYBOOK_VERSION },
            },
          },
        });
      },
      completion: (state, context) =>
        completionFor(state, context, {
          planRequired: true,
          verificationStep: verifier.id,
          reviewStep: reviewer.id,
        }),
      summary: "investigation-to-feature-switch",
    };

    const run = await runScenario(scenario);

    expect(run.result.kind).toBe("completed");
    expect(run.state.run.run_id).toBe(RUN_ID);
    expect(run.state.run.playbook).toEqual({
      initial: { id: "investigation", version: INITIAL_PLAYBOOK_VERSION },
      current: { id: "feature", version: INITIAL_PLAYBOOK_VERSION },
    });
    expect(run.state.snapshot.steps.steps.find(({ id }) => id === question.id)).toMatchObject({
      status: "completed",
      result: { summary: "investigation-question" },
    });
    expect(
      run.state.snapshot.steps.steps.find(({ id }) => id === oldInvestigation.id),
    ).toMatchObject({
      status: "skipped",
      obsolete: true,
      skip_reason: "superseded by Feature Playbook",
    });
    expect(
      run.history.some(
        (state) =>
          state.snapshot.steps.steps.find(({ id }) => id === question.id)?.result?.summary ===
          "investigation-question",
      ),
    ).toBe(true);
    expect(run.events.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        "playbook.switched",
        "step.skipped",
        "graph.step-added",
        "run.completed",
      ]),
    );
  });
});
