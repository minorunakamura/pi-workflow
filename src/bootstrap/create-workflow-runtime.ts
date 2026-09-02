import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
  Skill as PiSkill,
} from "@earendil-works/pi-coding-agent";
import { stringify as stringifyYaml } from "yaml";
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
import {
  ReviewerFinalizer,
  type ReviewerFinalization,
} from "../application/execution/reviewer-finalizer.js";
import { VerifierFinalizer } from "../application/execution/verifier-finalizer.js";
import {
  WorkerFinalizer,
  type WorkerFinalization,
  writeScopePaths,
} from "../application/execution/worker-finalizer.js";
import type { ResultNormalizationResult } from "../application/normalization/result-normalizer.js";
import { Orchestrator } from "../application/orchestrator.js";
import { buildContext, type ContextCandidate } from "../application/context/context-builder.js";
import {
  CancellationLifecycle,
  type CancellationCoordinator,
  type CancellationExecution,
} from "../application/recovery/cancellation-lifecycle.js";
import { FailureLifecycle } from "../application/recovery/failure-lifecycle.js";
import { InterruptedExecutionRecovery } from "../application/recovery/interrupted-execution-recovery.js";
import { RepositoryDriftRecovery } from "../application/recovery/repository-drift-recovery.js";
import { ResumeLifecycle } from "../application/recovery/resume-lifecycle.js";
import {
  createWorkflowUseCases,
  type WorkflowUseCases,
} from "../application/workflow-use-cases.js";
import { assemblePrompt } from "../application/prompt/prompt-assembler.js";
import {
  selectNextStep,
  type SchedulerResult,
  type SchedulerStep,
} from "../domain/scheduling/scheduler.js";
import {
  createIdAllocator,
  type ExecutionId,
  type IdAllocator,
  type RunId,
  type StepId,
} from "../domain/primitives/ids.js";
import {
  addDynamicStep,
  createStep,
  createStepGraph,
  type Step,
} from "../domain/graph/step-graph.js";
import {
  createRequirement,
  reviseRequirement,
  type RequirementCandidate,
} from "../domain/requirements/requirement.js";
import { PLAYBOOK_DEFINITIONS, type PlaybookDefinition } from "../playbooks/definitions.js";
import type { AgentRuntime } from "../ports/agent-runtime.js";
import type {
  JsonObject,
  JsonValue,
  AgentExecutionRequestV1,
  StepResultV1,
} from "../contracts/execution/agent-execution.js";
import { ArtifactFrontMatterV1Schema } from "../contracts/artifacts/artifact.js";
import type { ArtifactReader, ArtifactRef, ArtifactStore } from "../ports/artifact-store.js";
import { redactSecrets } from "../telemetry/redaction.js";
import type {
  RepositoryAdapter,
  RepositoryDiff,
  RepositoryScope,
  RepositorySnapshot,
} from "../ports/repository.js";
import type { ModelCatalog, ModelReference } from "../ports/model-catalog.js";
import type { ToolCatalog, ToolDefinition } from "../ports/tool-catalog.js";
import type { UserInteraction } from "../ports/user-interaction.js";
import type { WorkflowState } from "../ports/run-reader.js";
import type { StepStateV1 } from "../contracts/state/workflow-state.js";

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
  write: ["repository-write"],
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
    sessionManager?: Readonly<{ getSessionId(): string }>;
    thinkingLevel?: string;
  }>;

type ProductionRuntimeFactory = (context: unknown) => Promise<RuntimeUseCases>;

