import { stringify as stringifyYaml } from "yaml";
import { AGENT_DEFINITIONS } from "../../agents/definitions.js";
import { validateAgentExecutionRequest } from "../../agents/permission-policy.js";
import {
  StepResultV1Schema,
  type AgentExecutionRequestV1,
  type JsonValue,
  type PlanCandidate,
  type ResultCandidate,
  type StepResultV1,
} from "../../contracts/execution/agent-execution.js";
import {
  ARTIFACT_STATUSES,
  ArtifactFrontMatterV1Schema,
  type ArtifactStatus,
} from "../../contracts/artifacts/artifact.js";
import {
  createIdAllocator,
  type AcceptanceCriterionId,
  type ConstraintId,
  type DecisionId,
  type FindingId,
  type IdAllocator,
  type PlanDeviationId,
  type RunId,
  type UncertaintyId,
} from "../../domain/primitives/ids.js";
import type { SchedulerStep } from "../../domain/scheduling/scheduler.js";
import type {
  ArtifactContent,
  ArtifactReader,
  ArtifactRef,
  ArtifactStore,
} from "../../ports/artifact-store.js";
import type { WorkflowState } from "../../ports/run-reader.js";

type MaybePromise<T> = T | Promise<T>;

export type ResultValidationInput = Readonly<{
  result: StepResultV1;
  request: AgentExecutionRequestV1;
  state: WorkflowState;
  step: SchedulerStep;
}>;

export type ResultValidationPhase = (input: ResultValidationInput) => MaybePromise<void>;

export type ResultNormalizationOptions = Readonly<{
  resultValidator?: ((input: ResultValidationInput) => MaybePromise<StepResultV1>) | undefined;
  validateRole?: ResultValidationPhase | undefined;
  validateReferences?: ResultValidationPhase | undefined;
  validatePermissions?: ResultValidationPhase | undefined;
  postconditions?: ((input: ResultValidationInput) => MaybePromise<WorkflowState>) | undefined;
  allocator?: IdAllocator | undefined;
  artifactReader?: ArtifactReader | undefined;
  artifactStore?: ArtifactStore | undefined;
  maxArtifactBytes?: number | undefined;
  now?: (() => Date) | undefined;
}>;

export type ResultNormalizationErrorCode =
  | "IDENTITY_MISMATCH"
  | "ROLE_VIOLATION"
  | "REFERENCE_INVALID"
  | "PERMISSION_VIOLATION"
  | "REQUIRED_ARTIFACT_MISSING"
  | "ARTIFACT_INVALID";

export class ResultNormalizationError extends Error {
  constructor(
    readonly code: ResultNormalizationErrorCode,
    message: string,
  ) {
    super(`Result normalization failed [${code}]: ${message}`);
    this.name = "ResultNormalizationError";
  }
}

export type NormalizedCandidate<Id extends string> = ResultCandidate &
  Readonly<{
    id: Id;
  }>;

export type NormalizedFindingRecheck = ResultCandidate &
  Readonly<{
    id: FindingId;
  }>;

export type NormalizedPlan = PlanCandidate;

export type NormalizedResultCandidates = Readonly<{
  uncertainty_candidates: readonly NormalizedCandidate<UncertaintyId>[];
  decision_requests: readonly NormalizedCandidate<DecisionId>[];
  requirement_candidates: Readonly<{
    acceptance_criteria: readonly NormalizedCandidate<AcceptanceCriterionId>[];
    constraints: readonly NormalizedCandidate<ConstraintId>[];
    assumptions: readonly ResultCandidate[];
  }>;
  finding_candidates: readonly NormalizedCandidate<FindingId>[];
  finding_rechecks: readonly NormalizedFindingRecheck[];
  plan_deviations: readonly NormalizedCandidate<PlanDeviationId>[];
  skill_requests: readonly ResultCandidate[];
  execution_checks: readonly ResultCandidate[];
  observations: readonly ResultCandidate[];
}>;

export type ResultArtifactValidation = Readonly<{
  refs: readonly ArtifactRef[];
  contents: readonly ArtifactContent[];
}>;

export type ResultNormalizationResult = Readonly<{
  state: WorkflowState;
  result: StepResultV1;
  plan?: NormalizedPlan;
  candidates: NormalizedResultCandidates;
  artifacts: ResultArtifactValidation;
}>;

const noPostconditions = (state: WorkflowState): WorkflowState => state;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizePlanCandidate(
  plan: PlanCandidate | undefined,
): NormalizedPlan | undefined {
  if (plan === undefined) return undefined;
  return { ...plan, write_scope: [...plan.write_scope] };
}

