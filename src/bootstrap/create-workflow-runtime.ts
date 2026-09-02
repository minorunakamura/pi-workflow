import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
  Skill as PiSkill,
} from "@earendil-works/pi-coding-agent";
import { resolve as resolvePath } from "node:path";
import { FileArtifactStore } from "../adapters/persistence/write/file-artifact-store.js";
import { GitRepositoryAdapter } from "../adapters/repository/git-repository-adapter.js";
import { PiUserInteractionAdapter } from "../adapters/pi/pi-user-interaction-adapter.js";
import { FileRunLock } from "../adapters/persistence/write/file-run-lock.js";
import { FileStateStore } from "../adapters/persistence/write/file-state-store.js";
import { FileWorkspaceLock } from "../adapters/persistence/write/file-workspace-lock.js";
import { FileArtifactReader } from "../adapters/persistence/read/file-artifact-reader.js";
import { FileRunReader } from "../adapters/persistence/read/file-run-reader.js";
import {
  PiSubagentsAdapter,
  type PiSubagentsAdapterOptions,
} from "../adapters/pi/pi-subagents-adapter.js";
import { createPiPackageSkillCatalog } from "../adapters/pi/skill-catalog.js";
import { AGENT_DEFINITIONS, type AgentDefinition } from "../agents/definitions.js";
import { SkillCatalog } from "../agents/skill-catalog.js";
import {
  ACCEPTANCE_CRITERION_STATUSES,
  CONSTRAINT_STATUSES,
  evaluateCompletion,
  type AcceptanceCriterionStatus,
  type ConstraintStatus,
} from "../evaluation/completion-evaluator.js";
import {
  START_WORKFLOW_COMMANDS,
  type CancelWorkflowUseCase,
  type ResumeWorkflowUseCase,
  type StartWorkflowUseCase,
  type StatusWorkflowUseCase,
  type WorkflowCommand,
  type WorkflowCommandHandler,
  type WorkflowCommandOutput,
  renderWorkflowResponse,
} from "../application/workflow-command-handler.js";
import { ExecutionResolver } from "../application/execution/model-tool-resolution.js";
import { WorkerFinalizer } from "../application/execution/worker-finalizer.js";
import { Orchestrator } from "../application/orchestrator.js";
import { buildContext, type ContextCandidate } from "../application/context/context-builder.js";
import {
  CancellationLifecycle,
  type CancellationCoordinator,
  type CancellationExecution,
} from "../application/recovery/cancellation-lifecycle.js";
import { InterruptedExecutionRecovery } from "../application/recovery/interrupted-execution-recovery.js";
import { ResumeLifecycle } from "../application/recovery/resume-lifecycle.js";
import {
  createWorkflowUseCases,
  type WorkflowUseCases,
} from "../application/workflow-use-cases.js";
import {
  selectNextStep,
  type SchedulerResult,
  type SchedulerStep,
} from "../domain/scheduling/scheduler.js";
import { createIdAllocator, type ExecutionId, type RunId } from "../domain/primitives/ids.js";
import { PLAYBOOK_DEFINITIONS, type PlaybookDefinition } from "../playbooks/definitions.js";
import type { AgentRuntime } from "../ports/agent-runtime.js";
import type {
  JsonObject,
  AgentExecutionRequestV1,
  StepResultV1,
} from "../contracts/execution/agent-execution.js";
import type { ArtifactReader, ArtifactRef } from "../ports/artifact-store.js";
import type { RepositoryAdapter, RepositorySnapshot } from "../ports/repository.js";
import type { ModelCatalog, ModelReference } from "../ports/model-catalog.js";
import type { ToolCatalog, ToolDefinition } from "../ports/tool-catalog.js";
import type { UserInteraction } from "../ports/user-interaction.js";
import type { WorkflowState } from "../ports/run-reader.js";

const RUN_ID_PATTERN = /^run-\d+$/;
const COMMAND_TIMEOUT_MS = 300_000;
const CONTEXT_BUDGET = 16_384;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const TOOL_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  read: ["repository-read"],
  grep: ["repository-read"],
  find: ["repository-read"],
  ls: ["repository-read"],
  edit: ["repository-write"],
  bash: ["shell"],
  powershell: ["shell"],
};