type ProductionExecution = Readonly<{
  agentRuntime: AgentRuntime;
  executionResolver: ExecutionResolver;
  skillCatalog: SkillCatalog;
  modelCandidates: readonly ModelReference[];
  toolCatalog: ToolCatalog;
  toolNames: readonly string[];
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

function createPiToolNames(pi: PiRuntimeFacilities | undefined): readonly string[] {
  const names = new Set<string>();
  const tools = typeof pi?.getAllTools === "function" ? pi.getAllTools() : [];
  for (const candidate of tools) {
    if (!isRecord(candidate) || typeof candidate.name !== "string") continue;
    const name = candidate.name.trim();
    if (name.length > 0 && toolCapabilities(name).length > 0) names.add(name);
  }
  return [...names];
}

function createPiToolCatalog(toolNames: readonly string[]): ToolCatalog {
  const definitions = new Map<string, ToolDefinition>();

  for (const name of toolNames) {
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

function productionPrompt(request: AgentExecutionRequestV1, skillCatalog: SkillCatalog): string {
  const definition = AGENT_DEFINITIONS.find(({ id }) => id === request.identity.agentId);
  if (definition === undefined) {
    throw new Error(`Unknown Workflow Agent: ${request.identity.agentId}`);
  }

  const selected = [...request.skills.required, ...request.skills.optional];
  const resolvedSkills = skillCatalog.resolveForAgent(definition.id, selected);
  return assemblePrompt({
    agentDefinition: definition,
    executionRequest: request,
    contextPack: request.context,
    skillContent: resolvedSkills,
  }).content;
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
    origin: step.origin === "dynamic" ? "dynamic" : "base",
    ...(typeof step.trigger === "string" ? { trigger: step.trigger } : {}),
    ...(typeof step.skip_reason === "string" ? { skipReason: step.skip_reason } : {}),
    ...(typeof step.obsolete === "boolean" ? { obsolete: step.obsolete } : {}),
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

function planWriteScope(state: WorkflowState): readonly string[] {
  const plan = state.run.current_plan;
  if (!isRecord(plan)) return [];
  const value = plan.write_scope ?? plan.writeScope;
  return value === undefined ? [] : writeScopePaths(value as unknown as RepositoryScope);
}

function candidateWriteScope(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const direct = value.write_scope ?? value.writeScope;
  if (direct !== undefined) return direct;
  const nested = value.plan;
  if (!isRecord(nested)) return undefined;
  return nested.write_scope ?? nested.writeScope;
}

function plannedWriteScope(result: StepResultV1): readonly string[] | undefined {
  for (const candidate of [...result.observations, result.runtime]) {
    const value = candidateWriteScope(candidate);
    if (value !== undefined) return writeScopePaths(value as unknown as RepositoryScope);
  }
  return undefined;
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

  const workerScope = definition.id === "worker" ? planWriteScope(input.state) : [];
  const requestedCapabilities = [
    "repository-read",
    ...(definition.id === "worker" && workerScope.length > 0 ? ["repository-write"] : []),
  ];
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
      repositoryTargets: workerScope,
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

  const resolved = execution.executionResolver.resolve(request, requestedCapabilities);
  const allowedToolNames = execution.toolNames.filter((name) =>
    toolCapabilities(name).some((capability) => requestedCapabilities.includes(capability)),
  );
  return {
    ...resolved,
    tools: {
      ...resolved.tools,
      resolved: allowedToolNames,
      policy: { allow: allowedToolNames },
    },
  };
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
      skipAuthorized: step.status === "skipped" || step.obsolete === true,
      ...(typeof step.obsolete === "boolean" ? { obsolete: step.obsolete } : {}),
    };
  });
  const planApplicability = enumValue(state.run.current_plan?.applicability?.status, [
    "current",
    "compatible",
  ] as const);
  const implementationSteps = state.snapshot.steps.steps.filter(
    (step) => step.type === "implementation",
  );
  const implementationPresent = implementationSteps.length > 0;
  const implementationComplete =
    !implementationPresent ||
    implementationSteps.every((step) => {
      const changeSet = resultFinalization(step, "change_set");
      return (
        step.status === "completed" &&
        changeSet?.status === "complete" &&
        changeSet.accepted === true
      );
    });
  const verificationRequired = definition.gatePolicy.verification === "required";
  const reviewRequired = definition.gatePolicy.review === "required";
  const verificationStep = [...state.snapshot.steps.steps]
    .reverse()
    .find((step) => step.type === "verification" && step.status !== "skipped");
  const reviewStep = [...state.snapshot.steps.steps]
    .reverse()
    .find((step) => step.type === "review" && step.status !== "skipped");
  const verificationRun =
    verificationStep === undefined
      ? undefined
      : resultFinalization(verificationStep, "verification_run");
  const reviewRun =
    reviewStep === undefined ? undefined : resultFinalization(reviewStep, "review_run");
  const verificationPresent = verificationRun !== undefined;
  const reviewPresent = reviewRun !== undefined;
  const verificationFreshness = finalizationFreshness(state, verificationRun);
  const reviewFreshness = finalizationFreshness(state, reviewRun);

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
          freshness: verificationPresent ? verificationFreshness : "unknown",
          result:
            enumValue(verificationRun?.result, ["passed", "failed", "incomplete"] as const) ??
            "incomplete",
          limitationAccepted: false,
        }
      : { required: false },
    review: reviewRequired
      ? {
          required: true,
          present: reviewPresent,
          freshness: reviewPresent ? reviewFreshness : "unknown",
          result:
            enumValue(reviewRun?.result, ["clean", "findings", "incomplete"] as const) ??
            "incomplete",
          complete: reviewRun?.status === "complete",
          findings: state.snapshot.findings.findings,
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

const PRODUCTION_MAX_DYNAMIC_STEPS = 3;
const CANDIDATE_DECISION_CLASSES = ["D1", "D2", "D3"] as const;
const CANDIDATE_UNCERTAINTY_CATEGORIES = [
  "requirement",
  "behavior",
  "design",
  "external",
  "impact",
  "verification",
] as const;

type ProductionDynamicStepInput = Readonly<{
  objective: string;
  type: Step["type"];
  agent: string;
  dependsOn: readonly StepId[];
  trigger: string;
}>;

type ProductionDynamicStepResult = Readonly<{
  state: WorkflowState;
  id?: StepId;
  added: boolean;
}>;

function artifactValue(ref: ArtifactRef): JsonObject {
  return { runId: ref.runId, path: ref.path, status: ref.status };
}

function resultFinalization(
  step: WorkflowState["snapshot"]["steps"]["steps"][number],
  key: string,
): Record<string, unknown> | undefined {
  const finalization = isRecord(step.result?.finalization) ? step.result.finalization : undefined;
  const value = finalization?.[key];
  return isRecord(value) ? value : undefined;
}

function finalizationFreshness(
  state: WorkflowState,
  finalization: Record<string, unknown> | undefined,
): "fresh" | "stale" | "unknown" {
  if (finalization === undefined) return "unknown";
  if (finalization.freshness === "stale") return "stale";
  if (finalization.freshness === "unknown") return "unknown";
  const basis = isRecord(finalization.basis) ? finalization.basis : undefined;
  if (typeof basis?.requirement_revision !== "number") return "unknown";
  if (basis.requirement_revision !== state.snapshot.requirement.revision) return "stale";
  const planVersion =
    typeof state.run.current_plan?.version === "number"
      ? state.run.current_plan.version
      : undefined;
  if (planVersion === undefined) return "fresh";
  if (typeof basis.plan_version !== "number") return "unknown";
  return basis.plan_version === planVersion ? "fresh" : "stale";
}

function resultArray(
  step: WorkflowState["snapshot"]["steps"]["steps"][number],
  key: string,
): readonly unknown[] {
  const value = step.result?.[key];
  return Array.isArray(value) ? value : [];
}

function hasRequirementCandidates(
  step: WorkflowState["snapshot"]["steps"]["steps"][number],
): boolean {
  const candidates = isRecord(step.result?.requirement_candidates)
    ? step.result.requirement_candidates
    : undefined;
  return (
    (Array.isArray(candidates?.acceptance_criteria) && candidates.acceptance_criteria.length > 0) ||
    (Array.isArray(candidates?.constraints) && candidates.constraints.length > 0) ||
    (Array.isArray(candidates?.assumptions) && candidates.assumptions.length > 0)
  );
}

function attachFinalization(
  state: WorkflowState,
  stepId: StepId,
  artifact: ArtifactRef,
  details: JsonObject,
): WorkflowState {
  let found = false;
  const steps = state.snapshot.steps.steps.map((step) => {
    if (step.id !== stepId) return step;
    found = true;
    const current = step.result ?? {};
    const artifacts = Array.isArray(current.artifacts) ? current.artifacts : [];
    const reference = artifactValue(artifact);
    const alreadyReferenced = artifacts.some(
      (value) =>
        isRecord(value) &&
        value.runId === reference.runId &&
        value.path === reference.path &&
        value.status === reference.status,
    );
    return {
      ...step,
      result: {
        ...current,
        artifacts: alreadyReferenced ? artifacts : [...artifacts, reference],
        finalization: details,
      } as JsonObject,
    };
  });
  if (!found) throw new Error(`Cannot attach finalization to unknown Step ${stepId}`);
  return { ...state, snapshot: { ...state.snapshot, steps: { ...state.snapshot.steps, steps } } };
}

function candidateWithoutIdentity(candidate: JsonObject): RequirementCandidate {
  return Object.fromEntries(
    Object.entries(candidate).filter(([key]) => key !== "id"),
  ) as unknown as RequirementCandidate;
}

function candidateEnum<T extends readonly string[]>(
  value: unknown,
  values: T,
  name: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number])) {
    throw new Error(`${name} must be one of ${values.join(", ")}`);
  }
  return value as T[number];
}

