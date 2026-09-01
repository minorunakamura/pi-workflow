import type {
  CompletionBlockerCode,
  CompletionEvaluation,
} from "../evaluation/completion-evaluator.js";
import {
  addDynamicStep,
  createStep,
  createStepGraph,
  transitionStepInGraph,
  type Step,
  type StepGraph,
} from "../domain/graph/step-graph.js";
import { createIdAllocator, type IdAllocator, type StepId } from "../domain/primitives/ids.js";
import type { StepResultV1 } from "../contracts/execution/agent-execution.js";
import type { StepStateV1 } from "../contracts/state/workflow-state.js";
import type { WorkflowState } from "../ports/run-reader.js";
import type { SchedulerStep } from "../domain/scheduling/scheduler.js";

const DEFAULT_MAX_DYNAMIC_STEPS = 3;
const VERIFICATION_FIX_OBJECTIVE = "fix verification failure";
const FINDING_FIX_OBJECTIVE = "fix blocking finding";
const REVERIFY_OBJECTIVE = "reverify the fix";
const REREVIEW_OBJECTIVE = "rereview the fix";
const RECOVERY_SKIP_REASON = "superseded by verification fix cycle";

export type FixCycleTrigger = "verification failure" | "review finding";

export type FixCyclePolicy = Readonly<{
  maxDynamicSteps?: number;
  idAllocator?: IdAllocator;
}>;

export type FixCycleRouteInput = Readonly<{
  state: WorkflowState;
  blockers?: readonly CompletionBlockerCode[];
  step?: SchedulerStep;
  result?: StepResultV1;
}>;

export type FixCycleRouteResult = Readonly<{
  state: WorkflowState;
  inserted: boolean;
  trigger?: FixCycleTrigger;
}>;

export class FixCycleRoutingError extends Error {
  constructor(
    readonly code: "INVALID_POLICY" | "INVALID_STATE" | "NO_IMPLEMENTATION_ANCHOR",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "FixCycleRoutingError";
  }
}

function routingError(message: string): never {
  throw new FixCycleRoutingError("INVALID_STATE", message);
}

function stringArray(values: readonly unknown[], path: string): readonly string[] {
  return values.map((value, index) => {
    if (typeof value !== "string") {
      routingError(`${path}[${index}] must be a string`);
    }
    return value;
  });
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    routingError(`${path} must be a string`);
  }
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    routingError(`${path} must be a boolean`);
  }
  return value;
}

function domainStep(value: StepStateV1): Step {
  const origin = optionalString(value.origin, `${value.id}.origin`);
  const trigger = optionalString(value.trigger, `${value.id}.trigger`);
  const skipReason = optionalString(value.skip_reason, `${value.id}.skip_reason`);
  const obsolete = optionalBoolean(value.obsolete, `${value.id}.obsolete`);

  if (origin !== undefined && origin !== "base" && origin !== "dynamic") {
    routingError(`${value.id}.origin must be base or dynamic`);
  }

  return createStep({
    id: value.id,
    type: value.type,
    objective: value.objective,
    agent: value.agent,
    skills: stringArray(value.skills, `${value.id}.skills`),
    inputs: value.inputs,
    outputs: value.outputs,
    dependsOn: stringArray(value.depends_on, `${value.id}.depends_on`) as readonly StepId[],
    completionCriteria: stringArray(value.completion_criteria, `${value.id}.completion_criteria`),
    status: value.status,
    blockedBy: stringArray(value.blocked_by, `${value.id}.blocked_by`),
    result: value.result,
    origin: origin ?? "base",
    ...(trigger === undefined ? {} : { trigger }),
    ...(skipReason === undefined ? {} : { skipReason }),
    ...(obsolete === undefined ? {} : { obsolete }),
  });
}

