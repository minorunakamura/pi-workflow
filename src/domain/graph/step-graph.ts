import type { StepId } from "../primitives/ids.js";

export const STEP_TYPES = [
  "analysis",
  "research",
  "decision",
  "planning",
  "implementation",
  "verification",
  "review",
] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const STEP_STATUSES = [
  "pending",
  "ready",
  "running",
  "blocked",
  "completed",
  "failed",
  "skipped",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const STEP_ORIGINS = ["base", "dynamic"] as const;
export type StepOrigin = (typeof STEP_ORIGINS)[number];

export const DYNAMIC_STEP_TRIGGERS = [
  "uncertainty",
  "decision",
  "verification failure",
  "review finding",
  "plan deviation",
  "repository drift",
  "execution/runtime failure",
  "recovery",
  "request amendment",
] as const;
export type DynamicStepTrigger = (typeof DYNAMIC_STEP_TRIGGERS)[number];

export type Step = Readonly<{
  id: StepId;
  type: StepType;
  objective: string;
  agent: string;
  skills: readonly string[];
  inputs: readonly unknown[];
  outputs: readonly unknown[];
  dependsOn: readonly StepId[];
  completionCriteria: readonly string[];
  status: StepStatus;
  blockedBy: readonly string[];
  result: Readonly<Record<string, unknown>> | null;
  origin: StepOrigin;
  trigger?: string;
  skipReason?: string;
  obsolete?: boolean;
}>;

export type StepInput = Readonly<{
  id: StepId;
  type: StepType;
  objective: string;
  agent: string;
  skills?: readonly string[];
  inputs?: readonly unknown[];
  outputs?: readonly unknown[];
  dependsOn?: readonly StepId[];
  completionCriteria?: readonly string[];
  status?: StepStatus;
  blockedBy?: readonly string[];
  result?: Readonly<Record<string, unknown>> | null;
  origin?: StepOrigin;
  trigger?: string;
  skipReason?: string;
  obsolete?: boolean;
}>;

export type DynamicStepInput = Omit<StepInput, "origin" | "trigger"> &
  Readonly<{
    trigger: string;
  }>;

export type StepGraphNode = Readonly<{
  id: string;
  dependsOn: readonly string[];
}>;

export type StepGraph = Readonly<{
  graphRevision: number;
  steps: readonly Step[];
}>;

export type StepTransitionOptions = Readonly<{
  reason?: string;
  obsolete?: boolean;
}>;

export const STEP_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  pending: ["ready", "blocked", "skipped"],
  ready: ["running", "blocked", "skipped"],
  running: ["blocked", "completed", "failed"],
  blocked: ["ready", "skipped"],
  completed: [],
  failed: ["ready"],
  skipped: [],
};

export class StepGraphValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(issues.join("; "));
    this.name = "StepGraphValidationError";
  }
}

export class InvalidStepTransitionError extends Error {
  constructor(
    readonly stepId: StepId,
    readonly from: StepStatus,
    readonly to: StepStatus,
  ) {
    super(`Invalid Step transition for ${stepId}: ${from} → ${to}`);
    this.name = "InvalidStepTransitionError";
  }
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function isDynamicStepTrigger(value: string): value is DynamicStepTrigger {
  return (DYNAMIC_STEP_TRIGGERS as readonly string[]).includes(value);
}

function validateStepMetadata(step: Step): void {
  if (step.origin === "dynamic" && !nonEmpty(step.trigger)) {
    throw new StepGraphValidationError([`${step.id}: dynamic Step requires a trigger`]);
  }
  if (step.origin === "dynamic" && !isDynamicStepTrigger(step.trigger!)) {
    throw new StepGraphValidationError([`${step.id}: unsupported dynamic Step trigger`]);
  }
  if (step.origin === "base" && step.trigger !== undefined) {
    throw new StepGraphValidationError([`${step.id}: base Step must not have a trigger`]);
  }
  if (step.status === "skipped" && !nonEmpty(step.skipReason)) {
    throw new StepGraphValidationError([`${step.id}: skipped Step requires a reason`]);
  }
  if (step.obsolete && step.status !== "skipped") {
    throw new StepGraphValidationError([`${step.id}: obsolete Step must be skipped`]);
  }
  if (step.obsolete && !nonEmpty(step.skipReason)) {
    throw new StepGraphValidationError([`${step.id}: obsolete Step requires a reason`]);
  }
}

export function createStep(input: StepInput): Step {
  const step: Step = {
    id: input.id,
    type: input.type,
    objective: input.objective,
    agent: input.agent,
    skills: input.skills ?? [],
    inputs: input.inputs ?? [],
    outputs: input.outputs ?? [],
    dependsOn: input.dependsOn ?? [],
    completionCriteria: input.completionCriteria ?? [],
    status: input.status ?? "pending",
    blockedBy: input.blockedBy ?? [],
    result: input.result ?? null,
    origin: input.origin ?? "base",
    ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
    ...(input.skipReason === undefined ? {} : { skipReason: input.skipReason }),
    ...(input.obsolete === undefined ? {} : { obsolete: input.obsolete }),
  };

  validateStepMetadata(step);
  return step;
}

export function createDynamicStep(input: DynamicStepInput): Step {
  return createStep({ ...input, origin: "dynamic" });
}

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return from === to || (STEP_TRANSITIONS[from]?.includes(to) ?? false);
}