function fail(code: ResultNormalizationErrorCode, message: string): never {
  throw new ResultNormalizationError(code, message);
}

function assertIdentity(input: ResultValidationInput, result: StepResultV1): void {
  if (
    input.request.identity.runId !== input.state.run.run_id ||
    input.request.identity.stepId !== input.step.id
  ) {
    fail(
      "IDENTITY_MISMATCH",
      "Agent execution request identity does not match the dispatched Run and Step",
    );
  }

  if (
    result.identity.runId !== input.state.run.run_id ||
    result.identity.stepId !== input.step.id ||
    result.identity.executionId !== input.request.identity.executionId
  ) {
    fail("IDENTITY_MISMATCH", "Agent result identity does not match the dispatched Execution");
  }
}

function validateRole(input: ResultValidationInput): void {
  const definition = AGENT_DEFINITIONS.find(({ id }) => id === input.request.identity.agentId);
  if (input.step.agent !== input.request.identity.agentId) {
    fail("ROLE_VIOLATION", "Agent execution request role does not match the dispatched Step");
  }
  if (definition === undefined) {
    fail("ROLE_VIOLATION", `Unknown Agent role: ${input.request.identity.agentId}`);
  }
}

function validatePermissions(input: ResultValidationInput): void {
  const definition = AGENT_DEFINITIONS.find(({ id }) => id === input.request.identity.agentId);
  if (definition === undefined) {
    fail("ROLE_VIOLATION", `Unknown Agent role: ${input.request.identity.agentId}`);
  }

  if (input.request.execution.mode !== definition.mode) {
    fail(
      "PERMISSION_VIOLATION",
      `Execution mode ${input.request.execution.mode} is not allowed for Agent ${definition.id}`,
    );
  }
  if (input.result.mode !== undefined && input.result.mode !== input.request.execution.mode) {
    fail(
      "PERMISSION_VIOLATION",
      "Agent result mode cannot widen the dispatched Execution permissions",
    );
  }
}