function applyRequirementCandidates(
  state: WorkflowState,
  candidates: ResultNormalizationResult["candidates"]["requirement_candidates"],
): WorkflowState {
  const mutations = [
    ...candidates.acceptance_criteria.map((candidate) => ({
      kind: "acceptanceCriteria" as const,
      candidate: candidateWithoutIdentity(candidate),
    })),
    ...candidates.constraints.map((candidate) => ({
      kind: "constraints" as const,
      candidate: candidateWithoutIdentity(candidate),
    })),
    ...candidates.assumptions.map((candidate) => ({
      kind: "assumptions" as const,
      candidate: candidateWithoutIdentity(candidate),
    })),
  ];
  if (mutations.length === 0) return state;

  const current = state.snapshot.requirement;
  const revised = reviseRequirement(
    createRequirement({
      revision: current.revision,
      acceptanceCriteria: current.acceptance_criteria as unknown as readonly {
        id: string;
        [key: string]: unknown;
      }[],
      constraints: current.constraints as unknown as readonly {
        id: string;
        [key: string]: unknown;
      }[],
      assumptions: current.assumptions,
    }),
    mutations,
  );
  const planImpact = revised.impact.planImpact;
  const currentPlan = state.run.current_plan;
  const nextPlan =
    currentPlan === null || planImpact === "current"
      ? currentPlan
      : {
          ...currentPlan,
          applicability: {
            ...currentPlan.applicability,
            status: planImpact,
          },
        };

  return {
    ...state,
    run: { ...state.run, current_plan: nextPlan },
    snapshot: {
      ...state.snapshot,
      requirement: {
        ...current,
        revision: revised.requirement.revision,
        acceptance_criteria: revised.requirement
          .acceptanceCriteria as unknown as readonly JsonValue[],
        constraints: revised.requirement.constraints as unknown as readonly JsonValue[],
        assumptions: revised.requirement.assumptions as unknown as readonly JsonValue[],
      },
    },
  };
}

