import { describe, expect, it } from "vitest";
import { FileArtifactStore } from "../../src/adapters/persistence/write/file-artifact-store.js";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import { JsonlEventReader } from "../../src/adapters/persistence/read/jsonl-event-reader.js";
import { JsonlEventWriter } from "../../src/adapters/persistence/write/jsonl-event-writer.js";
import { FileStateStore } from "../../src/adapters/persistence/write/file-state-store.js";
import { FakeAgentRuntime } from "../../src/adapters/fake-agent-runtime.js";
import { Orchestrator } from "../../src/application/orchestrator.js";
import {
  StepResultV1Schema,
  type AgentExecutionRequestV1,
} from "../../src/contracts/execution/agent-execution.js";
import type { ArtifactRef } from "../../src/ports/artifact-store.js";
import type { StepType } from "../../src/domain/graph/step-graph.js";
import { selectNextStep, type SchedulerStep } from "../../src/domain/scheduling/scheduler.js";
import type { ExecutionId, GateId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import { evaluateCompletion } from "../../src/evaluation/completion-evaluator.js";
import { AGENT_DEFINITIONS, type AgentId } from "../../src/agents/definitions.js";
import { PLAYBOOK_DEFINITIONS, type PlaybookDefinition } from "../../src/playbooks/definitions.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";
import { withGoldenRepository } from "../fixtures/golden-repositories.js";
import type { RepositoryFixture } from "../fixtures/temp-repository.js";

const RUN_ID = "run-001" as RunId;
const INITIAL_STATE_REVISION = 1;
const CREATED_AT = "2026-08-30T03:02:10.123+09:00";
const STATE_FILES = [
  "requirement.yaml",
  "steps.yaml",
  "uncertainties.yaml",
  "decisions.yaml",
  "gates.yaml",
  "findings.yaml",
] as const;

type TestStep = Readonly<{
  definitionId: string;
  id: StepId;
  type: StepType;
  agent: AgentId;
  required: boolean;
  dependsOn: readonly StepId[];
}>;

function agentFor(step: PlaybookDefinition["baseGraph"][number]): AgentId {
  if (step.agent !== undefined) return step.agent;
  const allowedAgent = step.allowedAgents?.[0];
  if (allowedAgent !== undefined) return allowedAgent;
  // The Playbook Model leaves synthesis unassigned; the E2E adapter keeps its fake output read-only.
  if (step.id === "synthesize") return "researcher";
  throw new Error(`Playbook Step ${step.id} has no executable Agent`);
}

function typeFor(stepId: string): StepType {
  if (stepId === "worker") return "implementation";
  if (stepId === "planner" || stepId === "minimal-plan") return "planning";
  if (
    stepId === "verifier" ||
    stepId === "regression-verification" ||
    stepId === "critical-verification" ||
    stepId === "behavior-preservation"
  ) {
    return "verification";
  }
  if (stepId === "reviewer") return "review";
  if (stepId === "investigate") return "research";
  return "analysis";
}

function testSteps(definition: PlaybookDefinition): readonly TestStep[] {
  const ids = new Map(
    definition.baseGraph.map((step, index) => [
      step.id,
      `step-${String(index + 1).padStart(3, "0")}` as StepId,
    ]),
  );

  return definition.baseGraph.map((step) => ({
    definitionId: step.id,
    id: ids.get(step.id)!,
    type: typeFor(step.id),
    agent: agentFor(step),
    required: step.required,
    dependsOn: step.dependsOn.map((dependency) => ids.get(dependency)!),
  }));
}

function artifactType(step: TestStep): string {
  return step.type === "planning" ? "plan" : step.type;
}

function artifactPath(step: TestStep, executionId: ExecutionId, iteration: number): string {
  switch (step.type) {
    case "analysis":
      return `analysis/${step.id}-${executionId}.md`;
    case "research":
      return `research/${step.id}-${executionId}.md`;
    case "planning":
      return `plans/execution-plan-v${iteration}.md`;
    case "implementation":
      return `implementation/change-set-CS-${iteration}.md`;
    case "verification":
      return `verification/VR-${iteration}.md`;
    case "review":
      return `reviews/RR-${iteration}.md`;
    default:
      return `analysis/${step.id}-${executionId}.md`;
  }
}

function artifactContents(
  step: TestStep,
  executionId: ExecutionId,
  stateRevision: number,
  iteration: number,
): string {
  const definition = AGENT_DEFINITIONS.find(({ id }) => id === step.agent);
  if (definition === undefined) {
    throw new Error(`Missing Agent definition for ${step.agent}`);
  }

  return `---
schema_version: 1
run_id: ${RUN_ID}
step_id: ${step.id}
execution_id: ${executionId}
execution_state_revision: ${stateRevision}
agent:
  id: ${step.agent}
  version: 1
artifact:
  type: ${artifactType(step)}
  status: complete
created_at: "${CREATED_AT}"
skills: []
---
fake-output:${step.definitionId}:${iteration}`;
}

function initialState(definition: PlaybookDefinition, steps: readonly TestStep[]): WorkflowState {
  const header = {
    schema_version: 1 as const,
    run_id: RUN_ID,
    state_revision: INITIAL_STATE_REVISION,
  };
  const playbook = { id: definition.id, version: definition.version };

  return {
    run: {
      ...header,
      request: { id: `request-${definition.id}`, type: definition.id },
      status: "running",
      finalized: false,
      graph_revision: 1,
      playbook: { initial: playbook, current: playbook },
      current_step: {},
      current_plan:
        definition.id === "investigation" ? null : { applicability: { status: "current" } },
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
        goal: `fake ${definition.id} workflow`,
        scope: { in: [], out: [] },
        constraints: [{ status: "respected" }],
        acceptance_criteria: [{ status: "satisfied" }],
        non_goals: [],
        supplied_evidence: [],
        assumptions: [],
        open_questions: [],
      },
      steps: {
        ...header,
        graph_revision: 1,
        steps: steps.map((step) => ({
          id: step.id,
          type: step.type,
          objective: step.definitionId,
          agent: step.agent,
          skills: [],
          inputs: [],
          outputs: [],
          depends_on: step.dependsOn,
          completion_criteria: [],
          status: "ready" as const,
          blocked_by: [],
          result: null,
        })),
      },
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
        files: STATE_FILES,
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

function persistedArtifactRefs(
  step: WorkflowState["snapshot"]["steps"]["steps"][number],
): readonly ArtifactRef[] {
  const values = step.result?.artifacts;
  if (!Array.isArray(values)) {
    throw new Error(`Missing persisted Artifacts for ${step.id}`);
  }

  return values.map((value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof value.runId !== "string" ||
      typeof value.path !== "string" ||
      value.status !== "complete"
    ) {
      throw new Error(`Invalid persisted Artifact ref for ${step.id}`);
    }
    return { runId: value.runId as RunId, path: value.path, status: "complete" };
  });
}

function schedulerSteps(state: WorkflowState): readonly SchedulerStep[] {
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
    blockedBy: [],
    result: step.result,
    origin: "base",
  }));
}