function validArtifactPath(path: string): boolean {
  return (
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/^[A-Za-z]:/.test(path) &&
    path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

export type AgentArtifactDraft = Readonly<{
  type: "analysis" | "research";
  purpose: string;
  content: string;
}>;

function isArtifactReference(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && ("runId" in value || "path" in value || "status" in value);
}

function isAgentArtifactDraft(value: unknown): value is AgentArtifactDraft {
  return (
    isRecord(value) &&
    (value.type === "analysis" || value.type === "research") &&
    typeof value.purpose === "string" &&
    typeof value.content === "string" &&
    !isArtifactReference(value)
  );
}

function artifactReference(value: unknown, index: number, expectedRunId: RunId): ArtifactRef {
  const path = `artifacts[${index}]`;
  if (!isRecord(value)) {
    fail("REFERENCE_INVALID", `${path} must be a finalized Artifact reference`);
  }

  const runId = value.runId;
  if (typeof runId !== "string" || !/^run-\d+$/.test(runId) || runId !== expectedRunId) {
    fail("REFERENCE_INVALID", `${path}.runId must match the dispatched Run ID`);
  }

  const artifactPath = value.path;
  if (typeof artifactPath !== "string" || !validArtifactPath(artifactPath)) {
    fail("REFERENCE_INVALID", `${path}.path must be a safe Run-relative Artifact path`);
  }

  const status = value.status;
  if (typeof status !== "string" || !(ARTIFACT_STATUSES as readonly string[]).includes(status)) {
    fail("REFERENCE_INVALID", `${path}.status must be complete or partial`);
  }

  return {
    runId: runId as RunId,
    path: artifactPath,
    status: status as ArtifactStatus,
  };
}

export function parseResultArtifactReferences(
  result: StepResultV1,
  request: AgentExecutionRequestV1,
): readonly ArtifactRef[] {
  return result.artifacts.flatMap((artifact, index) =>
    isArtifactReference(artifact)
      ? [artifactReference(artifact, index, request.identity.runId)]
      : [],
  );
}

export async function validateStepResult(
  input: Readonly<{
    result: unknown;
    request: AgentExecutionRequestV1;
    state: WorkflowState;
    step: SchedulerStep;
  }>,
  options: Pick<
    ResultNormalizationOptions,
    "resultValidator" | "validateRole" | "validateReferences" | "validatePermissions"
  > = {},
): Promise<StepResultV1> {
  let result = StepResultV1Schema.parse(input.result);
  const validatedInput = { ...input, result };
  assertIdentity(validatedInput, result);
  try {
    validateAgentExecutionRequest(input.request);
  } catch (error) {
    fail("PERMISSION_VIOLATION", error instanceof Error ? error.message : String(error));
  }

  if (options.resultValidator !== undefined) {
    result = StepResultV1Schema.parse(await options.resultValidator(validatedInput));
    assertIdentity({ ...input, result }, result);
  }

  const phaseInput = { ...input, result };
  validateRole(phaseInput);
  await options.validateRole?.(phaseInput);

  parseResultArtifactReferences(result, input.request);
  await options.validateReferences?.(phaseInput);

  validatePermissions(phaseInput);
  await options.validatePermissions?.(phaseInput);

  return result;
}

function collectIds(values: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    if (isRecord(value) && typeof value.id === "string") {
      ids.add(value.id);
    }
  }
  return ids;
}

function allocateUnique<Id extends string>(issue: () => Id, used: Set<string>): Id {
  for (;;) {
    const id = issue();
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
}

function identify<Id extends string>(
  candidate: ResultCandidate,
  issue: () => Id,
  used: Set<string>,
): NormalizedCandidate<Id> {
  return { ...candidate, id: allocateUnique(issue, used) };
}

function findingReference(
  candidate: ResultCandidate,
  index: number,
  state: WorkflowState,
): FindingId {
  const keys = ["findingId", "finding_id"].filter((key) => Object.hasOwn(candidate, key));
  if (keys.length !== 1) {
    fail(
      "REFERENCE_INVALID",
      `finding_rechecks[${index}] must contain exactly one findingId or finding_id reference`,
    );
  }
  const reference = candidate[keys[0]!];
  if (typeof reference !== "string" || !/^F-\d+$/.test(reference)) {
    fail("REFERENCE_INVALID", `finding_rechecks[${index}] must reference an F-<number> Finding`);
  }
  if (!state.snapshot.findings.findings.some(({ id }) => id === reference)) {
    fail("REFERENCE_INVALID", `Unknown Finding reference: ${reference}`);
  }
  return reference as FindingId;
}

function normalizeFindingRechecks(
  result: StepResultV1,
  state: WorkflowState,
): readonly NormalizedFindingRecheck[] {
  return result.finding_rechecks.map((candidate, index) => ({
    ...candidate,
    id: findingReference(candidate, index, state),
  }));
}

export function normalizeResultCandidates(
  input: Readonly<{
    result: StepResultV1;
    state: WorkflowState;
    allocator?: IdAllocator;
  }>,
): NormalizedResultCandidates {
  const allocator = input.allocator ?? createIdAllocator();
  const used = {
    uncertainties: collectIds(input.state.snapshot.uncertainties.uncertainties),
    decisions: collectIds(input.state.snapshot.decisions.decisions),
    acceptanceCriteria: collectIds(input.state.snapshot.requirement.acceptance_criteria),
    constraints: collectIds(input.state.snapshot.requirement.constraints),
    findings: collectIds(input.state.snapshot.findings.findings),
    planDeviations: new Set<string>(),
  };
  const result = input.result;

  return {
    uncertainty_candidates: result.uncertainty_candidates.map((candidate) =>
      identify(candidate, () => allocator.issueUncertaintyId(), used.uncertainties),
    ),
    decision_requests: result.decision_requests.map((candidate) =>
      identify(candidate, () => allocator.issueDecisionId(), used.decisions),
    ),
    requirement_candidates: {
      acceptance_criteria: result.requirement_candidates.acceptance_criteria.map((candidate) =>
        identify(candidate, () => allocator.issueAcceptanceCriterionId(), used.acceptanceCriteria),
      ),
      constraints: result.requirement_candidates.constraints.map((candidate) =>
        identify(candidate, () => allocator.issueConstraintId(), used.constraints),
      ),
      assumptions: result.requirement_candidates.assumptions,
    },
    finding_candidates: result.finding_candidates.map((candidate) =>
      identify(candidate, () => allocator.issueFindingId(), used.findings),
    ),
    finding_rechecks: normalizeFindingRechecks(result, input.state),
    plan_deviations: result.plan_deviations.map((candidate) =>
      identify(candidate, () => allocator.issuePlanDeviationId(), used.planDeviations),
    ),
    skill_requests: result.skill_requests,
    execution_checks: result.execution_checks,
    observations: result.observations,
  };
}

function agentVersionNumber(version: string): number {
  const match = /^(\d+)(?:\.\d+){0,2}(?:[-+].*)?$/.exec(version.trim());
  const value = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("ARTIFACT_INVALID", `Agent version must start with a positive number: ${version}`);
  }
  return value;
}

function artifactPurposeSlug(purpose: string): string {
  const slug = purpose
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) {
    fail("ARTIFACT_INVALID", "Agent Artifact purpose must contain an ASCII path slug");
  }
  return slug;
}