type RuntimeUseCases = Readonly<{
  startWorkflow?: StartWorkflowUseCase;
  statusWorkflow?: StatusWorkflowUseCase;
  resumeWorkflow?: ResumeWorkflowUseCase;
  cancelWorkflow?: CancelWorkflowUseCase;
}>;

export type WorkflowRuntimeDependencies = RuntimeUseCases & {
  commandHandler?: WorkflowCommandHandler;
  pi?: Pick<ExtensionAPI, "events"> & Partial<Pick<ExtensionAPI, "getAllTools">>;
};

type PiRuntimeFacilities = Pick<ExtensionAPI, "events"> &
  Partial<Pick<ExtensionAPI, "getAllTools">>;
type ProductionCommandContext = Pick<
  ExtensionCommandContext,
  "cwd" | "model" | "scopedModels" | "modelRegistry" | "getSystemPromptOptions"
> &
  Readonly<{
    thinkingLevel?: string;
  }>;

type ProductionRuntimeFactory = (context: unknown) => Promise<RuntimeUseCases>;

type ProductionExecution = Readonly<{
  agentRuntime: AgentRuntime;
  executionResolver: ExecutionResolver;
  skillCatalog: SkillCatalog;
  modelCandidates: readonly ModelReference[];
  toolCatalog: ToolCatalog;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function productionContext(value: unknown): ProductionCommandContext {
  if (!isRecord(value) || typeof value.cwd !== "string" || value.cwd.trim().length === 0) {
    throw new Error("Workflow command context with a consuming repository cwd is required");
  }
  return value as unknown as ProductionCommandContext;
}

function requirePiFacilities(pi: PiRuntimeFacilities | undefined): PiRuntimeFacilities {
  if (pi?.events === undefined) {
    throw new Error("Production workflow runtime requires Pi execution events");
  }
  return pi;
}

function modelReference(value: unknown): ModelReference | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (!isRecord(value)) return undefined;

  const provider = value.provider;
  const model = value.model ?? value.id;
  if (
    typeof provider === "string" &&
    provider.trim().length > 0 &&
    typeof model === "string" &&
    model.trim().length > 0
  ) {
    return { provider: provider.trim(), model: model.trim() };
  }
  return undefined;
}

function modelKey(model: ModelReference): string {
  return typeof model === "string" ? model : `${model.provider}/${model.model}`;
}