describe("six Playbook fake E2E", () => {
  for (const definition of PLAYBOOK_DEFINITIONS) {
    it(`${definition.id} completes with coherent persisted projections`, async () => {
      const steps = testSteps(definition);
      const executedSteps = steps.filter(({ required }) => required);
      const initial = initialState(definition, steps);

      await withGoldenRepository(definition.id, fixtureFor(initial), async (repositoryRoot) => {
        const artifactStore = new FileArtifactStore(repositoryRoot);
        const eventWriter = new JsonlEventWriter(repositoryRoot);
        const stateStore = new FileStateStore(repositoryRoot, { eventWriter });
        const runReader = new FileRunReader(repositoryRoot);
        const fakeRuntime = new FakeAgentRuntime(
          steps.map((step) => ({
            stepId: step.id,
            agentId: step.agent,
            result: "completed",
            summary: `fake:${definition.id}:${step.definitionId}`,
          })),
        );
        const requiredByStepId = new Map(steps.map((step) => [step.id, step.required]));
        const artifactsByExecution = new Map<ExecutionId, ArtifactRef>();
        const artifactPaths: string[] = [];
        const outcomeSummary = `fake:${definition.id}:completed`;

        const orchestrator = new Orchestrator({
          runReader,
          stateStore,
          agentRuntime: {
            run: async (request) => {
              const fakeResult = StepResultV1Schema.parse(await fakeRuntime.run(request));
              const artifact = artifactsByExecution.get(request.identity.executionId);
              if (artifact === undefined) {
                throw new Error(`Missing fake Artifact for ${request.identity.executionId}`);
              }
              return { ...fakeResult, artifacts: [artifact] };
            },
          },
          buildRequest: async ({ state, step, iteration }): Promise<AgentExecutionRequestV1> => {
            const testStep = steps.find(({ id }) => id === step.id);
            if (testStep === undefined) {
              throw new Error(`Unknown test Step ${step.id}`);
            }
            const definitionForAgent = AGENT_DEFINITIONS.find(({ id }) => id === testStep.agent);
            if (definitionForAgent === undefined) {
              throw new Error(`Missing Agent definition for ${testStep.agent}`);
            }
            const executionId = `exec-${String(iteration).padStart(3, "0")}` as ExecutionId;
            const path = artifactPath(testStep, executionId, iteration);
            const staged = await artifactStore.stage({
              runId: RUN_ID,
              executionId,
              contents: artifactContents(
                testStep,
                executionId,
                state.run.state_revision,
                iteration,
              ),
            });
            const ref = await artifactStore.finalize(staged, path);
            artifactsByExecution.set(executionId, ref);
            artifactPaths.push(ref.path);

            return {
              identity: {
                runId: RUN_ID,
                stepId: testStep.id,
                executionId,
                agentId: testStep.agent,
                agentVersion: definitionForAgent.version,
              },
              objective: {
                objective: testStep.definitionId,
                type: testStep.type,
                completionCriteria: [],
              },
              retry: { attempt: 1, context: null },
              execution: {
                mode: definitionForAgent.mode,
                timeoutMs: 1_000,
                cancellationPolicy: {},
              },
              authority: {
                maximumDLevel: definitionForAgent.maximumNormalAuthority,
                escalationRules: [],
              },
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
              outputs: { expectedArtifactTypes: [artifactType(testStep)], outputContract: {} },
            };
          },
          completion: async (state) => {
            const completed = (type: StepType): boolean =>
              state.snapshot.steps.steps.some(
                (step) => step.type === type && step.status === "completed",
              );
            const verificationRequired = definition.gatePolicy.verification === "required";
            const reviewRequired = definition.gatePolicy.review === "required";

            return evaluateCompletion({
              steps: state.snapshot.steps.steps.map((step) => ({
                status: step.status,
                required: requiredByStepId.get(step.id) ?? true,
              })),
              requirement: {
                acceptanceCriteria: [{ status: "satisfied" }],
                constraints: [{ status: "respected" }],
              },
              plan:
                definition.id === "investigation"
                  ? { required: false }
                  : { required: true, applicability: "current" },
              implementation: { reconciled: true, currentChangesExplained: true },
              repository: { classification: "clean", resolution: "clear" },
              verification: verificationRequired
                ? {
                    required: true,
                    present: completed("verification"),
                    freshness: "fresh",
                    result: "passed",
                  }
                : { required: false },
              review: reviewRequired
                ? {
                    required: true,
                    present: completed("review"),
                    freshness: "fresh",
                    result: "clean",
                    complete: true,
                    findings: [],
                  }
                : { required: false },
              controlState: {
                uncertainties: [],
                decisions: [],
                gates: [{ status: "passed" }],
                terminalError: false,
              },
            });
          },
          schedule: async (state) =>
            selectNextStep({
              steps: schedulerSteps(state),
              gates: [{ id: "G-001" as GateId, type: "completion", status: "passed" }],
            }),
          postconditions: async ({ state, result, step }) => ({
            ...state,
            run: {
              ...state.run,
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
                      playbook: definition.id,
                      summary: outcomeSummary,
                      artifact_paths: [...artifactPaths],
                    },
                  },
                }
              : state,
          artifactReader: artifactStore,
          events: async ({ after, result, step, normalized }) => {
            if (
              result !== null &&
              step !== null &&
              normalized !== undefined &&
              normalized !== null
            ) {
              const path = normalized.artifacts.refs[0]?.path;
              if (path === undefined) {
                throw new Error(`Missing Artifact ref for ${step.id}`);
              }
              return [
                {
                  schema_version: 1,
                  type: "step.completed",
                  timestamp: CREATED_AT,
                  run_id: RUN_ID,
                  source: { component: "orchestrator" },
                  state_revision: after.run.state_revision,
                  data: {
                    step_id: step.id,
                    execution_id: result.identity.executionId,
                    artifact_path: path,
                  },
                },
                {
                  schema_version: 1,
                  type: "artifact.finalized",
                  timestamp: CREATED_AT,
                  run_id: RUN_ID,
                  source: { component: "artifact-store" },
                  state_revision: after.run.state_revision,
                  data: { step_id: step.id, execution_id: result.identity.executionId, path },
                },
              ];
            }

            return [
              {
                schema_version: 1,
                type: "run.completed",
                timestamp: CREATED_AT,
                run_id: RUN_ID,
                source: { component: "orchestrator" },
                state_revision: after.run.state_revision,
                data: { playbook: definition.id, status: "completed", summary: outcomeSummary },
              },
            ];
          },
        });

        const runResult = await orchestrator.run(RUN_ID);
        expect(runResult).toMatchObject({
          kind: "completed",
          iterations: executedSteps.length + 1,
        });

        const persisted = await runReader.load(RUN_ID);
        expect(persisted.run).toMatchObject({
          status: "completed",
          finalized: true,
          state_revision: executedSteps.length + 2,
          playbook: { current: { id: definition.id, version: definition.version } },
          outcome: {
            status: "completed",
            playbook: definition.id,
            summary: outcomeSummary,
            artifact_paths: artifactPaths,
          },
        });
        expect(persisted.snapshot.steps.steps).toHaveLength(steps.length);
        expect(
          persisted.snapshot.steps.steps.every(
            (step) => requiredByStepId.get(step.id) === false || step.status === "completed",
          ),
        ).toBe(true);

        for (const step of persisted.snapshot.steps.steps) {
          if (requiredByStepId.get(step.id) === false) {
            expect(step.status).toBe("ready");
            continue;
          }
          expect(step.result).toMatchObject({
            outcome: "completed",
            summary: `fake:${definition.id}:${step.objective}`,
          });
          const refs = persistedArtifactRefs(step);
          expect(refs).toHaveLength(1);
          const ref = refs[0]!;
          expect(ref).toMatchObject({ runId: RUN_ID, status: "complete" });
          const artifact = await artifactStore.read(ref);
          expect(artifact.frontMatter).toMatchObject({
            run_id: RUN_ID,
            step_id: step.id,
            artifact: {
              status: "complete",
              type: artifactType(steps.find(({ id }) => id === step.id)!),
            },
          });
          expect(artifact.body).toContain(`fake-output:${step.objective}:`);
        }

        const events = await new JsonlEventReader(repositoryRoot).readAfter(RUN_ID, 0);
        expect(events.map(({ sequence }) => sequence)).toEqual(
          Array.from({ length: events.length }, (_, index) => index + 1),
        );
        expect(events.filter(({ type }) => type === "step.completed")).toHaveLength(
          executedSteps.length,
        );
        expect(events.filter(({ type }) => type === "artifact.finalized")).toHaveLength(
          executedSteps.length,
        );
        expect(events.at(-1)).toMatchObject({
          type: "run.completed",
          state_revision: executedSteps.length + 2,
          data: { playbook: definition.id, status: "completed", summary: outcomeSummary },
        });
        for (const event of events.filter(({ type }) => type === "step.completed")) {
          expect(event.data.artifact_path).toEqual(expect.any(String));
          expect(
            persisted.snapshot.steps.steps.some(
              (step) =>
                step.id === event.data.step_id &&
                persistedArtifactRefs(step).some(
                  (artifact) => artifact.path === event.data.artifact_path,
                ),
            ),
          ).toBe(true);
        }
        for (const event of events.filter(({ type }) => type === "artifact.finalized")) {
          const step = persisted.snapshot.steps.steps.find(({ id }) => id === event.data.step_id);
          expect(step).toBeDefined();
          if (step === undefined) {
            continue;
          }
          expect(
            persistedArtifactRefs(step).some(
              (ref) =>
                ref.runId === RUN_ID && ref.path === event.data.path && ref.status === "complete",
            ),
          ).toBe(true);
        }
      });
    });
  }
});