function artifactDestination(
  draft: AgentArtifactDraft,
  executionId: string,
  usedPaths: Set<string>,
): string {
  const root = draft.type;
  const slug = artifactPurposeSlug(draft.purpose);
  let suffix = 1;
  for (;;) {
    const numbered = suffix === 1 ? "" : `-${suffix}`;
    const path = `${root}/${slug}${numbered}-${executionId}.md`;
    if (!usedPaths.has(path)) {
      usedPaths.add(path);
      return path;
    }
    suffix += 1;
  }
}

function agentArtifactContents(
  input: ResultValidationInput,
  draft: AgentArtifactDraft,
  status: ArtifactStatus,
  createdAt: string,
): string {
  const stateRevision = input.state.run.state_revision;
  if (!Number.isSafeInteger(stateRevision) || stateRevision < 0) {
    fail("ARTIFACT_INVALID", "Current state revision must be a non-negative safe integer");
  }
  const frontMatter = ArtifactFrontMatterV1Schema.parse({
    schema_version: 1,
    run_id: input.request.identity.runId,
    step_id: input.request.identity.stepId,
    execution_id: input.request.identity.executionId,
    execution_state_revision: stateRevision,
    agent: {
      id: input.request.identity.agentId,
      version: agentVersionNumber(input.request.identity.agentVersion),
    },
    artifact: { type: draft.type, status },
    created_at: createdAt,
    skills: [...input.request.skills.required, ...input.request.skills.optional],
  });
  const body = draft.content.endsWith("\n") ? draft.content : `${draft.content}\n`;
  return `---\n${stringifyYaml(frontMatter).trimEnd()}\n---\n${body}`;
}

async function finalizeAgentArtifactDrafts(
  input: ResultValidationInput,
  result: StepResultV1,
  options: Pick<ResultNormalizationOptions, "artifactStore" | "maxArtifactBytes" | "now">,
): Promise<StepResultV1> {
  const drafts = result.artifacts.filter(isAgentArtifactDraft);
  if (drafts.length === 0) return result;
  if (options.artifactStore === undefined) {
    fail(
      "ARTIFACT_INVALID",
      "Agent Artifact drafts require an ArtifactStore for Orchestrator finalization",
    );
  }
  const now = options.now?.() ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    fail("ARTIFACT_INVALID", "Artifact finalization clock must return a valid Date");
  }
  const status: ArtifactStatus = result.outcome === "completed" ? "complete" : "partial";
  const usedPaths = new Set(
    result.artifacts.flatMap((artifact) =>
      isArtifactReference(artifact) && typeof artifact.path === "string" ? [artifact.path] : [],
    ),
  );
  const artifacts: JsonValue[] = [];
  for (const artifact of result.artifacts) {
    if (!isAgentArtifactDraft(artifact)) {
      artifacts.push(artifact);
      continue;
    }
    const contents = agentArtifactContents(input, artifact, status, now.toISOString());
    if (
      options.maxArtifactBytes !== undefined &&
      Buffer.byteLength(contents, "utf8") > options.maxArtifactBytes
    ) {
      fail("ARTIFACT_INVALID", `Agent Artifact exceeds the configured size limit`);
    }
    const staged = await options.artifactStore.stage({
      runId: input.request.identity.runId,
      executionId: input.request.identity.executionId,
      contents,
    });
    const ref = await options.artifactStore.finalize(
      staged,
      artifactDestination(artifact, input.request.identity.executionId, usedPaths),
    );
    artifacts.push({ runId: ref.runId, path: ref.path, status: ref.status });
  }
  return { ...result, artifacts };
}