function availableModels(context: ProductionCommandContext): readonly ModelReference[] {
  const scoped = (context.scopedModels ?? []).flatMap((entry) => {
    const model = isRecord(entry) ? modelReference(entry.model) : undefined;
    return model === undefined ? [] : [model];
  });
  const registered =
    typeof context.modelRegistry?.getAvailable === "function"
      ? context.modelRegistry.getAvailable().flatMap((model) => {
          const reference = modelReference(model);
          return reference === undefined ? [] : [reference];
        })
      : [];
  const allowed = scoped.length > 0 ? scoped : registered;
  const current = modelReference(context.model);
  const currentIsAllowed =
    current !== undefined && allowed.some((model) => modelKey(model) === modelKey(current));
  const ordered =
    allowed.length === 0 && current !== undefined
      ? [current]
      : currentIsAllowed
        ? [current, ...allowed]
        : allowed;
  const seen = new Set<string>();
  return ordered.filter((model) => {
    const key = modelKey(model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function modelCatalog(models: readonly ModelReference[]): ModelCatalog {
  const available = new Set(models.map(modelKey));
  return {
    isAvailable: (model) => available.has(modelKey(model)),
  };
}

function toolCapabilities(name: string): readonly string[] {
  return TOOL_CAPABILITIES[name] ?? [];
}

function createPiToolCatalog(pi: PiRuntimeFacilities | undefined): ToolCatalog {
  const definitions = new Map<string, ToolDefinition>();
  const tools = typeof pi?.getAllTools === "function" ? pi.getAllTools() : [];

  for (const candidate of tools) {
    if (!isRecord(candidate) || typeof candidate.name !== "string") continue;
    const name = candidate.name.trim();
    const capabilities = toolCapabilities(name);
    for (const capability of capabilities) {
      if (definitions.has(capability)) continue;
      const allowedModes =
        capability === "repository-write" || capability === "shell"
          ? (["write"] as const)
          : (["read-only", "write", "verify-only"] as const);
      definitions.set(capability, { name, capabilities, allowedModes });
    }
  }

  return { resolve: (capability) => definitions.get(capability) };
}

function createPiSkillCatalog(context: ProductionCommandContext): SkillCatalog {
  const skills = context.getSystemPromptOptions?.().skills;
  if (!Array.isArray(skills)) {
    throw new Error("Production workflow runtime requires Pi package Skill resources");
  }

  return createPiPackageSkillCatalog({
    getSkills: () => ({ skills: skills as PiSkill[], diagnostics: [] }),
  });
}

function repositorySnapshotValue(snapshot: RepositorySnapshot): Record<string, unknown> {
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
  return { ...baseline, snapshot: baseline };
}

function persistedRepositorySnapshot(state: WorkflowState): RepositorySnapshot {
  const value = state.run.repository.snapshot;
  if (!isRecord(value)) {
    throw new Error(`Run ${state.run.run_id} has no persisted repository snapshot`);
  }
  if (
    typeof value.root !== "string" ||
    typeof value.head !== "string" ||
    (value.branch !== null && typeof value.branch !== "string") ||
    typeof value.fingerprint !== "string" ||
    !isRecord(value.status) ||
    !Array.isArray(value.status.entries) ||
    !isRecord(value.fingerprints)
  ) {
    throw new Error(`Run ${state.run.run_id} has an invalid persisted repository snapshot`);
  }
  return value as unknown as RepositorySnapshot;
}

function schedulerStep(step: WorkflowState["snapshot"]["steps"]["steps"][number]): SchedulerStep {
  return {
    id: step.id,
    type: step.type,
    objective: step.objective,
    agent: step.agent,
    skills: step.skills.filter((value): value is string => typeof value === "string"),
    inputs: step.inputs,
    outputs: step.outputs,
    dependsOn: step.depends_on.filter(
      (value): value is SchedulerStep["dependsOn"][number] =>
        typeof value === "string" && /^step-\d+$/.test(value),
    ),
    completionCriteria: step.completion_criteria.filter(
      (value): value is string => typeof value === "string",
    ),
    status: step.status,
    blockedBy: step.blocked_by.filter((value): value is string => typeof value === "string"),
    result: step.result,
    origin: "base",
  };
}

function playbookFor(state: WorkflowState): PlaybookDefinition {
  const id = state.run.playbook.initial.id;
  const definition = PLAYBOOK_DEFINITIONS.find(({ id: candidate }) => candidate === id);
  if (definition === undefined) {
    throw new Error(`Unsupported workflow Playbook: ${JSON.stringify(id)}`);
  }
  return definition;
}

function agentFor(step: SchedulerStep): AgentDefinition {
  const definition = AGENT_DEFINITIONS.find(({ id }) => id === step.agent);
  if (definition === undefined) {
    throw new Error(`Unknown Workflow Agent: ${step.agent}`);
  }
  return definition;
}

function artifactReferences(state: WorkflowState): readonly ArtifactRef[] {
  const references: ArtifactRef[] = [];
  const seen = new Set<string>();

  for (const step of state.snapshot.steps.steps) {
    const artifacts = step.result?.artifacts;
    if (artifacts === undefined) continue;
    if (!Array.isArray(artifacts)) {
      throw new Error(`Step ${step.id} contains invalid Artifact references`);
    }

    for (const value of artifacts) {
      if (!isRecord(value)) {
        throw new Error(`Step ${step.id} contains an invalid Artifact reference`);
      }
      if (
        typeof value.runId !== "string" ||
        !RUN_ID_PATTERN.test(value.runId) ||
        typeof value.path !== "string" ||
        value.path.length === 0 ||
        (value.status !== "complete" && value.status !== "partial")
      ) {
        throw new Error(`Step ${step.id} contains an invalid Artifact reference`);
      }
      const ref = {
        runId: value.runId as RunId,
        path: value.path,
        status: value.status,
      } as ArtifactRef;
      const key = `${ref.runId}\u0000${ref.path}\u0000${ref.status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push(ref);
    }
  }

  return references;
}

async function productionContextPack(
  state: WorkflowState,
  step: SchedulerStep,
  artifactReader: ArtifactReader,
): Promise<ReturnType<typeof buildContext>> {
  const candidates: ContextCandidate[] = [
    {
      ref: "requirement",
      content: state.snapshot.requirement as unknown as JsonObject,
      priority: "authoritative-state",
    },
    {
      ref: "decisions",
      content: state.snapshot.decisions as unknown as JsonObject,
      priority: "resolved-decisions",
    },
    {
      ref: "repository",
      content: state.run.repository,
      priority: "current-evidence",
    },
    {
      ref: "current-plan",
      content: state.run.current_plan ?? {},
      priority: "current-plan",
    },
    {
      ref: "current-step",
      content: step as unknown as JsonObject,
      priority: "current-evidence",
    },
    {
      ref: "uncertainties",
      content: state.snapshot.uncertainties as unknown as JsonObject,
      priority: "supporting-evidence",
    },
  ];

  for (const ref of artifactReferences(state)) {
    const artifact = await artifactReader.read(ref);
    candidates.push({
      ref: `artifact:${ref.path}`,
      content: artifact.body,
      priority: "required-artifact",
      artifactRef: ref.path,
    });
  }

  return buildContext({
    candidates,
    budget: CONTEXT_BUDGET,
    requirementRevision: state.snapshot.requirement.revision,
    decisionRefs: state.snapshot.decisions.decisions
      .filter(({ status }) => status === "resolved")
      .map(({ id }) => id),
    uncertaintyRefs: state.snapshot.uncertainties.uncertainties
      .filter(({ status }) => status === "resolved" || status === "accepted")
      .map(({ id }) => id),
  });
}

function thinkingLevel(context: ProductionCommandContext): string {
  if (context.thinkingLevel === undefined) return "low";
  if (
    typeof context.thinkingLevel !== "string" ||
    !(THINKING_LEVELS as readonly string[]).includes(context.thinkingLevel)
  ) {
    throw new Error(`Unsupported Pi thinking level: ${String(context.thinkingLevel)}`);
  }
  return context.thinkingLevel;
}

async function buildProductionRequest(
  input: Readonly<{
    state: WorkflowState;
    step: SchedulerStep;
    iteration: number;
  }>,
  execution: ProductionExecution,
  context: ProductionCommandContext,
  artifactReader: ArtifactReader,
  idAllocator: ReturnType<typeof createIdAllocator>,
): Promise<AgentExecutionRequestV1> {
  const definition = agentFor(input.step);
  const skillReferences = (definition.primarySkills ?? []).map((id) => ({
    id,
    version: "1.0.0",
  }));
  execution.skillCatalog.resolveForAgent(definition.id, skillReferences);

  const requestedCapabilities = ["repository-read"];
  const missingCapabilities = requestedCapabilities.filter(
    (capability) => execution.toolCatalog.resolve(capability) === undefined,
  );
  if (missingCapabilities.length > 0) {
    throw new Error(`Pi Tool resolution is missing: ${missingCapabilities.join(", ")}`);
  }

  const contextPack = await productionContextPack(input.state, input.step, artifactReader);
  const request = {
    identity: {
      runId: input.state.run.run_id,
      stepId: input.step.id,
      executionId: idAllocator.issueExecutionId() as ExecutionId,
      agentId: definition.id,
      agentVersion: definition.version,
    },
    objective: {
      objective: input.step.objective,
      type: input.step.type,
      completionCriteria: input.step.completionCriteria,
    },
    retry: { attempt: 1, context: null },
    execution: {
      mode: definition.mode,
      timeoutMs: COMMAND_TIMEOUT_MS,
      cancellationPolicy: {},
    },
    authority: {
      maximumDLevel: definition.maximumNormalAuthority,
      escalationRules: [],
    },
    permissions: {
      filesystem: ["repository"],
      shell: [],
      git: [],
      network: [],
      repositoryTargets: ["."],
    },
    skills: { required: skillReferences, optional: [] },
    tools: { resolved: [], policy: {} },
    model: {
      requested: execution.modelCandidates[0]!,
      actual: null,
      thinkingLevel: thinkingLevel(context),
      allowedFallback: execution.modelCandidates.slice(1),
    },
    context: {
      pack: contextPack.pack,
      manifest: contextPack.manifest,
      artifactRefs: contextPack.artifactRefs,
    },
    outputs: { expectedArtifactTypes: [], outputContract: {} },
  } as const;

  return execution.executionResolver.resolve(request, requestedCapabilities);
}

function completedStep(state: WorkflowState, type: SchedulerStep["type"]): boolean {
  return state.snapshot.steps.steps.some(
    (step) => step.type === type && step.status === "completed",
  );
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T | undefined {
  return typeof value === "string" && values.includes(value as T) ? (value as T) : undefined;
}

function acceptanceCriteria(
  state: WorkflowState,
): readonly { status: AcceptanceCriterionStatus }[] {
  return state.snapshot.requirement.acceptance_criteria.map((value) => {
    const raw = typeof value === "string" ? value : isRecord(value) ? value.status : undefined;
    return {
      status:
        enumValue(raw, ACCEPTANCE_CRITERION_STATUSES) ??
        ("not-verifiable" as AcceptanceCriterionStatus),
    };
  });
}

function constraints(state: WorkflowState): readonly { status: ConstraintStatus }[] {
  return state.snapshot.requirement.constraints.map((value) => {
    const raw = typeof value === "string" ? value : isRecord(value) ? value.status : undefined;
    return {
      status: enumValue(raw, CONSTRAINT_STATUSES) ?? ("not-evaluated" as ConstraintStatus),
    };
  });
}

function productionCompletion(state: WorkflowState): ReturnType<typeof evaluateCompletion> {
  const definition = playbookFor(state);
  const requiredSteps = state.snapshot.steps.steps.map((step) => {
    const definitionStep = definition.baseGraph.find(
      ({ objective }) => objective === step.objective,
    );
    return {
      status: step.status,
      required: definitionStep?.required !== false,
    };
  });
  const planApplicability = enumValue(state.run.current_plan?.applicability?.status, [
    "current",
    "compatible",
  ] as const);
  const implementationPresent = state.snapshot.steps.steps.some(
    (step) => step.type === "implementation",
  );
  const implementationComplete = !implementationPresent || completedStep(state, "implementation");
  const verificationRequired = definition.gatePolicy.verification === "required";
  const reviewRequired = definition.gatePolicy.review === "required";
  const verificationPresent = completedStep(state, "verification");
  const reviewPresent = completedStep(state, "review");

  return evaluateCompletion({
    steps: requiredSteps,
    requirement: {
      acceptanceCriteria: acceptanceCriteria(state),
      constraints: constraints(state),
    },
    plan:
      definition.id === "investigation"
        ? { required: false }
        : {
            required: true,
            ...(planApplicability === undefined ? {} : { applicability: planApplicability }),
          },
    implementation: {
      reconciled: implementationComplete,
      currentChangesExplained: implementationComplete,
    },
    repository: (() => {
      const classification = enumValue(state.run.repository.classification, [
        "clean",
        "unrelated",
        "relevant",
        "critical",
        "unknown",
      ] as const);
      const resolution = enumValue(state.run.repository.resolution, [
        "clear",
        "unresolved",
        "reconciled",
      ] as const);
      return {
        ...(classification === undefined ? {} : { classification }),
        ...(resolution === undefined ? {} : { resolution }),
      };
    })(),
    verification: verificationRequired
      ? {
          required: true,
          present: verificationPresent,
          freshness: verificationPresent ? "fresh" : "unknown",
          result: verificationPresent ? "passed" : "incomplete",
        }
      : { required: false },
    review: reviewRequired
      ? {
          required: true,
          present: reviewPresent,
          freshness: reviewPresent ? "fresh" : "unknown",
          result: reviewPresent ? "clean" : "incomplete",
          complete: reviewPresent,
          findings: [],
        }
      : { required: false },
    controlState: {
      uncertainties: state.snapshot.uncertainties.uncertainties,
      decisions: state.snapshot.decisions.decisions,
      gates: state.snapshot.gates.gates,
      terminalError: state.run.failure !== null || state.run.status === "failed",
    },
  });
}

function productionSchedule(state: WorkflowState): SchedulerResult {
  if (state.run.status === "blocked") {
    return { kind: "idle", reason: "RECOVERABLE_BLOCKER" };
  }
  if (state.run.status === "failed" || state.run.finalized) {
    return { kind: "idle", reason: "RUN_TERMINAL" };
  }
  return selectNextStep({
    steps: state.snapshot.steps.steps.map(schedulerStep),
    gates: state.snapshot.gates.gates,
    runComplete: state.run.status === "completed",
    runTerminal: state.run.finalized,
  });
}

function productionPostconditions(
  input: Readonly<{
    state: WorkflowState;
    result: StepResultV1;
    step: SchedulerStep;
  }>,
): WorkflowState {
  const stepStatus = input.result.outcome;
  const currentSteps = input.state.snapshot.steps.steps.map((step) =>
    step.id === input.step.id
      ? {
          ...step,
          status: stepStatus,
          result: input.result as unknown as JsonObject,
        }
      : step,
  );
  const completed = new Set<string>(
    currentSteps
      .filter(({ status }) => status === "completed" || status === "skipped")
      .map(({ id }) => id),
  );
  const steps = currentSteps.map((step) => {
    if (step.status !== "pending") return step;
    const dependencies = step.depends_on.filter(
      (value): value is string => typeof value === "string",
    );
    return dependencies.length === step.depends_on.length &&
      dependencies.every((id) => completed.has(id))
      ? { ...step, status: "ready" as const }
      : step;
  });

  const status = stepStatus === "completed" ? "running" : stepStatus;
  return {
    ...input.state,
    run: {
      ...input.state.run,
      status,
      current_step: {
        id: input.step.id,
        execution_id: input.result.identity.executionId,
        status: stepStatus,
      },
      blocked: stepStatus === "blocked" ? input.result.blocked : null,
      failure: stepStatus === "failed" ? input.result.failure : null,
      current_plan:
        input.step.type === "planning"
          ? {
              ...input.state.run.current_plan,
              applicability: { status: "current" },
            }
          : input.state.run.current_plan,
    },
    snapshot: {
      ...input.state.snapshot,
      steps: { ...input.state.snapshot.steps, steps },
    },
  };
}

async function createProductionUseCases(
  pi: PiRuntimeFacilities | undefined,
  value: unknown,
): Promise<WorkflowUseCases> {
  const context = productionContext(value);
  const repository: RepositoryAdapter = new GitRepositoryAdapter(context.cwd);
  const repositoryRoot = await repository.getRoot();
  const runLock = new FileRunLock(repositoryRoot);
  const runReader = new FileRunReader(repositoryRoot);
  const stateStore = new FileStateStore(repositoryRoot, { reader: runReader, runLock });
  const artifactStore = new FileArtifactStore(repositoryRoot);
  const artifactReader = new FileArtifactReader(repositoryRoot);
  const workspaceLock = new FileWorkspaceLock(repositoryRoot);
  const idAllocator = createIdAllocator();

  let piAgentRuntime: PiSubagentsAdapter | undefined;
  const agentRuntime: AgentRuntime = {
    run: (request, signal) => {
      piAgentRuntime ??= new PiSubagentsAdapter(requirePiFacilities(pi), {
        cwd: repositoryRoot,
      } satisfies PiSubagentsAdapterOptions);
      return piAgentRuntime.run(request, signal);
    },
  };

  let executionPromise: Promise<ProductionExecution> | undefined;
  const execution = (): Promise<ProductionExecution> => {
    executionPromise ??= Promise.resolve().then(() => {
      const models = availableModels(context);
      if (models.length === 0) {
        throw new Error("Production workflow runtime requires an available Pi model");
      }
      const toolCatalog = createPiToolCatalog(pi);
      return {
        agentRuntime,
        executionResolver: new ExecutionResolver({
          modelCatalog: modelCatalog(models),
          toolCatalog,
        }),
        skillCatalog: createPiSkillCatalog(context),
        modelCandidates: models,
        toolCatalog,
      };
    });
    return executionPromise;
  };

  const cancellation: CancellationLifecycle = new CancellationLifecycle({
    runReader,
    stateStore,
    artifactStore,
    artifactReader,
    idAllocator,
  });
  const repositoryFreshness = async (state: WorkflowState): Promise<WorkflowState> => {
    const before = persistedRepositorySnapshot(state);
    const after = await repository.captureSnapshot();
    const diff = await repository.diff(before, after);
    if (
      diff.changedFiles.length > 0 ||
      diff.headChanged ||
      diff.branchChanged ||
      diff.statusChanged ||
      diff.fingerprintChanged
    ) {
      throw new Error(`Cannot resume ${state.run.run_id}: consuming repository has changed`);
    }
    const value = repositorySnapshotValue(after);
    return {
      ...state,
      run: {
        ...state.run,
        repository: {
          ...state.run.repository,
          ...value,
          freshness: "fresh",
        } as unknown as typeof state.run.repository,
      },
    };
  };
  const resumeLifecycle = new ResumeLifecycle({
    runReader,
    stateStore,
    recheckRepositoryAndFreshness: repositoryFreshness,
  });
  const workerFinalizer = new WorkerFinalizer({ artifactStore, idAllocator });
  const interruptedExecutionRecovery = new InterruptedExecutionRecovery({
    repository,
    workerFinalizer,
  });
  const workerSnapshots = new Map<
    ExecutionId,
    Readonly<{
      before: RepositorySnapshot;
      executionStateRevision: number;
    }>
  >();
  const productionCancellation: CancellationCoordinator = {
    isRequested: (runId) => cancellation.isRequested(runId),
    register: (execution: CancellationExecution) => {
      const workerSnapshot = workerSnapshots.get(execution.request.identity.executionId);
      const reconcile =
        workerSnapshot === undefined || execution.request.identity.agentId !== "worker"
          ? execution.reconcile
          : async () => {
              await interruptedExecutionRecovery.recover({
                request: execution.request,
                before: workerSnapshot.before,
                executionStateRevision: workerSnapshot.executionStateRevision,
              });
            };
      const unregister = cancellation.register({
        ...execution,
        ...(reconcile === undefined ? {} : { reconcile }),
      });
      return () => {
        workerSnapshots.delete(execution.request.identity.executionId);
        unregister();
      };
    },
  };

  const orchestratorSource = (userInteraction?: UserInteraction) => {
    const orchestrator = new Orchestrator({
      runReader,
      stateStore,
      agentRuntime,
      buildRequest: async ({ state, step, iteration }) => {
        const request = await buildProductionRequest(
          { state, step, iteration },
          await execution(),
          context,
          artifactReader,
          idAllocator,
        );
        if (request.identity.agentId === "worker") {
          workerSnapshots.set(request.identity.executionId, {
            before: await repository.captureSnapshot(),
            executionStateRevision: state.run.state_revision,
          });
        }
        return request;
      },
      completion: productionCompletion,
      schedule: productionSchedule,
      postconditions: productionPostconditions,
      artifactReader,
      cancellation: productionCancellation,
      ...(userInteraction === undefined ? {} : { userInteraction }),
      idAllocator,
    });

    return {
      run: async (runId: RunId) => {
        const lock = await workspaceLock.acquire({ recoverStale: true });
        try {
          return await orchestrator.run(runId);
        } finally {
          await lock.release();
        }
      },
    };
  };

  return createWorkflowUseCases({
    start: {
      runStore: stateStore,
      repository,
      orchestrator: orchestratorSource,
      idAllocator,
    },
    status: { runReader },
    resume: { lifecycle: resumeLifecycle, orchestrator: orchestratorSource },
    cancel: { lifecycle: cancellation },
  });
}

function createProductionRuntimeFactory(
  pi: PiRuntimeFacilities | undefined,
): ProductionRuntimeFactory {
  const runtimes = new Map<string, Promise<RuntimeUseCases>>();
  return (value) => {
    const context = productionContext(value);
    const key = resolvePath(context.cwd);
    const existing = runtimes.get(key);
    if (existing !== undefined) return existing;
    const runtime = createProductionUseCases(pi, context);
    runtimes.set(key, runtime);
    return runtime;
  };
}

export function createPiUserInteraction(
  ui: Pick<ExtensionUIContext, "select" | "confirm" | "input">,
): UserInteraction {
  return new PiUserInteractionAdapter(ui);
}

function isStartWorkflowCommand(
  command: WorkflowCommand,
): command is (typeof START_WORKFLOW_COMMANDS)[number] {
  return START_WORKFLOW_COMMANDS.some((candidate) => candidate === command);
}

function parseArguments(args: string, command: "wf-status" | "wf-resume" | "wf-cancel"): string[] {
  if (typeof args !== "string") {
    throw new TypeError(`/${command} arguments must be text`);
  }
  const values = args.trim().split(/\s+/).filter(Boolean);
  if (values.length === 0) {
    throw new Error(`/${command} requires a Run ID (run-<number>)`);
  }
  return values;
}

function parseRunId(args: string, command: "wf-status" | "wf-resume"): RunId {
  const values = parseArguments(args, command);
  if (values.length !== 1 || !RUN_ID_PATTERN.test(values[0] ?? "")) {
    throw new Error(`/${command} requires exactly one Run ID (run-<number>)`);
  }
  return values[0] as RunId;
}

function parseCancelArguments(args: string): Readonly<{ runId: RunId; reason?: string }> {
  const values = parseArguments(args, "wf-cancel");
  const rawRunId = values[0] ?? "";
  if (!RUN_ID_PATTERN.test(rawRunId)) {
    throw new Error("/wf-cancel requires a Run ID (run-<number>)");
  }
  const reason = values.slice(1).join(" ");
  return reason.length === 0 ? { runId: rawRunId as RunId } : { runId: rawRunId as RunId, reason };
}

function commandSummary(command: "resume" | "cancel", state: WorkflowState): string {
  const action = command === "resume" ? "resumed" : "cancelled";
  return renderWorkflowResponse(state).replace(
    `Run ${state.run.run_id}:`,
    `Run ${state.run.run_id} ${action}:`,
  );
}

function hasInjectedUseCases(dependencies: RuntimeUseCases): boolean {
  return (
    dependencies.startWorkflow !== undefined ||
    dependencies.statusWorkflow !== undefined ||
    dependencies.resumeWorkflow !== undefined ||
    dependencies.cancelWorkflow !== undefined
  );
}

function requiredUseCase<T>(useCase: T | undefined, name: string): T {
  if (useCase === undefined) {
    throw new Error(`Workflow ${name} use case is not configured`);
  }
  return useCase;
}

function createRuntimeHandler(
  dependencies: RuntimeUseCases,
  productionFactory: ProductionRuntimeFactory | undefined,
): WorkflowCommandHandler {
  const injected = hasInjectedUseCases(dependencies);
  return {
    async execute(
      command: WorkflowCommand,
      args: string,
      userInteraction?: UserInteraction,
      context?: unknown,
    ): Promise<WorkflowCommandOutput | void> {
      const runtime = injected
        ? dependencies
        : productionFactory === undefined
          ? (() => {
              throw new Error("Production workflow runtime is unavailable");
            })()
          : await productionFactory(context);

      if (isStartWorkflowCommand(command)) {
        const useCase = requiredUseCase(runtime.startWorkflow, "start");
        const state =
          userInteraction === undefined
            ? await useCase.execute(command, args)
            : await useCase.execute(command, args, userInteraction);
        return state === undefined ? undefined : renderWorkflowResponse(state);
      }

      if (command === "status") {
        return renderWorkflowResponse(
          await requiredUseCase(runtime.statusWorkflow, "status").execute(
            parseRunId(args, "wf-status"),
          ),
        );
      }

      if (command === "resume") {
        const runId = parseRunId(args, "wf-resume");
        const useCase = requiredUseCase(runtime.resumeWorkflow, "resume");
        const state =
          userInteraction === undefined
            ? await useCase.execute(runId)
            : await useCase.execute(runId, userInteraction);
        return commandSummary(command, state);
      }

      const useCase = requiredUseCase(runtime.cancelWorkflow, "cancel");
      const { runId, reason } = parseCancelArguments(args);
      const state =
        reason === undefined
          ? await useCase.execute(runId)
          : await useCase.execute(runId, { requestedBy: "user", reason });
      return commandSummary(command, state);
    },
  };
}

export function createWorkflowRuntime(
  dependencies: WorkflowRuntimeDependencies = {},
): WorkflowCommandHandler {
  if (dependencies.commandHandler !== undefined) return dependencies.commandHandler;
  return createRuntimeHandler(
    dependencies,
    hasInjectedUseCases(dependencies) ? undefined : createProductionRuntimeFactory(dependencies.pi),
  );
}
