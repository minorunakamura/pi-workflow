import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import { FileStateStore } from "../../src/adapters/persistence/write/file-state-store.js";
import { Orchestrator } from "../../src/application/orchestrator.js";
import { FixReverifyRereviewRouter } from "../../src/application/fix-reverify-rereview.js";
import {
  type AgentExecutionRequestV1,
  type StepResultV1,
} from "../../src/contracts/execution/agent-execution.js";
import type { StepStateV1 } from "../../src/contracts/state/workflow-state.js";
import { selectNextStep, type SchedulerStep } from "../../src/domain/scheduling/scheduler.js";
import type {
  ExecutionId,
  FindingId,
  GateId,
  RunId,
  StepId,
} from "../../src/domain/primitives/ids.js";
import type { StepType } from "../../src/domain/graph/step-graph.js";
import {
  evaluateCompletion,
  type CompletionEvaluation,
} from "../../src/evaluation/completion-evaluator.js";
import { AGENT_DEFINITIONS, type AgentId } from "../../src/agents/definitions.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const RUN_ID = "run-706" as RunId;
const WORKER_ID = "step-001" as StepId;
const VERIFIER_ID = "step-002" as StepId;
const REVIEWER_ID = "step-003" as StepId;
const CREATED_AT = "2026-08-30T03:02:10.123+09:00";

type Scenario = "verification-failure" | "blocking-finding";

function step(
  id: StepId,
  type: StepType,
  agent: AgentId,
  dependsOn: readonly StepId[] = [],
): StepStateV1 {
  return {
    id,
    type,
    objective:
      type === "implementation" ? "implement" : type === "verification" ? "verify" : "review",
    agent,
    skills: [],
    inputs: [],
    outputs: [],
    depends_on: dependsOn,
    completion_criteria: [],
    status: "ready",
    blocked_by: [],
    result: null,
  };
}

