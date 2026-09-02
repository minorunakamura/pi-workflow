import type { DomainEventDraft } from "../contracts/events/event.js";
import type { JsonObject } from "../contracts/execution/agent-execution.js";
import type { StepType } from "../contracts/state/workflow-state.js";
import type {
  RunYamlV1,
  SnapshotHeaderV1,
  StepStateV1,
  StateSnapshotFile,
} from "../contracts/state/workflow-state.js";
import type { RepositoryAdapter, RepositorySnapshot } from "../ports/repository.js";
import type { RunReader, WorkflowState } from "../ports/run-reader.js";
import type { WorkspaceLock } from "../ports/workspace-lock.js";
import type { RunStore } from "../ports/state-store.js";
import type { UserInteraction } from "../ports/user-interaction.js";
import {
  createIdAllocator,
  type IdAllocator,
  type RunId,
  type StepId,
} from "../domain/primitives/ids.js";
import { PLAYBOOK_DEFINITIONS, type PlaybookDefinition } from "../playbooks/definitions.js";
import { withNextRevision } from "./state-revision.js";
import type {
  CancelWorkflowUseCase as CancelWorkflowContract,
  ResumeWorkflowUseCase as ResumeWorkflowContract,
  StartWorkflowCommand,
  StartWorkflowUseCase as StartWorkflowContract,
  StatusWorkflowUseCase as StatusWorkflowContract,
} from "./workflow-command-handler.js";
import type { ResumeLifecycle } from "./recovery/resume-lifecycle.js";
import type {
  CancellationLifecycle,
  CancellationRequestOptions,
} from "./recovery/cancellation-lifecycle.js";
import type { Orchestrator } from "./orchestrator.js";

const RUN_ID_PATTERN = /^run-\d+$/;
const MAX_RUN_CREATION_ATTEMPTS = 100;
const STATE_FILES = [
  "requirement.yaml",
  "steps.yaml",
  "uncertainties.yaml",
  "decisions.yaml",
  "gates.yaml",
  "findings.yaml",
] as const satisfies readonly StateSnapshotFile[];

type WorkflowOrchestrator = Pick<Orchestrator, "run">;
export type WorkflowOrchestratorSource =
  | WorkflowOrchestrator
  | ((userInteraction?: UserInteraction) => WorkflowOrchestrator);

type WorkflowIdAllocator = Pick<IdAllocator, "issueStepId">;
type RunIdAllocatorSource = Readonly<{
  issueRunId(): RunId | Promise<RunId>;
}>;

export type InitialWorkflowStateInput = Readonly<{
  runId: RunId;
  command: StartWorkflowCommand;
  goal: string;
  repository: RepositorySnapshot;
  idAllocator: WorkflowIdAllocator;
  createdAt: string;
}>;

export type StartWorkflowUseCaseDependencies = Readonly<{
  runStore: RunStore;
  repository: RepositoryAdapter;
  orchestrator: WorkflowOrchestratorSource;
  workspaceLock?: WorkspaceLock;
  idAllocator?: WorkflowIdAllocator;
  runIdAllocator?: RunIdAllocatorSource;
  effectiveConfig?: JsonObject;
  now?: () => Date;
}>;

export type StatusWorkflowUseCaseDependencies = Readonly<{
  runReader: RunReader;
}>;

export type ResumeWorkflowUseCaseDependencies = Readonly<{
  lifecycle: Pick<ResumeLifecycle, "resume">;
  orchestrator: WorkflowOrchestratorSource;
  workspaceLock?: WorkspaceLock;
}>;