function stateStep(value: Step, previous: StepStateV1 | undefined): StepStateV1 {
  return {
    ...previous,
    id: value.id,
    type: value.type,
    objective: value.objective,
    agent: value.agent,
    skills: previous?.skills ?? [...value.skills],
    inputs: previous?.inputs ?? [],
    outputs: previous?.outputs ?? [],
    depends_on: [...value.dependsOn],
    completion_criteria: [...value.completionCriteria],
    status: value.status,
    blocked_by: [...value.blockedBy],
    result: value.result,
    origin: value.origin,
    ...(value.trigger === undefined ? {} : { trigger: value.trigger }),
    ...(value.skipReason === undefined ? {} : { skip_reason: value.skipReason }),
    ...(value.obsolete === undefined ? {} : { obsolete: value.obsolete }),
  } as StepStateV1;
}

function graphFor(state: WorkflowState): StepGraph {
  return createStepGraph(
    state.snapshot.steps.steps.map(domainStep),
    state.snapshot.steps.graph_revision,
  );
}

function syncGraph(state: WorkflowState, graph: StepGraph): WorkflowState {
  const previous = new Map(state.snapshot.steps.steps.map((step) => [step.id, step]));
  return {
    ...state,
    run: { ...state.run, graph_revision: graph.graphRevision },
    snapshot: {
      ...state.snapshot,
      steps: {
        ...state.snapshot.steps,
        graph_revision: graph.graphRevision,
        steps: graph.steps.map((step) => stateStep(step, previous.get(step.id))),
      },
    },
  };
}

function configuredLimit(state: WorkflowState, policyLimit: number | undefined): number {
  const persisted = state.run.limits.max_dynamic_steps;
  const limit = policyLimit ?? (persisted === undefined ? DEFAULT_MAX_DYNAMIC_STEPS : persisted);
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0) {
    throw new FixCycleRoutingError(
      "INVALID_POLICY",
      "max_dynamic_steps must be a non-negative safe integer",
    );
  }
  return limit;
}

function issueStepId(allocator: IdAllocator, graph: StepGraph): StepId {
  const used = new Set(graph.steps.map(({ id }) => id));
  for (;;) {
    const id = allocator.issueStepId();
    if (!used.has(id)) return id;
  }
}

function findStep(graph: StepGraph, id: StepId): Step {
  const step = graph.steps.find((candidate) => candidate.id === id);
  if (step === undefined) {
    routingError(`unknown Step ${id}`);
  }
  return step;
}

function implementationAnchor(graph: StepGraph, sourceId: StepId): StepId {
  const byId = new Map(graph.steps.map((step) => [step.id, step]));
  const seen = new Set<StepId>([sourceId]);
  const queue = [...findStep(graph, sourceId).dependsOn];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const step = byId.get(id);
    if (step === undefined) {
      routingError(`unknown dependency ${id}`);
    }
    if (step.type === "implementation") return step.id;
    queue.push(...step.dependsOn);
  }

  throw new FixCycleRoutingError(
    "NO_IMPLEMENTATION_ANCHOR",
    `No implementation ancestor exists for ${sourceId}`,
  );
}

function dependsOnTransitively(
  graph: StepGraph,
  candidateId: StepId,
  dependencyId: StepId,
): boolean {
  const byId = new Map(graph.steps.map((step) => [step.id, step]));
  const seen = new Set<StepId>();
  const queue = [...findStep(graph, candidateId).dependsOn];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (id === dependencyId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const dependency = byId.get(id);
    if (dependency !== undefined) queue.push(...dependency.dependsOn);
  }
  return false;
}

function skipStepForRecovery(graph: StepGraph, id: StepId): StepGraph {
  const step = findStep(graph, id);
  if (step.status === "completed" || step.status === "skipped") return graph;

  let next = graph;
  if (step.status === "failed") {
    next = transitionStepInGraph(next, id, "ready");
  }
  return transitionStepInGraph(next, id, "skipped", RECOVERY_SKIP_REASON);
}

function supersedeVerificationPath(graph: StepGraph, sourceId: StepId): StepGraph {
  let next = skipStepForRecovery(graph, sourceId);
  for (const step of graph.steps) {
    if (step.type === "review" && dependsOnTransitively(graph, step.id, sourceId)) {
      next = skipStepForRecovery(next, step.id);
    }
  }
  return next;
}

function activeObjective(graph: StepGraph, objective: string): Step | undefined {
  return graph.steps.find(
    (step) =>
      step.objective === objective && step.status !== "completed" && step.status !== "skipped",
  );
}