export function transitionStep(
  step: Step,
  to: StepStatus,
  options: StepTransitionOptions | string = {},
): Step {
  validateStepMetadata(step);

  if (step.status === to) {
    return step;
  }
  if (!canTransitionStep(step.status, to)) {
    throw new InvalidStepTransitionError(step.id, step.status, to);
  }

  if (to !== "skipped") {
    return { ...step, status: to };
  }

  const reason = typeof options === "string" ? options : (options.reason ?? step.skipReason);
  if (!nonEmpty(reason)) {
    throw new StepGraphValidationError([`${step.id}: skipped Step requires a reason`]);
  }

  const obsolete = typeof options === "string" ? false : (options.obsolete ?? step.obsolete);
  if (obsolete && step.status !== "pending") {
    throw new InvalidStepTransitionError(step.id, step.status, "skipped");
  }

  return {
    ...step,
    status: "skipped",
    skipReason: reason,
    ...(obsolete ? { obsolete: true } : {}),
  };
}

export function skipStep(step: Step, reason: string): Step {
  return transitionStep(step, "skipped", reason);
}

export function obsoleteStep(step: Step, reason: string): Step {
  if (step.status !== "pending") {
    throw new InvalidStepTransitionError(step.id, step.status, "skipped");
  }
  return transitionStep(step, "skipped", { reason, obsolete: true });
}

function assertGraphRevision(graphRevision: number): void {
  if (!Number.isSafeInteger(graphRevision) || graphRevision < 1) {
    throw new RangeError("graphRevision must be a positive safe integer");
  }
}

function nextGraphRevision(graphRevision: number): number {
  assertGraphRevision(graphRevision);
  if (graphRevision === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("graphRevision exhausted");
  }
  return graphRevision + 1;
}

export function validateStepGraph(
  input: readonly StepGraphNode[] | Pick<StepGraph, "steps">,
): void {
  const steps = "steps" in input ? input.steps : input;
  const issues: string[] = [];
  const byId = new Map<string, StepGraphNode>();

  for (const step of steps) {
    const id = step.id;
    if (byId.has(id)) {
      issues.push(`duplicate Step id: ${id}`);
    } else {
      byId.set(id, step);
    }
  }

  for (const step of steps) {
    const seenDependencies = new Set<string>();
    for (const dependency of step.dependsOn) {
      const dependencyId = dependency;
      if (seenDependencies.has(dependencyId)) {
        issues.push(`${step.id}: duplicate dependency ${dependencyId}`);
      }
      seenDependencies.add(dependencyId);
      if (!byId.has(dependencyId)) {
        issues.push(`${step.id}: invalid dependency ${dependencyId}`);
      }
    }
  }

  if (issues.length > 0) {
    throw new StepGraphValidationError(issues);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (id: string): void => {
    if (visiting.has(id)) {
      const cycleStart = path.indexOf(id);
      const cycle = [...path.slice(cycleStart), id].join(" → ");
      throw new StepGraphValidationError([`Step graph contains a cycle: ${cycle}`]);
    }
    if (visited.has(id)) {
      return;
    }

    visiting.add(id);
    path.push(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      visit(dependency);
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of byId.keys()) {
    visit(id);
  }
}

export function createStepGraph(steps: readonly Step[] = [], graphRevision = 1): StepGraph {
  assertGraphRevision(graphRevision);
  for (const step of steps) {
    validateStepMetadata(step);
  }
  validateStepGraph(steps);
  return { graphRevision, steps: [...steps] };
}

export function addStep(graph: StepGraph, step: Step): StepGraph {
  return createStepGraph([...graph.steps, step], nextGraphRevision(graph.graphRevision));
}

function assertMaxDynamicSteps(maxDynamicSteps: number): void {
  if (!Number.isSafeInteger(maxDynamicSteps) || maxDynamicSteps < 0) {
    throw new StepGraphValidationError([
      `max_dynamic_steps must be a non-negative safe integer: ${maxDynamicSteps}`,
    ]);
  }
}

function isActiveStep(step: Step): boolean {
  return step.status !== "completed" && step.status !== "skipped";
}

export function addDynamicStep(
  graph: StepGraph,
  input: DynamicStepInput,
  maxDynamicSteps: number,
): StepGraph {
  assertMaxDynamicSteps(maxDynamicSteps);
  const step = createDynamicStep(input);

  if (
    graph.steps.some((existing) => isActiveStep(existing) && existing.objective === step.objective)
  ) {
    return graph;
  }

  const dynamicStepCount = graph.steps.filter(({ origin }) => origin === "dynamic").length;
  if (dynamicStepCount >= maxDynamicSteps) {
    throw new StepGraphValidationError([
      `max_dynamic_steps exceeded: ${dynamicStepCount + 1} > ${maxDynamicSteps}`,
    ]);
  }

  return addStep(graph, step);
}

export function transitionStepInGraph(
  graph: StepGraph,
  stepId: StepId,
  to: StepStatus,
  options: StepTransitionOptions | string = {},
): StepGraph {
  const index = graph.steps.findIndex((step) => step.id === stepId);
  if (index < 0) {
    throw new StepGraphValidationError([`unknown Step id: ${stepId}`]);
  }

  const steps = [...graph.steps];
  steps[index] = transitionStep(steps[index]!, to, options);
  return createStepGraph(steps, graph.graphRevision);
}

export function obsoleteStepInGraph(graph: StepGraph, stepId: StepId, reason: string): StepGraph {
  const index = graph.steps.findIndex((step) => step.id === stepId);
  if (index < 0) {
    throw new StepGraphValidationError([`unknown Step id: ${stepId}`]);
  }

  const steps = [...graph.steps];
  steps[index] = obsoleteStep(steps[index]!, reason);
  return createStepGraph(steps, nextGraphRevision(graph.graphRevision));
}
