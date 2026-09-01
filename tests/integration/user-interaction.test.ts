import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PiUserInteractionAdapter } from "../../src/adapters/pi/pi-user-interaction-adapter.js";
import { Orchestrator } from "../../src/application/orchestrator.js";
import { createPiUserInteraction } from "../../src/bootstrap/create-workflow-runtime.js";
import { registerWorkflowCommands } from "../../src/extensions/commands/register-workflow-commands.js";
import type {
  AgentExecutionRequestV1,
  StepResultV1,
} from "../../src/contracts/execution/agent-execution.js";
import { createStep } from "../../src/domain/graph/step-graph.js";
import type { DecisionId, ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import type { StateStore, StateStoreCommitInput } from "../../src/ports/state-store.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";
import type { WorkflowCommandHandler } from "../../src/application/workflow-command-handler.js";
import type { UserInteraction, UserInteractionRequest } from "../../src/ports/user-interaction.js";

const RUN_ID = "run-001" as RunId;
const STEP_ID = "step-001" as StepId;
const EXECUTION_ID = "exec-001" as ExecutionId;
const DECISION_ID = "D-001" as DecisionId;
const CREATED_AT = "2026-08-30T03:02:10.123+09:00";

type PiUserInterface = Pick<ExtensionUIContext, "select" | "confirm" | "input">;

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
    summary: "implemented",
    artifacts: [],
    uncertainty_candidates: [],
    decision_requests: [
      {
        class: "D3",
        kind: "options",
        title: "Approve implementation",
        message: "Choose whether the implementation is approved.",
        options: ["approve", "reject"],
      },
    ],
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

function workflowState(stepStatus: "ready" | "completed" = "ready"): WorkflowState {
  const header = { schema_version: 1 as const, run_id: RUN_ID, state_revision: 1 };
  return {
    run: {
      ...header,
      request: { id: "request-001", type: "feature" },
      status: "running",
      finalized: false,
      state_revision: 1,
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
            status: stepStatus,
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

function ui(): PiUserInterface {
  return {
    confirm: async () => true,
    select: async (_title, options) => options[0],
    input: async () => "custom answer",
  };
}

function orchestrator(
  userInteraction: UserInteraction,
  interactions: UserInteractionRequest[],
): {
  orchestrator: Orchestrator;
  store: StateStore & { current: WorkflowState };
  calls: () => number;
} {
  let current = workflowState();
  let runtimeCalls = 0;
  const step = createStep({
    id: STEP_ID,
    type: "implementation",
    objective: "implement",
    agent: "worker",
    status: "ready",
  });
  const store: StateStore & { current: WorkflowState } = {
    get current() {
      return current;
    },
    load: async () => current,
    commit: async (input: StateStoreCommitInput) => {
      expect(input.expectedRevision).toBe(current.run.state_revision);
      current = input.next;
      return current;
    },
  };

  return {
    store,
    calls: () => runtimeCalls,
    orchestrator: new Orchestrator({
      stateStore: store,
      agentRuntime: {
        run: async () => {
          runtimeCalls += 1;
          return result();
        },
      },
      buildRequest: async () => request(),
      completion: async (state) => {
        const stepCompleted = state.snapshot.steps.steps[0]?.status === "completed";
        const decisionResolved = state.snapshot.decisions.decisions.some(
          (decision) => decision.id === DECISION_ID && decision.status === "resolved",
        );
        return stepCompleted && decisionResolved
          ? { eligible: true, blockers: [] }
          : { eligible: false, blockers: ["STEP_INCOMPLETE"] };
      },
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
          ? { ...state, run: { ...state.run, outcome: { status: "completed" } } }
          : state,
      events: async () => [],
      fixCycle: false,
      userInteraction: {
        ask: async (interaction, signal) => {
          interactions.push(interaction);
          return userInteraction.ask(interaction, signal);
        },
      },
      maxIterations: 5,
    }),
  };
}

describe("UserInteraction adapter and Orchestrator integration", () => {
  it("maps approval, options, custom answer, and cancellation without touching state", async () => {
    const adapter = new PiUserInteractionAdapter(ui());
    const base = {
      runId: RUN_ID,
      decisionId: DECISION_ID,
      class: "D3" as const,
      title: "D3 question",
      message: "Choose an answer",
    };

    await expect(adapter.ask({ ...base, kind: "approval" })).resolves.toEqual({
      kind: "answered",
      answer: true,
    });
    await expect(
      adapter.ask({ ...base, kind: "options", options: ["one", "two"] }),
    ).resolves.toEqual({ kind: "answered", answer: "one" });
    await expect(
      adapter.ask({ ...base, kind: "custom", placeholder: "optional" }),
    ).resolves.toEqual({ kind: "answered", answer: "custom answer" });

    const cancelled = new PiUserInteractionAdapter({
      ...ui(),
      select: async () => undefined,
    });
    await expect(cancelled.ask({ ...base, kind: "options", options: ["one"] })).resolves.toEqual({
      kind: "cancelled",
    });
  });

  it("applies an Agent D3 request through a persisted Orchestrator transition", async () => {
    const interactions: UserInteractionRequest[] = [];
    const test = orchestrator(new PiUserInteractionAdapter(ui()), interactions);

    const outcome = await test.orchestrator.run(RUN_ID);

    expect(outcome.kind).toBe("completed");
    expect(test.calls()).toBe(1);
    expect(interactions).toEqual([
      {
        runId: RUN_ID,
        decisionId: DECISION_ID,
        class: "D3",
        kind: "options",
        title: "Approve implementation",
        message: "Choose whether the implementation is approved.",
        options: ["approve", "reject"],
      },
    ]);
    expect(test.store.current.snapshot.decisions.decisions).toEqual([
      {
        class: "D3",
        kind: "options",
        title: "Approve implementation",
        message: "Choose whether the implementation is approved.",
        options: ["approve", "reject"],
        id: DECISION_ID,
        step_id: STEP_ID,
        status: "resolved",
        authority: "user",
        resolution: "approve",
      },
    ]);
  });

  it("persists a pending D3 decision and blocks when the user cancels", async () => {
    const interactions: UserInteractionRequest[] = [];
    const test = orchestrator(
      new PiUserInteractionAdapter({
        ...ui(),
        select: async () => undefined,
      }),
      interactions,
    );

    const outcome = await test.orchestrator.run(RUN_ID);

    expect(outcome).toMatchObject({ kind: "idle", reason: "RECOVERABLE_BLOCKER" });
    expect(test.calls()).toBe(1);
    expect(test.store.current.run).toMatchObject({
      status: "blocked",
      blocked: { reason: "user-input-required", decision_id: DECISION_ID },
    });
    expect(test.store.current.snapshot.decisions.decisions).toEqual([
      expect.objectContaining({ id: DECISION_ID, class: "D3", status: "pending" }),
    ]);
  });

  it("injects the Pi adapter into workflow use cases only when UI is available", async () => {
    type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];
    const registrations = new Map<string, RegisteredCommand>();
    let received: UserInteraction | undefined;
    const handler: WorkflowCommandHandler = {
      execute: async (_command, _args, userInteraction) => {
        received = userInteraction;
      },
    };

    registerWorkflowCommands(
      {
        registerCommand(name, options) {
          registrations.set(name, options);
        },
      },
      handler,
      createPiUserInteraction,
    );
    await registrations.get("wf-feature")!.handler("", {
      hasUI: true,
      ui: {
        ...ui(),
        notify() {},
      },
    } as never);

    expect(received).toBeInstanceOf(PiUserInteractionAdapter);
  });
});