function applyProductionCandidates(
  state: WorkflowState,
  candidates: ResultNormalizationResult["candidates"],
): WorkflowState {
  const uncertaintyCandidates = candidates.uncertainty_candidates.map((candidate) => ({
    ...candidate,
    id: candidate.id,
    category: candidateEnum(
      candidate.category,
      CANDIDATE_UNCERTAINTY_CATEGORIES,
      "Uncertainty candidate category",
    ),
    status: "open" as const,
  }));
  const decisionCandidates = candidates.decision_requests.map((candidate) => ({
    ...candidate,
    id: candidate.id,
    class: candidateEnum(candidate.class, CANDIDATE_DECISION_CLASSES, "Decision candidate class"),
    status: "pending" as const,
  }));
  const withCandidates = {
    ...state,
    snapshot: {
      ...state.snapshot,
      uncertainties: {
        ...state.snapshot.uncertainties,
        uncertainties: [...state.snapshot.uncertainties.uncertainties, ...uncertaintyCandidates],
      },
      decisions: {
        ...state.snapshot.decisions,
        decisions: [...state.snapshot.decisions.decisions, ...decisionCandidates],
      },
    },
  };
  let next = applyRequirementCandidates(withCandidates, candidates.requirement_candidates);
  if (candidates.plan_deviations.length > 0 && next.run.current_plan !== null) {
    next = {
      ...next,
      run: {
        ...next.run,
        current_plan: {
          ...next.run.current_plan,
          applicability: {
            ...next.run.current_plan.applicability,
            status: "replan-required",
          },
        },
      },
    };
  }
  return next;
}

function productionDynamicLimit(state: WorkflowState): number {
  const value = state.run.limits.max_dynamic_steps;
  if (value === undefined) return PRODUCTION_MAX_DYNAMIC_STEPS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("max_dynamic_steps must be a non-negative safe integer");
  }
  return value;
}

function productionDomainStep(value: StepStateV1): Step {
  return createStep({
    id: value.id,
    type: value.type,
    objective: value.objective,
    agent: value.agent,
    skills: value.skills.filter((entry): entry is string => typeof entry === "string"),
    inputs: value.inputs,
    outputs: value.outputs,
    dependsOn: value.depends_on.filter((entry): entry is StepId => typeof entry === "string"),
    completionCriteria: value.completion_criteria.filter(
      (entry): entry is string => typeof entry === "string",
    ),
    status: value.status,
    blockedBy: value.blocked_by.filter((entry): entry is string => typeof entry === "string"),
    result: value.result,
    origin: value.origin === "dynamic" ? "dynamic" : "base",
    ...(typeof value.trigger === "string" ? { trigger: value.trigger } : {}),
    ...(typeof value.skip_reason === "string" ? { skipReason: value.skip_reason } : {}),
    ...(typeof value.obsolete === "boolean" ? { obsolete: value.obsolete } : {}),
  });
}

function productionStateStep(step: Step, previous: StepStateV1 | undefined): StepStateV1 {
  return {
    ...previous,
    id: step.id,
    type: step.type,
    objective: step.objective,
    agent: step.agent,
    skills: previous?.skills ?? [...step.skills],
    inputs: previous?.inputs ?? [],
    outputs: previous?.outputs ?? [],
    depends_on: [...step.dependsOn],
    completion_criteria: [...step.completionCriteria],
    status: step.status,
    blocked_by: [...step.blockedBy],
    result: step.result as JsonObject | null,
    origin: step.origin,
    ...(step.trigger === undefined ? {} : { trigger: step.trigger }),
    ...(step.skipReason === undefined ? {} : { skip_reason: step.skipReason }),
    ...(step.obsolete === undefined ? {} : { obsolete: step.obsolete }),
  };
}

function syncProductionGraph(
  state: WorkflowState,
  graph: ReturnType<typeof createStepGraph>,
): WorkflowState {
  const previous = new Map(state.snapshot.steps.steps.map((step) => [step.id, step]));
  return {
    ...state,
    run: { ...state.run, graph_revision: graph.graphRevision },
    snapshot: {
      ...state.snapshot,
      steps: {
        ...state.snapshot.steps,
        graph_revision: graph.graphRevision,
        steps: graph.steps.map((step) => productionStateStep(step, previous.get(step.id))),
      },
    },
  };
}

function addProductionDynamicStep(
  state: WorkflowState,
  input: ProductionDynamicStepInput,
  idAllocator: IdAllocator,
): ProductionDynamicStepResult {
  const graph = createStepGraph(
    state.snapshot.steps.steps.map(productionDomainStep),
    state.snapshot.steps.graph_revision,
  );
  const existing = graph.steps.find(
    (step) =>
      step.objective === input.objective &&
      step.status !== "completed" &&
      step.status !== "skipped",
  );
  if (existing !== undefined) return { state, id: existing.id, added: false };

  const used = new Set(graph.steps.map((step) => step.id));
  let id: StepId;
  do {
    id = idAllocator.issueStepId();
  } while (used.has(id));
  const next = addDynamicStep(
    graph,
    {
      id,
      type: input.type,
      objective: input.objective,
      agent: input.agent,
      dependsOn: input.dependsOn,
      status: "ready",
      trigger: input.trigger,
    },
    productionDynamicLimit(state),
  );
  return { state: syncProductionGraph(state, next), id, added: true };
}