export type CancelWorkflowUseCaseDependencies = Readonly<{
  lifecycle: Pick<CancellationLifecycle, "cancel">;
}>;

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError("now must return a valid Date");
  }
  return value.toISOString();
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be non-empty text`);
  }
  return value;
}

function playbook(command: StartWorkflowCommand): PlaybookDefinition {
  const definition = PLAYBOOK_DEFINITIONS.find(({ id }) => id === command);
  if (definition === undefined) {
    throw new Error(`Unsupported workflow Playbook: ${command}`);
  }
  return definition;
}

function stepType(stepId: string): StepType {
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

function stepAgent(step: PlaybookDefinition["baseGraph"][number]): string {
  const agent =
    step.agent ?? step.allowedAgents?.[0] ?? (step.id === "synthesize" ? "researcher" : undefined);
  if (agent === undefined) {
    throw new Error(`Playbook Step ${step.id} has no executable Agent`);
  }
  return agent;
}

function repositoryValue(snapshot: RepositorySnapshot): JsonObject {
  const status = {
    dirty: snapshot.status.dirty,
    changed: [...snapshot.status.changed],
    untracked: [...snapshot.status.untracked],
    entries: snapshot.status.entries.map((entry) => ({
      path: entry.path,
      index: entry.index,
      worktree: entry.worktree,
      ...(entry.originalPath === undefined ? {} : { originalPath: entry.originalPath }),
    })),
  };
  const baseline = {
    root: snapshot.root,
    head: snapshot.head,
    branch: snapshot.branch,
    status,
    fingerprints: { ...snapshot.fingerprints },
    fingerprint: snapshot.fingerprint,
  };

  return {
    ...baseline,
    baseline: snapshot.head,
    baseline_snapshot: baseline,
    baseline_root: snapshot.root,
    baseline_head: snapshot.head,
    baseline_branch: snapshot.branch,
    baseline_dirty: snapshot.status.dirty,
    pre_existing: {
      changed: [...snapshot.status.changed],
      untracked: [...snapshot.status.untracked],
    },
    snapshot: baseline,
    classification: snapshot.status.dirty ? "unrelated" : "clean",
    resolution: "clear",
  };
}

function initialSteps(
  definition: PlaybookDefinition,
  allocator: WorkflowIdAllocator,
): readonly StepStateV1[] {
  const stepIds = new Map<string, StepId>();
  for (const step of definition.baseGraph) {
    stepIds.set(step.id, allocator.issueStepId());
  }

  return definition.baseGraph.map((definitionStep) => {
    const id = stepIds.get(definitionStep.id);
    if (id === undefined) {
      throw new Error(`Unable to allocate Step ID for ${definitionStep.id}`);
    }
    const dependsOn = definitionStep.dependsOn.map((dependency) => {
      const dependencyId = stepIds.get(dependency);
      if (dependencyId === undefined) {
        throw new Error(`Playbook Step ${definitionStep.id} has unknown dependency ${dependency}`);
      }
      return dependencyId;
    });

    return {
      id,
      type: stepType(definitionStep.id),
      objective: definitionStep.objective,
      agent: stepAgent(definitionStep),
      skills: [],
      inputs: [],
      outputs: [],
      depends_on: dependsOn,
      completion_criteria: [],
      status: dependsOn.length === 0 ? "ready" : "pending",
      blocked_by: [],
      result: null,
    };
  });
}

export function createInitialWorkflowState(input: InitialWorkflowStateInput): WorkflowState {
  const definition = playbook(input.command);
  const goal = requiredText(input.goal, "Workflow request").trim();
  const createdAt = requiredText(input.createdAt, "createdAt");
  if (!RUN_ID_PATTERN.test(input.runId)) {
    throw new Error(`Invalid Run ID: ${input.runId}`);
  }

  const header: SnapshotHeaderV1 = {
    schema_version: 1,
    run_id: input.runId,
    state_revision: 1,
  };
  const playbookReference: JsonObject = {
    id: definition.id,
    version: definition.version,
  };
  const steps = initialSteps(definition, input.idAllocator);
  const repository = repositoryValue(input.repository);
  const run: RunYamlV1 = {
    ...header,
    request: { id: `request-${input.runId}`, type: input.command },
    status: "created",
    finalized: false,
    graph_revision: 1,
    playbook: { initial: playbookReference, current: playbookReference },
    current_step: {},
    current_plan: null,
    current_changes: { relevant_change_sets: [], external_reconciliation: null },
    repository,
    blocked: null,
    failure: null,
    cancellation: null,
    limits: {},
    counters: {},
    telemetry: { degraded: false },
    outcome: null,
    timestamps: { created_at: createdAt },
  };

  return {
    run,
    snapshot: {
      requirement: {
        ...header,
        revision: 1,
        goal,
        scope: { in: [], out: [] },
        constraints: [],
        acceptance_criteria: [],
        non_goals: [],
        supplied_evidence: [],
        assumptions: [],
        open_questions: [],
      },
      steps: { ...header, graph_revision: 1, steps },
      uncertainties: { ...header, uncertainties: [] },
      decisions: { ...header, decisions: [] },
      gates: { ...header, gates: [] },
      findings: { ...header, findings: [] },
      manifest: {
        ...header,
        previous_state_revision: 0,
        created_at: createdAt,
        files: STATE_FILES,
      },
    },
  };
}

function initialEvents(state: WorkflowState, createdAt: string): readonly DomainEventDraft[] {
  const source = { component: "start-workflow" };
  const actor = { type: "user" };
  const common = {
    schema_version: 1 as const,
    timestamp: createdAt,
    run_id: state.run.run_id,
    source,
    actor,
    state_revision: state.run.state_revision,
    correlation_id: state.run.run_id,
  };

  return [
    { ...common, type: "run.created", data: { status: state.run.status } },
    {
      ...common,
      type: "request.received",
      data: { request_id: state.run.request.id, type: state.run.request.type },
    },
    {
      ...common,
      type: "requirement.created",
      data: { revision: state.snapshot.requirement.revision },
    },
    {
      ...common,
      type: "playbook.selected",
      data: {
        to: state.run.request.type,
        version: state.run.playbook.current.version ?? "unknown",
      },
    },
  ];
}

function startedState(state: WorkflowState, startedAt: string): WorkflowState {
  return {
    ...state,
    run: {
      ...state.run,
      status: "running",
      timestamps: { ...state.run.timestamps, started_at: startedAt },
    },
  };
}

function startedEvent(state: WorkflowState, startedAt: string): DomainEventDraft {
  return {
    schema_version: 1,
    type: "run.started",
    timestamp: startedAt,
    run_id: state.run.run_id,
    source: { component: "start-workflow" },
    actor: { type: "user" },
    state_revision: state.run.state_revision,
    correlation_id: state.run.run_id,
    data: { status: "running" },
  };
}

function isRunAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "RUN_ALREADY_EXISTS"
  );
}

function isWorkflowState(value: unknown): value is WorkflowState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { run?: unknown; snapshot?: unknown };
  return (
    typeof candidate.run === "object" &&
    candidate.run !== null &&
    typeof candidate.snapshot === "object" &&
    candidate.snapshot !== null
  );
}

async function runOrchestrator(
  source: WorkflowOrchestratorSource,
  runId: RunId,
  userInteraction?: UserInteraction,
): Promise<WorkflowState> {
  const orchestrator = typeof source === "function" ? source(userInteraction) : source;
  if (typeof orchestrator?.run !== "function") {
    throw new Error("Production workflow Orchestrator is unavailable");
  }

  const result = await orchestrator.run(runId);
  const state = isWorkflowState(result)
    ? result
    : typeof result === "object" && result !== null && "state" in result
      ? result.state
      : undefined;
  if (!isWorkflowState(state)) {
    throw new Error(`Orchestrator returned no state for ${runId}`);
  }
  if (state.run.run_id !== runId) {
    throw new Error(`Orchestrator returned a different Run ID: ${runId}`);
  }
  return state;
}

export class StartWorkflowUseCase implements StartWorkflowContract {
  private readonly idAllocator: WorkflowIdAllocator;
  private readonly runIdAllocator: RunIdAllocatorSource;
  private readonly now: () => Date;

  constructor(private readonly dependencies: StartWorkflowUseCaseDependencies) {
    this.idAllocator = dependencies.idAllocator ?? createIdAllocator();
    const storeIssueRunId = dependencies.runStore.issueRunId.bind(dependencies.runStore);
    this.runIdAllocator = dependencies.runIdAllocator ?? { issueRunId: storeIssueRunId };
    this.now = dependencies.now ?? (() => new Date());
  }

  async execute(
    command: StartWorkflowCommand,
    args: string,
    userInteraction?: UserInteraction,
  ): Promise<WorkflowState> {
    const rawRequest = requiredText(args, "Workflow request");
    playbook(command);
    const createdAt = timestamp(this.now);
    const workspace =
      this.dependencies.workspaceLock === undefined
        ? undefined
        : await this.dependencies.workspaceLock.acquire({ recoverStale: true });
    let createdRunId: RunId | undefined;

    try {
      const repository = await this.dependencies.repository.captureSnapshot();
      for (let attempt = 0; attempt < MAX_RUN_CREATION_ATTEMPTS; attempt += 1) {
        const runId = await this.runIdAllocator.issueRunId();
        const initial = createInitialWorkflowState({
          runId,
          command,
          goal: rawRequest,
          repository,
          idAllocator: this.idAllocator,
          createdAt,
        });
        const effectiveConfig = this.dependencies.effectiveConfig ?? {
          playbook: initial.run.playbook.current,
        };
        let created: WorkflowState;
        try {
          created = await this.dependencies.runStore.create({
            initial,
            request: args,
            effectiveConfig: `${JSON.stringify(effectiveConfig, null, 2)}\n`,
            events: initialEvents(initial, createdAt),
          });
        } catch (error) {
          if (!isRunAlreadyExists(error) || attempt === MAX_RUN_CREATION_ATTEMPTS - 1) {
            throw error;
          }
          continue;
        }
        if (created.run.run_id !== runId) {
          throw new Error(`Run Store returned a different Run ID: ${runId}`);
        }

        const startedAt = timestamp(this.now);
        const started = withNextRevision(created, startedState(created, startedAt));
        await this.dependencies.runStore.commit({
          expectedRevision: created.run.state_revision,
          next: started,
          events: [startedEvent(started, startedAt)],
        });
        createdRunId = runId;
        break;
      }
    } finally {
      await workspace?.release();
    }

    if (createdRunId === undefined) {
      throw new Error("Unable to allocate a unique Run ID");
    }
    return runOrchestrator(this.dependencies.orchestrator, createdRunId, userInteraction);
  }
}

export class StatusWorkflowUseCase implements StatusWorkflowContract {
  constructor(private readonly dependencies: StatusWorkflowUseCaseDependencies) {}

  execute(runId: RunId): Promise<WorkflowState> {
    return this.dependencies.runReader.load(runId);
  }
}

export class ResumeWorkflowUseCase implements ResumeWorkflowContract {
  constructor(private readonly dependencies: ResumeWorkflowUseCaseDependencies) {}

  async execute(runId: RunId, userInteraction?: UserInteraction): Promise<WorkflowState> {
    const workspace =
      this.dependencies.workspaceLock === undefined
        ? undefined
        : await this.dependencies.workspaceLock.acquire({ recoverStale: true });
    try {
      await this.dependencies.lifecycle.resume(runId);
    } finally {
      await workspace?.release();
    }
    return runOrchestrator(this.dependencies.orchestrator, runId, userInteraction);
  }
}

export class CancelWorkflowUseCase implements CancelWorkflowContract {
  constructor(private readonly dependencies: CancelWorkflowUseCaseDependencies) {}

  execute(runId: RunId, options?: CancellationRequestOptions): Promise<WorkflowState> {
    return this.dependencies.lifecycle.cancel(runId, options);
  }
}

export type WorkflowUseCases = Readonly<{
  startWorkflow: StartWorkflowUseCase;
  statusWorkflow: StatusWorkflowUseCase;
  resumeWorkflow: ResumeWorkflowUseCase;
  cancelWorkflow: CancelWorkflowUseCase;
}>;

export function createWorkflowUseCases(
  input: Readonly<{
    start: StartWorkflowUseCaseDependencies;
    status: StatusWorkflowUseCaseDependencies;
    resume: ResumeWorkflowUseCaseDependencies;
    cancel: CancelWorkflowUseCaseDependencies;
  }>,
): WorkflowUseCases {
  return {
    startWorkflow: new StartWorkflowUseCase(input.start),
    statusWorkflow: new StatusWorkflowUseCase(input.status),
    resumeWorkflow: new ResumeWorkflowUseCase(input.resume),
    cancelWorkflow: new CancelWorkflowUseCase(input.cancel),
  };
}