function validateArtifactContent(
  content: ArtifactContent,
  ref: ArtifactRef,
  input: ResultValidationInput,
  maxArtifactBytes: number | undefined,
): void {
  if (
    content.ref.runId !== ref.runId ||
    content.ref.path !== ref.path ||
    content.ref.status !== ref.status
  ) {
    fail("ARTIFACT_INVALID", `Artifact reference does not match ${ref.path}`);
  }
  if (
    content.frontMatter.run_id !== input.request.identity.runId ||
    content.frontMatter.step_id !== input.request.identity.stepId ||
    content.frontMatter.execution_id !== input.request.identity.executionId
  ) {
    fail("ARTIFACT_INVALID", `Artifact identity does not match Execution ${ref.path}`);
  }
  if (content.frontMatter.agent.id !== input.request.identity.agentId) {
    fail("ARTIFACT_INVALID", `Artifact Agent does not match Execution ${ref.path}`);
  }
  if (content.frontMatter.artifact.status !== ref.status) {
    fail("ARTIFACT_INVALID", `Artifact status does not match reference ${ref.path}`);
  }
  if (typeof content.contents !== "string") {
    fail("ARTIFACT_INVALID", `Artifact contents must be text: ${ref.path}`);
  }
  if (
    maxArtifactBytes !== undefined &&
    Buffer.byteLength(content.contents, "utf8") > maxArtifactBytes
  ) {
    fail("ARTIFACT_INVALID", `Artifact exceeds the configured size limit: ${ref.path}`);
  }
}

export async function validateResultArtifacts(
  input: ResultValidationInput,
  options: Pick<ResultNormalizationOptions, "artifactReader" | "maxArtifactBytes"> = {},
): Promise<ResultArtifactValidation> {
  const maxArtifactBytes = options.maxArtifactBytes;
  if (
    maxArtifactBytes !== undefined &&
    (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 0)
  ) {
    throw new RangeError("maxArtifactBytes must be a non-negative safe integer");
  }

  const draftIndex = input.result.artifacts.findIndex(isAgentArtifactDraft);
  if (draftIndex >= 0) {
    fail(
      "ARTIFACT_INVALID",
      `artifacts[${draftIndex}] is an Agent draft and must be finalized by the Orchestrator`,
    );
  }
  const refs = parseResultArtifactReferences(input.result, input.request);
  if (options.artifactReader === undefined) {
    if (refs.length > 0) {
      fail("ARTIFACT_INVALID", "Artifact references require an ArtifactReader");
    }
    if (
      input.result.outcome === "completed" &&
      input.request.outputs.expectedArtifactTypes.length > 0
    ) {
      fail(
        "REQUIRED_ARTIFACT_MISSING",
        "Required Artifact types cannot be validated without an ArtifactReader",
      );
    }
    return { refs, contents: [] };
  }

  const contents = await Promise.all(
    refs.map(async (ref) => {
      let content: ArtifactContent;
      try {
        content = await options.artifactReader!.read(ref);
      } catch (error) {
        const reason = error instanceof Error ? `: ${error.message}` : "";
        fail("ARTIFACT_INVALID", `Artifact could not be read ${ref.path}${reason}`);
      }
      validateArtifactContent(content, ref, input, maxArtifactBytes);
      return content;
    }),
  );

  if (input.result.outcome === "completed") {
    for (const expectedType of input.request.outputs.expectedArtifactTypes) {
      const found = contents.some(
        (content) =>
          content.frontMatter.artifact.type === expectedType &&
          content.frontMatter.artifact.status === "complete" &&
          content.ref.status === "complete",
      );
      if (!found) {
        fail(
          "REQUIRED_ARTIFACT_MISSING",
          `Completed result is missing required Artifact type ${expectedType}`,
        );
      }
    }
  }

  return { refs, contents };
}

export async function normalizeStepResult(
  input: Readonly<{
    result: unknown;
    request: AgentExecutionRequestV1;
    state: WorkflowState;
    step: SchedulerStep;
  }>,
  options: ResultNormalizationOptions = {},
): Promise<ResultNormalizationResult> {
  const validated = await validateStepResult(input, options);
  const validatedInput: ResultValidationInput = { ...input, result: validated };
  const finalized = await finalizeAgentArtifactDrafts(validatedInput, validated, options);
  const plan = normalizePlanCandidate(finalized.plan);
  const result = plan === undefined ? finalized : { ...finalized, plan };
  const normalizedInput: ResultValidationInput = { ...validatedInput, result };
  const state =
    options.postconditions === undefined
      ? noPostconditions(input.state)
      : await options.postconditions(normalizedInput);
  const candidates = normalizeResultCandidates({
    result,
    state,
    ...(options.allocator === undefined ? {} : { allocator: options.allocator }),
  });
  const artifacts = await validateResultArtifacts({ ...normalizedInput, state }, options);
  return {
    state,
    result,
    ...(plan === undefined ? {} : { plan }),
    candidates,
    artifacts,
  };
}