function lastCompletedStepId(state: WorkflowState): StepId | undefined {
  return [...state.snapshot.steps.steps].reverse().find((step) => step.status === "completed")?.id;
}

function counterNumber(state: WorkflowState, key: string): number | undefined {
  const value = state.run.counters[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function markProductionTrigger(state: WorkflowState, key: string, value: number): WorkflowState {
  return {
    ...state,
    run: { ...state.run, counters: { ...state.run.counters, [key]: value } },
  };
}

function productionTrigger(state: WorkflowState, idAllocator: IdAllocator): WorkflowState {
  const source = lastCompletedStepId(state);
  const requirementRevision = state.snapshot.requirement.revision;
  const amendmentSource = state.snapshot.steps.steps.find(hasRequirementCandidates);
  if (
    amendmentSource !== undefined &&
    counterNumber(state, "request_amendment_handled_revision") !== requirementRevision
  ) {
    const analysis = addProductionDynamicStep(
      state,
      {
        objective: "reanalyze amended requirement",
        type: "analysis",
        agent: "scout",
        dependsOn: [amendmentSource.id],
        trigger: "request amendment",
      },
      idAllocator,
    );
    const replan = addProductionDynamicStep(
      analysis.state,
      {
        objective: "re-plan amended requirement",
        type: "planning",
        agent: "planner",
        dependsOn: [analysis.id ?? amendmentSource.id],
        trigger: "request amendment",
      },
      idAllocator,
    );
    return markProductionTrigger(
      replan.state,
      "request_amendment_handled_revision",
      requirementRevision,
    );
  }

  const deviationSource = state.snapshot.steps.steps.find(
    (step) => resultArray(step, "plan_deviations").length > 0,
  );
  const deviationCount = state.snapshot.steps.steps.reduce(
    (count, step) => count + resultArray(step, "plan_deviations").length,
    0,
  );
  if (
    deviationSource !== undefined &&
    counterNumber(state, "plan_deviation_handled_count") !== deviationCount
  ) {
    const added = addProductionDynamicStep(
      state,
      {
        objective: "re-plan after plan deviation",
        type: "planning",
        agent: "planner",
        dependsOn: [deviationSource.id],
        trigger: "plan deviation",
      },
      idAllocator,
    );
    return markProductionTrigger(added.state, "plan_deviation_handled_count", deviationCount);
  }

  const repository = state.run.repository;
  if (
    repository.resolution === "reconciled" &&
    state.run.current_plan?.applicability?.status === "replan-required" &&
    counterNumber(state, "repository_drift_replan_handled_revision") !== requirementRevision
  ) {
    const added = addProductionDynamicStep(
      state,
      {
        objective: "re-plan after repository drift",
        type: "planning",
        agent: "planner",
        dependsOn: source === undefined ? [] : [source],
        trigger: "repository drift",
      },
      idAllocator,
    );
    return markProductionTrigger(
      added.state,
      "repository_drift_replan_handled_revision",
      requirementRevision,
    );
  }
  if (
    (repository.classification === "relevant" ||
      repository.classification === "critical" ||
      repository.classification === "unknown") &&
    repository.resolution === "unresolved"
  ) {
    const added = addProductionDynamicStep(
      state,
      {
        objective: "reconcile repository drift",
        type: "analysis",
        agent: "scout",
        dependsOn: source === undefined ? [] : [source],
        trigger: "repository drift",
      },
      idAllocator,
    );
    if (added.added && state.run.status === "blocked") {
      return {
        ...added.state,
        run: { ...added.state.run, status: "running", blocked: null },
      };
    }
    return added.state;
  }

  return state;
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

  const status =
    stepStatus === "completed" || (stepStatus === "failed" && input.step.type === "verification")
      ? "running"
      : stepStatus;
  const currentPlan = input.state.run.current_plan;
  const planVersion =
    typeof currentPlan?.version === "number" && Number.isSafeInteger(currentPlan.version)
      ? currentPlan.version
      : 0;
  const isReplan = input.step.type === "planning" && input.step.objective.startsWith("re-plan");
  const nextPlan =
    input.step.type !== "planning" || stepStatus !== "completed"
      ? currentPlan
      : {
          ...(currentPlan ?? {}),
          ...(isReplan ? { version: planVersion + 1 } : { version: planVersion || 1 }),
          write_scope: plannedWriteScope(input.result) ?? [],
          applicability: { status: "current" as const },
        };
  const repositoryReconciled =
    input.step.objective === "reconcile repository drift" && stepStatus === "completed";
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
      failure: status === "failed" ? input.result.failure : null,
      current_plan: nextPlan,
      repository: repositoryReconciled
        ? { ...input.state.run.repository, resolution: "reconciled" }
        : input.state.run.repository,
    },
    snapshot: {
      ...input.state.snapshot,
      steps: { ...input.state.snapshot.steps, steps },
    },
  };
}