function addRecoveryStep(
  graph: StepGraph,
  input: {
    objective: string;
    type: Step["type"];
    agent: string;
    dependsOn: readonly StepId[];
    trigger: FixCycleTrigger;
  },
  maxDynamicSteps: number,
  allocator: IdAllocator,
): Readonly<{ graph: StepGraph; id: StepId }> {
  const existing = activeObjective(graph, input.objective);
  if (existing !== undefined) return { graph, id: existing.id };

  const id = issueStepId(allocator, graph);
  return {
    graph: addDynamicStep(
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
      maxDynamicSteps,
    ),
    id,
  };
}

function addCycle(
  initial: StepGraph,
  anchorId: StepId,
  trigger: FixCycleTrigger,
  maxDynamicSteps: number,
  allocator: IdAllocator,
): StepGraph {
  let graph = initial;
  const worker = addRecoveryStep(
    graph,
    {
      objective:
        trigger === "verification failure" ? VERIFICATION_FIX_OBJECTIVE : FINDING_FIX_OBJECTIVE,
      type: "implementation",
      agent: "worker",
      dependsOn: [anchorId],
      trigger,
    },
    maxDynamicSteps,
    allocator,
  );
  graph = worker.graph;

  const verifier = addRecoveryStep(
    graph,
    {
      objective: REVERIFY_OBJECTIVE,
      type: "verification",
      agent: "verifier",
      dependsOn: [worker.id],
      trigger,
    },
    maxDynamicSteps,
    allocator,
  );
  graph = verifier.graph;

  const reviewer = addRecoveryStep(
    graph,
    {
      objective: REREVIEW_OBJECTIVE,
      type: "review",
      agent: "reviewer",
      dependsOn: [verifier.id],
      trigger: "review finding",
    },
    maxDynamicSteps,
    allocator,
  );
  return reviewer.graph;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasVerificationFailure(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    value.outcome === "failed" ||
    value.result === "failed" ||
    value.verification_result === "failed"
  ) {
    return true;
  }
  for (const checks of [value.execution_checks, value.checks]) {
    if (
      Array.isArray(checks) &&
      checks.some((check) => isRecord(check) && check.status === "failed")
    ) {
      return true;
    }
  }
  return [value.verification_run, value.verificationRun].some(
    (run) => isRecord(run) && run.result === "failed",
  );
}

function failedVerificationStep(
  state: WorkflowState,
  graph: StepGraph,
  input: FixCycleRouteInput,
): Step | undefined {
  if (input.step?.type === "verification") {
    const current = graph.steps.find(({ id }) => id === input.step?.id);
    return input.result?.outcome === "failed" ||
      hasVerificationFailure(input.result) ||
      current?.status === "failed" ||
      hasVerificationFailure(current?.result)
      ? current
      : undefined;
  }
  if (input.blockers?.includes("VERIFICATION_FAILED")) {
    const latest = state.snapshot.steps.steps.filter(({ type }) => type === "verification").at(-1);
    return latest === undefined ? undefined : findStep(graph, latest.id);
  }
  const failed = state.snapshot.steps.steps.filter(
    ({ type, status, result }) =>
      type === "verification" &&
      status !== "skipped" &&
      (status === "failed" || hasVerificationFailure(result)),
  );
  const candidate = failed.at(-1);
  return candidate === undefined ? undefined : findStep(graph, candidate.id);
}

function reviewStep(graph: StepGraph, input: FixCycleRouteInput): Step | undefined {
  if (input.step?.type === "review") {
    return graph.steps.find(({ id }) => id === input.step?.id);
  }
  return graph.steps.filter(({ type }) => type === "review").at(-1);
}

function hasBlockingFinding(state: WorkflowState): boolean {
  return state.snapshot.findings.findings.some(
    ({ state: findingState, disposition }) =>
      findingState === "open" && disposition === "fix-required",
  );
}