function initialState(maxDynamicSteps = 3): WorkflowState {
  const header = { schema_version: 1 as const, run_id: RUN_ID, state_revision: 1 };
  const steps = [
    step(WORKER_ID, "implementation", "worker"),
    step(VERIFIER_ID, "verification", "verifier", [WORKER_ID]),
    step(REVIEWER_ID, "review", "reviewer", [VERIFIER_ID]),
  ];

  return {
    run: {
      ...header,
      request: { id: "request-706", type: "feature" },
      status: "running",
      finalized: false,
      state_revision: 1,
      graph_revision: 1,
      playbook: {
        initial: { id: "feature", version: "1.0.0" },
        current: { id: "feature", version: "1.0.0" },
      },
      current_step: {},
      current_plan: null,
      current_changes: { relevant_change_sets: [], external_reconciliation: null },
      repository: { classification: "clean", resolution: "clear" },
      blocked: null,
      failure: null,
      cancellation: null,
      limits: { max_dynamic_steps: maxDynamicSteps },
      counters: {},
      telemetry: { degraded: false },
      outcome: null,
      timestamps: { created_at: CREATED_AT },
    },
    snapshot: {
      requirement: {
        ...header,
        revision: 1,
        goal: "verify the current implementation",
        scope: { in: [], out: [] },
        constraints: [{ status: "respected" }],
        acceptance_criteria: [{ status: "satisfied" }],
        non_goals: [],
        supplied_evidence: [],
        assumptions: [],
        open_questions: [],
      },
      steps: { ...header, graph_revision: 1, steps },
      uncertainties: { ...header, uncertainties: [] },
      decisions: { ...header, decisions: [] },
      gates: {
        ...header,
        gates: [{ id: "G-001" as GateId, type: "completion", status: "passed" }],
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

function fixtureFor(state: WorkflowState): Record<string, string> {
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
  };
}

function schedulerStep(value: StepStateV1): SchedulerStep {
  return {
    id: value.id,
    type: value.type,
    objective: value.objective,
    agent: value.agent,
    skills: value.skills.filter((skill): skill is string => typeof skill === "string"),
    inputs: value.inputs,
    outputs: value.outputs,
    dependsOn: value.depends_on.filter(
      (id): id is StepId => typeof id === "string",
    ) as readonly StepId[],
    completionCriteria: value.completion_criteria.filter(
      (criterion): criterion is string => typeof criterion === "string",
    ),
    status: value.status,
    blockedBy: value.blocked_by.filter((reason): reason is string => typeof reason === "string"),
    result: value.result,
    origin: value.origin === "dynamic" ? "dynamic" : "base",
    ...(typeof value.trigger === "string" ? { trigger: value.trigger } : {}),
    ...(typeof value.skip_reason === "string" ? { skipReason: value.skip_reason } : {}),
    ...(typeof value.obsolete === "boolean" ? { obsolete: value.obsolete } : {}),
  };
}

function resultFor(
  request: AgentExecutionRequestV1,
  outcome: StepResultV1["outcome"],
  summary: string,
): StepResultV1 {
  return {
    identity: request.identity,
    outcome,
    mode: request.execution.mode,
    summary,
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
    blocked: outcome === "blocked" ? { reason: summary } : null,
    failure: outcome === "failed" ? { reason: summary } : null,
    runtime: {},
  };
}

function completionFor(state: WorkflowState): CompletionEvaluation {
  const steps = state.snapshot.steps.steps;
  const latest = (type: StepType): StepStateV1 | undefined =>
    steps.filter((current) => current.type === type).at(-1);
  const verification = latest("verification");
  const review = latest("review");
  const result = (current: StepStateV1 | undefined): "passed" | "failed" | "incomplete" =>
    current?.result?.outcome === "failed"
      ? "failed"
      : current?.status === "completed"
        ? "passed"
        : "incomplete";

  return evaluateCompletion({
    steps: steps.map((current) => ({
      status: current.status,
      required: true,
      skipAuthorized: current.status === "skipped",
    })),
    requirement: {
      acceptanceCriteria: [{ status: "satisfied" }],
      constraints: [{ status: "respected" }],
    },
    plan: { required: false },
    implementation: { reconciled: true, currentChangesExplained: true },
    repository: { classification: "clean", resolution: "clear" },
    verification: {
      required: true,
      present: verification?.status === "completed",
      freshness: verification?.status === "completed" ? "fresh" : "stale",
      result: result(verification),
    },
    review: {
      required: true,
      present: review?.status === "completed",
      freshness: review?.status === "completed" ? "fresh" : "stale",
      result: review?.status === "completed" ? "clean" : "incomplete",
      complete: review?.status === "completed",
      findings: state.snapshot.findings.findings,
    },
    controlState: {
      uncertainties: [],
      decisions: [],
      gates: state.snapshot.gates.gates.map(({ status }) => ({ status })),
      terminalError: false,
    },
  });
}

async function runScenario(
  scenario: Scenario,
  maxDynamicSteps = 3,
): Promise<{
  state: WorkflowState;
  requests: readonly AgentExecutionRequestV1[];
  completionCalls: number;
}> {
  const initial = initialState(maxDynamicSteps);
  return withTempRepository(fixtureFor(initial), async (repositoryRoot) => {
    const runReader = new FileRunReader(repositoryRoot);
    const stateStore = new FileStateStore(repositoryRoot);
    const requests: AgentExecutionRequestV1[] = [];
    let executionNumber = 0;
    let completionCalls = 0;

    const orchestrator = new Orchestrator({
      runReader,
      stateStore,
      agentRuntime: {
        run: async (request) => {
          const failed =
            scenario === "verification-failure" && request.identity.stepId === VERIFIER_ID;
          return resultFor(
            request,
            failed ? "failed" : "completed",
            failed ? "check failed" : "step completed",
          );
        },
      },
      buildRequest: async ({ step: dispatchedStep }) => {
        const definition = AGENT_DEFINITIONS.find(({ id }) => id === dispatchedStep.agent);
        if (definition === undefined) throw new Error(`Unknown Agent ${dispatchedStep.agent}`);
        const executionId = `exec-${String(++executionNumber).padStart(3, "0")}` as ExecutionId;
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
          permissions: { filesystem: [], shell: [], git: [], network: [], repositoryTargets: [] },
          skills: { required: [], optional: [] },
          tools: { resolved: [], policy: {} },
          model: { requested: "fake", actual: "fake", thinkingLevel: "low", allowedFallback: [] },
          context: { pack: {}, manifest: {}, artifactRefs: [] },
          outputs: { expectedArtifactTypes: [], outputContract: {} },
        };
        requests.push(request);
        return request;
      },
      completion: async (state) => {
        completionCalls += 1;
        return completionFor(state);
      },
      schedule: async (state) =>
        selectNextStep({ steps: state.snapshot.steps.steps.map(schedulerStep) }),
      postconditions: async ({ state, result, step: currentStep }) => {
        const current = state.snapshot.steps.steps.find(({ id }) => id === currentStep.id);
        if (current === undefined) throw new Error(`Unknown Step ${currentStep.id}`);
        const findings: WorkflowState["snapshot"]["findings"]["findings"] =
          scenario === "blocking-finding" && currentStep.id === REVIEWER_ID
            ? [
                {
                  id: "F-001" as FindingId,
                  state: "open" as const,
                  disposition: "fix-required" as const,
                  severity: "high" as const,
                  confidence: "high" as const,
                },
              ]
            : currentStep.objective === "rereview the fix"
              ? state.snapshot.findings.findings.map((finding) => ({
                  ...finding,
                  state: "resolved" as const,
                  disposition: "fixed" as const,
                }))
              : state.snapshot.findings.findings;
        return {
          ...state,
          run: {
            ...state.run,
            current_step: {
              id: currentStep.id,
              execution_id: result.identity.executionId,
              status: result.outcome,
            },
          },
          snapshot: {
            ...state.snapshot,
            steps: {
              ...state.snapshot.steps,
              steps: state.snapshot.steps.steps.map((value) =>
                value.id === currentStep.id
                  ? {
                      ...value,
                      status:
                        result.outcome === "failed" ? ("failed" as const) : ("completed" as const),
                      result: { outcome: result.outcome, summary: result.summary },
                    }
                  : value,
              ),
            },
            findings: { ...state.snapshot.findings, findings },
          },
        };
      },
      maxIterations: 30,
    });

    await orchestrator.run(RUN_ID);
    return { state: await runReader.load(RUN_ID), requests, completionCalls };
  });
}

describe("Fix/reverify/rereview orchestration E2E", () => {
  it("routes a failed Verification through a bounded fresh fix cycle", async () => {
    const run = await runScenario("verification-failure");

    expect(run.requests.map(({ identity }) => identity.stepId)).toEqual([
      WORKER_ID,
      VERIFIER_ID,
      "step-004",
      "step-005",
      "step-006",
    ]);
    expect(run.state.snapshot.steps.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: VERIFIER_ID, status: "skipped" }),
        expect.objectContaining({ id: REVIEWER_ID, status: "skipped" }),
        expect.objectContaining({
          id: "step-004",
          type: "implementation",
          origin: "dynamic",
          status: "completed",
        }),
        expect.objectContaining({
          id: "step-005",
          type: "verification",
          origin: "dynamic",
          status: "completed",
        }),
        expect.objectContaining({
          id: "step-006",
          type: "review",
          origin: "dynamic",
          status: "completed",
        }),
      ]),
    );
    expect(
      run.state.snapshot.steps.steps.filter(({ origin }) => origin === "dynamic"),
    ).toHaveLength(3);
    expect(run.completionCalls).toBeGreaterThan(5);
  });

  it("routes a blocking Finding through fix/reverify/rereview and resolves it before completion", async () => {
    const run = await runScenario("blocking-finding");

    expect(run.requests.map(({ identity }) => identity.stepId)).toEqual([
      WORKER_ID,
      VERIFIER_ID,
      REVIEWER_ID,
      "step-004",
      "step-005",
      "step-006",
    ]);
    expect(run.state.snapshot.findings.findings).toEqual([
      {
        id: "F-001",
        state: "resolved",
        disposition: "fixed",
        severity: "high",
        confidence: "high",
      },
    ]);
    expect(run.state.snapshot.steps.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "step-004",
          objective: "fix blocking finding",
          origin: "dynamic",
        }),
        expect.objectContaining({
          id: "step-005",
          objective: "reverify the fix",
          origin: "dynamic",
        }),
        expect.objectContaining({
          id: "step-006",
          objective: "rereview the fix",
          origin: "dynamic",
        }),
      ]),
    );
  });

  it("keeps completion blocked while a recovery cycle is active", () => {
    const routed = new FixReverifyRereviewRouter().route({
      state: initialState(),
      blockers: ["VERIFICATION_FAILED"],
    });
    const guarded = new FixReverifyRereviewRouter().guardCompletion(routed.state, {
      eligible: true,
      blockers: [],
    });

    expect(guarded).toMatchObject({
      eligible: false,
      blockers: expect.arrayContaining(["VERIFICATION_STALE", "REVIEW_STALE"]),
    });
  });

  it("fails closed when the dynamic-step budget cannot fit a complete cycle", async () => {
    await expect(runScenario("verification-failure", 2)).rejects.toThrow(/max_dynamic_steps/);
  });
});