type ProductionExecutionSnapshot = Readonly<{
  request: AgentExecutionRequestV1;
  before: RepositorySnapshot;
  executionStateRevision: number;
}>;

function executionIdValue(state: WorkflowState, idAllocator: IdAllocator): ExecutionId {
  const value = state.run.current_step.execution_id;
  return typeof value === "string" && /^exec-\d+$/.test(value)
    ? (value as ExecutionId)
    : idAllocator.issueExecutionId();
}

function stepIdValue(state: WorkflowState, idAllocator: IdAllocator): StepId {
  const value = state.run.current_step.id;
  return typeof value === "string" && /^step-\d+$/.test(value)
    ? (value as StepId)
    : idAllocator.issueStepId();
}

function completedOutcomeContents(
  state: WorkflowState,
  stepId: StepId,
  executionId: ExecutionId,
  createdAt: string,
): string {
  const agent =
    typeof state.run.current_step.agent === "string"
      ? state.run.current_step.agent
      : "orchestrator";
  const frontMatter = ArtifactFrontMatterV1Schema.parse({
    schema_version: 1,
    run_id: state.run.run_id,
    step_id: stepId,
    execution_id: executionId,
    execution_state_revision: state.run.state_revision,
    agent: { id: agent, version: 1 },
    artifact: { type: "outcome", status: "complete" },
    created_at: createdAt,
    skills: [],
  });
  return [
    "---",
    stringifyYaml(frontMatter).trimEnd(),
    "---",
    "## Outcome",
    "",
    "```json",
    redactSecrets(
      JSON.stringify(
        {
          status: "completed",
          request_satisfied: true,
          summary: "Workflow completed",
        },
        null,
        2,
      ),
    ),
    "```",
    "",
  ].join("\n");
}

async function finalizeProductionOutcome(
  state: WorkflowState,
  artifactStore: ArtifactStore,
  idAllocator: IdAllocator,
): Promise<WorkflowState> {
  const currentOutcome = state.run.outcome;
  if (
    isRecord(currentOutcome) &&
    currentOutcome.status === "completed" &&
    currentOutcome.artifact_path === "outcome.md"
  ) {
    return state;
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const stepId = stepIdValue(state, idAllocator);
  const executionId = executionIdValue(state, idAllocator);
  const staged = await artifactStore.stage({
    runId: state.run.run_id,
    executionId,
    contents: completedOutcomeContents(state, stepId, executionId, createdAt),
  });
  const artifact = await artifactStore.finalize(staged, "outcome.md");
  if (artifact.status !== "complete") {
    throw new Error("Completed Workflow Outcome Artifact must be finalized as complete");
  }
  return {
    ...state,
    run: {
      ...state.run,
      outcome: {
        status: "completed",
        request_satisfied: true,
        summary: "Workflow completed",
        artifact_path: artifact.path,
      },
    },
  };
}

function applyReviewerFindings(
  state: WorkflowState,
  finalization: ReviewerFinalization,
): WorkflowState {
  const existing = [...state.snapshot.findings.findings];
  const byId = new Map(existing.map((finding) => [finding.id, finding]));
  for (const candidate of finalization.findings) {
    const finding = {
      ...candidate,
      state: "open" as const,
      disposition: "pending" as const,
    } as WorkflowState["snapshot"]["findings"]["findings"][number];
    byId.set(finding.id, finding);
  }
  for (const recheck of finalization.rechecks) {
    const current = byId.get(recheck.id);
    if (current === undefined) throw new Error(`Unknown Finding ${recheck.id}`);
    byId.set(recheck.id, {
      ...current,
      state: recheck.state,
      disposition: recheck.disposition,
    });
  }
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      findings: { ...state.snapshot.findings, findings: [...byId.values()] },
    },
  };
}

function productionRepositoryState(
  state: WorkflowState,
  snapshot: RepositorySnapshot,
  issue: boolean,
): WorkflowState {
  const currentPlan =
    issue && state.run.current_plan !== null
      ? {
          ...state.run.current_plan,
          applicability: {
            ...state.run.current_plan.applicability,
            status: "replan-required" as const,
          },
        }
      : state.run.current_plan;
  return {
    ...state,
    run: {
      ...state.run,
      current_plan: currentPlan,
      repository: {
        ...state.run.repository,
        ...repositorySnapshotValue(snapshot),
        ...(issue ? { classification: "relevant", resolution: "unresolved" } : {}),
      },
    },
  };
}

function sourceRepositoryDiff(diff: RepositoryDiff): RepositoryDiff {
  const files = diff.files.filter(({ path }) => path !== ".pi" && !path.startsWith(".pi/"));
  return {
    ...diff,
    files,
    changedFiles: files.map(({ path }) => path),
    addedFiles: files.filter(({ change }) => change === "added").map(({ path }) => path),
    modifiedFiles: files.filter(({ change }) => change === "modified").map(({ path }) => path),
    deletedFiles: files.filter(({ change }) => change === "deleted").map(({ path }) => path),
    statusChanged: diff.headChanged || diff.branchChanged || files.length > 0,
    fingerprintChanged: diff.headChanged || diff.branchChanged || files.length > 0,
  };
}