function triggerFor(
  input: FixCycleRouteInput,
  state: WorkflowState,
  graph: StepGraph,
): FixCycleTrigger | undefined {
  if (
    input.step?.type === "verification" &&
    (input.result?.outcome === "failed" || hasVerificationFailure(input.result))
  ) {
    return "verification failure";
  }
  if (
    input.blockers?.includes("VERIFICATION_FAILED") ||
    failedVerificationStep(state, graph, input) !== undefined
  ) {
    return "verification failure";
  }
  if (input.blockers?.includes("FINDING_FIX_REQUIRED") || hasBlockingFinding(state)) {
    return "review finding";
  }
  return undefined;
}

function isRecoveryObjective(objective: string): boolean {
  return (
    objective === VERIFICATION_FIX_OBJECTIVE ||
    objective === FINDING_FIX_OBJECTIVE ||
    objective === REVERIFY_OBJECTIVE ||
    objective === REREVIEW_OBJECTIVE
  );
}

export function isRecoveryStep(step: Readonly<{ origin?: unknown; objective: string }>): boolean {
  return step.origin === "dynamic" && isRecoveryObjective(step.objective);
}

function hasActiveRecovery(graph: StepGraph): boolean {
  return graph.steps.some(
    (step) => isRecoveryStep(step) && step.status !== "completed" && step.status !== "skipped",
  );
}

function staleRecoveryBlockers(state: WorkflowState): readonly CompletionBlockerCode[] {
  const active = state.snapshot.steps.steps.filter(
    (step) => isRecoveryStep(step) && step.status !== "completed" && step.status !== "skipped",
  );
  if (active.length === 0) return [];

  const blockers = new Set<CompletionBlockerCode>();
  if (active.some((step) => step.type === "implementation" || step.type === "verification")) {
    blockers.add("VERIFICATION_STALE");
  }
  if (active.some((step) => step.type === "review")) {
    blockers.add("REVIEW_STALE");
  }
  return [...blockers];
}

export class FixReverifyRereviewRouter {
  private readonly maxDynamicSteps: number | undefined;
  private readonly idAllocator: IdAllocator;

  constructor(policy: FixCyclePolicy = {}) {
    if (
      policy.maxDynamicSteps !== undefined &&
      (!Number.isSafeInteger(policy.maxDynamicSteps) || policy.maxDynamicSteps < 0)
    ) {
      throw new FixCycleRoutingError(
        "INVALID_POLICY",
        "maxDynamicSteps must be a non-negative safe integer",
      );
    }
    this.maxDynamicSteps = policy.maxDynamicSteps;
    this.idAllocator = policy.idAllocator ?? createIdAllocator();
  }

  guardCompletion(state: WorkflowState, completion: CompletionEvaluation): CompletionEvaluation {
    const extra = staleRecoveryBlockers(state);
    if (extra.length === 0) return completion;

    const blockers = new Set(completion.blockers);
    for (const blocker of extra) blockers.add(blocker);
    return { eligible: false, blockers: [...blockers] };
  }

  route(input: FixCycleRouteInput): FixCycleRouteResult {
    const graph = graphFor(input.state);
    const trigger = triggerFor(input, input.state, graph);
    if (trigger === undefined) return { state: input.state, inserted: false };

    if (hasActiveRecovery(graph)) return { state: input.state, inserted: false, trigger };

    const maxDynamicSteps = configuredLimit(input.state, this.maxDynamicSteps);
    let next = graph;
    let anchor: StepId;

    if (trigger === "verification failure") {
      const source = failedVerificationStep(input.state, graph, input);
      if (source === undefined) {
        return { state: input.state, inserted: false, trigger };
      }
      anchor = implementationAnchor(graph, source.id);
      next = supersedeVerificationPath(next, source.id);
    } else {
      const source = reviewStep(graph, input);
      if (source === undefined) {
        throw new FixCycleRoutingError(
          "INVALID_STATE",
          "A blocking Finding requires a Review Step",
        );
      }
      anchor = implementationAnchor(graph, source.id);
    }

    next = addCycle(next, anchor, trigger, maxDynamicSteps, this.idAllocator);
    if (next === graph) return { state: input.state, inserted: false, trigger };

    return { state: syncGraph(input.state, next), inserted: true, trigger };
  }
}

export { DEFAULT_MAX_DYNAMIC_STEPS };