function appendChangeSetReference(
  state: WorkflowState,
  finalization: WorkerFinalization,
): WorkflowState {
  const reference = {
    id: finalization.changeSet.id,
    artifact_path: finalization.artifact.path,
    status: finalization.changeSet.status,
    accepted: finalization.changeSet.accepted,
    changed: finalization.changeSet.changed,
  } as JsonObject;
  const current = state.run.current_changes.relevant_change_sets;
  const references = current.some(
    (value) => isRecord(value) && value.id === finalization.changeSet.id,
  )
    ? current
    : [...current, reference];
  return {
    ...state,
    run: {
      ...state.run,
      current_changes: { ...state.run.current_changes, relevant_change_sets: references },
    },
  };
}

async function finalizeProductionStep(
  input: Readonly<{
    state: WorkflowState;
    result: StepResultV1;
    step: SchedulerStep;
    normalized: ResultNormalizationResult;
    execution: ProductionExecutionSnapshot;
    repository: RepositoryAdapter;
    workerFinalizer: WorkerFinalizer;
    verifierFinalizer: VerifierFinalizer;
    reviewerFinalizer: ReviewerFinalizer;
  }>,
): Promise<WorkflowState> {
  const after = await input.repository.captureSnapshot();
  const diff = await input.repository.diff(input.execution.before, after);
  let state = applyProductionCandidates(input.state, input.normalized.candidates);

  if (input.step.type === "implementation") {
    const finalization = await input.workerFinalizer.finalize({
      request: input.execution.request,
      result: input.result,
      before: input.execution.before,
      after,
      diff,
      writeScope: input.execution.request.permissions.repositoryTargets.filter(
        (value): value is string => typeof value === "string",
      ),
      executionStateRevision: input.execution.executionStateRevision,
    });
    state = appendChangeSetReference(state, finalization);
    state = attachFinalization(state, input.step.id, finalization.artifact, {
      kind: "change-set",
      change_set: finalization.changeSet as unknown as JsonObject,
      artifact: artifactValue(finalization.artifact),
    });
    return productionRepositoryState(
      state,
      after,
      finalization.changeSet.violations.length > 0 ||
        finalization.changeSet.observation.attributionUncertain,
    );
  }

  if (input.step.type === "verification") {
    const finalization = await input.verifierFinalizer.finalize({
      request: input.execution.request,
      result: input.result,
      before: input.execution.before,
      after,
      diff,
      executionStateRevision: input.execution.executionStateRevision,
      basis: {
        requirement_revision: input.state.snapshot.requirement.revision,
        ...(typeof input.state.run.current_plan?.version === "number"
          ? { plan_version: input.state.run.current_plan.version }
          : {}),
        step_id: input.step.id,
      },
    });
    state = attachFinalization(state, input.step.id, finalization.artifact, {
      kind: "verification-run",
      verification_run: finalization.verificationRun as unknown as JsonObject,
      artifact: artifactValue(finalization.artifact),
    });
    return productionRepositoryState(state, after, finalization.verificationRun.repository.mutated);
  }

  if (input.step.type === "review") {
    const finalization = await input.reviewerFinalizer.finalize({
      request: input.execution.request,
      result: input.result,
      normalizedFindings: input.normalized.candidates.finding_candidates,
      before: input.execution.before,
      after,
      diff,
      executionStateRevision: input.execution.executionStateRevision,
      basis: {
        requirement_revision: input.state.snapshot.requirement.revision,
        ...(typeof input.state.run.current_plan?.version === "number"
          ? { plan_version: input.state.run.current_plan.version }
          : {}),
        step_id: input.step.id,
      },
      state,
    });
    state = applyReviewerFindings(state, finalization);
    state = attachFinalization(state, input.step.id, finalization.artifact, {
      kind: "review-run",
      review_run: finalization.reviewRun as unknown as JsonObject,
      findings: finalization.findings as unknown as readonly JsonValue[],
      rechecks: finalization.rechecks as unknown as readonly JsonValue[],
      artifact: artifactValue(finalization.artifact),
    });
    return productionRepositoryState(state, after, finalization.reviewRun.repository.mutated);
  }

  if (diff.files.length > 0 || diff.headChanged || diff.branchChanged) {
    throw new Error(
      `Read-only Agent ${input.execution.request.identity.agentId} mutated the repository`,
    );
  }
  return productionRepositoryState(state, after, false);
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
    run: async (request, signal) => {
      const production = await execution();
      const sessionId = context.sessionManager?.getSessionId();
      piAgentRuntime ??= new PiSubagentsAdapter(requirePiFacilities(pi), {
        cwd: repositoryRoot,
        ...(sessionId === undefined ? {} : { sessionId }),
        buildPrompt: (executionRequest) =>
          productionPrompt(executionRequest, production.skillCatalog),
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
      const toolNames = createPiToolNames(pi);
      const toolCatalog = createPiToolCatalog(toolNames);
      return {
        agentRuntime,
        executionResolver: new ExecutionResolver({
          modelCatalog: modelCatalog(models),
          toolCatalog,
        }),
        skillCatalog: createPiSkillCatalog(context),
        modelCandidates: models,
        toolCatalog,
        toolNames,
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
  const failureLifecycle = new FailureLifecycle({
    runReader,
    stateStore,
    artifactStore,
    artifactReader,
    idAllocator,
  });
  const driftRepository: RepositoryAdapter = {
    getRoot: () => repository.getRoot(),
    getHead: () => repository.getHead(),
    getBranch: () => repository.getBranch(),
    captureSnapshot: (scope) => repository.captureSnapshot(scope),
    diff: async (before, after) => sourceRepositoryDiff(await repository.diff(before, after)),
  };
  const driftRecovery = new RepositoryDriftRecovery({
    repository: driftRepository,
    artifactStore,
  });
  const repositoryFreshness = async (state: WorkflowState): Promise<WorkflowState> => {
    const before = persistedRepositorySnapshot(state);
    const after = await repository.captureSnapshot();
    const diff = await driftRepository.diff(before, after);
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
  const productionReconcile = async (state: WorkflowState): Promise<WorkflowState> => {
    const before = persistedRepositorySnapshot(state);
    const assessment = await driftRecovery.check({
      before,
      classifyPath: () => "unknown",
    });
    if (assessment.classification === "clean" && assessment.resolution === "clear") return state;
    return productionRepositoryState(
      driftRecovery.apply(state, assessment),
      assessment.after,
      false,
    );
  };
  const resumeLifecycle = new ResumeLifecycle({
    runReader,
    stateStore,
    recheckRepositoryAndFreshness: repositoryFreshness,
  });
  const workerFinalizer = new WorkerFinalizer({ artifactStore, repository, idAllocator });
  const verifierFinalizer = new VerifierFinalizer({ artifactStore, repository, idAllocator });
  const reviewerFinalizer = new ReviewerFinalizer({ artifactStore, repository, idAllocator });
  const interruptedExecutionRecovery = new InterruptedExecutionRecovery({
    repository,
    workerFinalizer,
  });
  const executionSnapshots = new Map<ExecutionId, ProductionExecutionSnapshot>();
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
                writeScope: execution.request.permissions.repositoryTargets.filter(
                  (value): value is string => typeof value === "string",
                ),
              });
            };
      const unregister = cancellation.register({
        ...execution,
        ...(reconcile === undefined ? {} : { reconcile }),
      });
      return () => {
        workerSnapshots.delete(execution.request.identity.executionId);
        executionSnapshots.delete(execution.request.identity.executionId);
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
        const before = await repository.captureSnapshot();
        executionSnapshots.set(request.identity.executionId, {
          request,
          before,
          executionStateRevision: state.run.state_revision,
        });
        if (request.identity.agentId === "worker") {
          workerSnapshots.set(request.identity.executionId, {
            before,
            executionStateRevision: state.run.state_revision,
          });
        }
        return request;
      },
      completion: productionCompletion,
      schedule: productionSchedule,
      reconcile: productionReconcile,
      trigger: async (state) => productionTrigger(state, idAllocator),
      postconditions: productionPostconditions,
      runtimeFailure: async ({ request, step, error }) => {
        const execution = executionSnapshots.get(request.identity.executionId);
        if (request.identity.agentId === "worker" && execution !== undefined) {
          await interruptedExecutionRecovery.recover({
            request,
            before: execution.before,
            executionStateRevision: execution.executionStateRevision,
            writeScope: request.permissions.repositoryTargets.filter(
              (value): value is string => typeof value === "string",
            ),
          });
        }
        return failureLifecycle.fail(request.identity.runId, {
          resumable: true,
          reason: `${step.objective}: ${error instanceof Error ? error.message : String(error)}`,
          error,
          execution: request,
        });
      },
      finalize: async ({ state, result, step, normalized }) => {
        if (result === null || step === null || normalized === undefined || normalized === null) {
          return finalizeProductionOutcome(state, artifactStore, idAllocator);
        }
        const execution = executionSnapshots.get(result.identity.executionId);
        if (execution === undefined) {
          throw new Error(`Missing repository observation for ${result.identity.executionId}`);
        }
        return finalizeProductionStep({
          state,
          result,
          step,
          normalized,
          execution,
          repository,
          workerFinalizer,
          verifierFinalizer,
          reviewerFinalizer,
        });
      },
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
      workspaceLock,
      idAllocator,
    },
    status: { runReader },
    resume: {
      lifecycle: resumeLifecycle,
      orchestrator: orchestratorSource,
      workspaceLock,
    },
    cancel: { lifecycle: cancellation },
  });
}

function createProductionRuntimeFactory(
  pi: PiRuntimeFacilities | undefined,
): ProductionRuntimeFactory {
  const runtimes = new Map<string, Promise<RuntimeUseCases>>();
  return (value) => {
    const context = productionContext(value);
    const sessionId = context.sessionManager?.getSessionId() ?? "";
    const key = `${resolvePath(context.cwd)}\u0000${sessionId}`;
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
