import {
  buildFinalGateSet,
  buildFixWavePlan,
  evaluateFocusedReview,
  evaluateTrustedGates,
  isValidArtifactRef,
  isValidFindingId,
  isValidWorkflowId,
  isWorkflowType,
  validateFocusedReviewResult,
  validateFixWave,
  validateWorkerHandoff,
  validateWorkerResult,
  WORKER_FORBIDDEN_OPERATIONS,
  type ArtifactRef,
  type DispositionedFinding,
  type FixWave,
  type FocusedReviewResult,
  type FindingId,
  type TestStrategy,
  type TddMode,
  type TrustedGate,
  type WorkerHandoff,
  type WorkerResult,
} from "../core/index.ts";
import {
  hasOnlyKeys,
  invalidResult,
  isBoundedString,
  isRecord,
  isSafeRelativePath,
  utf8ByteLength,
  validResult,
  type ValidationResult,
} from "../core/validation.ts";
import {
  executeTrustedGate,
  type ManagedGateRunner,
} from "./gate-execution.ts";

const MAX_FIX_WORKER_TASK_BYTES = 64 * 1024;
const MAX_LIST_ITEMS = 32;
const MAX_LIST_ITEM_BYTES = 4096;
const FIX_WORKER_OUTPUT = "fix-worker-summary.md";
const FOCUSED_REVIEW_OUTPUT = "focused-re-review.md";
const FIX_WAVE_GATE_KEY_PREFIX = "fix-wave-gate";

export interface FixWavePreparationInput {
  readonly workflow: WorkerHandoff["workflow"];
  readonly findings: readonly DispositionedFinding[];
  readonly completedWaveCount?: number;
  readonly scope: WorkerHandoff["scope"];
  readonly nonGoals: readonly string[];
  readonly tddMode: TddMode;
  readonly testStrategy: TestStrategy;
  readonly testSeams: readonly string[];
  readonly verificationCommands: readonly string[];
  readonly trustedGateExpectations: readonly string[];
  readonly stopCondition: string;
}

export interface FixWorkerLaunchRequest {
  readonly agent: "worker";
  readonly context: "fresh";
  readonly task: string;
  readonly skill?: readonly ["tdd"];
  readonly output: typeof FIX_WORKER_OUTPUT;
  readonly outputMode: "file-only";
  readonly worktree: false;
}

export interface FixWavePreparation {
  readonly wave: FixWave;
  readonly acceptedFindings: readonly DispositionedFinding[];
  readonly workerHandoff: WorkerHandoff;
  readonly workerRequest: FixWorkerLaunchRequest;
}

export type FixWavePreparationResult =
  | { prepared: true; value: FixWavePreparation }
  | {
      prepared: false;
      reason:
        | "NO_ACCEPTED_FINDINGS"
        | "MAX_FIX_WAVES_REACHED"
        | "INVALID_FINDING"
        | "INVALID_FIX_WORKER_INPUT";
      errors?: readonly string[];
    };

export interface AffectedGateSelectionInput {
  readonly approvedGates: readonly TrustedGate[];
  readonly mechanicallyRequiredGates?: readonly TrustedGate[];
  readonly affectedGateNames?: readonly string[];
}

export interface SkippedOptionalGate {
  readonly name: string;
  readonly reason: string;
}

export interface AffectedGateSelection {
  readonly gates: readonly TrustedGate[];
  readonly requiredGateKeys: readonly string[];
  readonly skippedOptionalGates: readonly SkippedOptionalGate[];
}

export interface FocusedReviewLaunchInput {
  readonly workflow: WorkerHandoff["workflow"];
  readonly planArtifactRef: ArtifactRef;
  readonly planningHandoffRef: ArtifactRef;
  readonly acceptedFindingIds: readonly FindingId[];
  readonly fixWorkerDiffRef: ArtifactRef;
  readonly scope: WorkerHandoff["scope"];
  readonly nonGoals: readonly string[];
}

export interface FocusedReviewLaunchRequest {
  readonly agent: "reviewer";
  readonly context: "fresh";
  readonly task: string;
  readonly output: typeof FOCUSED_REVIEW_OUTPUT;
  readonly outputMode: "file-only";
  readonly artifacts: true;
  readonly worktree: false;
}

export interface FixWorkerRun {
  readonly result: unknown;
  readonly diffRef: ArtifactRef;
}

export type FixWorkerRunner = (
  key: string,
  request: FixWorkerLaunchRequest,
) => Promise<FixWorkerRun>;

export interface FocusedReviewRun {
  readonly result: unknown;
  readonly reportRef: ArtifactRef;
}

export type FocusedReviewRunner = (
  key: string,
  request: FocusedReviewLaunchRequest,
) => Promise<FocusedReviewRun>;

export interface FixWaveExecutionOptions extends AffectedGateSelectionInput {
  readonly planArtifactRef: ArtifactRef;
  readonly planningHandoffRef: ArtifactRef;
  readonly fixWorkerRunner: FixWorkerRunner;
  readonly gateRunner: ManagedGateRunner;
  readonly focusedReviewRunner: FocusedReviewRunner;
}

export type FixWaveExecutionResult =
  | { status: "NO_WAVE"; reason: "NO_ACCEPTED_FINDINGS" }
  | {
      status: "FAILED";
      reason: string;
      wave?: FixWave;
      worker?: WorkerResult;
      gates?: readonly TrustedGate[];
      focusedReReview?: FocusedReviewResult;
    }
  | {
      status: "COMPLETED";
      wave: FixWave;
      worker: WorkerResult;
      fixWorkerDiffRef: ArtifactRef;
      gates: readonly TrustedGate[];
      skippedOptionalGates: readonly SkippedOptionalGate[];
      focusedReReview: FocusedReviewResult;
      focusedReviewReportRef: ArtifactRef;
    };

function boundedFailureReason(value: unknown): string {
  let reason =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "Fix Wave failed";
  reason = reason.trim();
  while (reason.length > 0 && utf8ByteLength(reason) > MAX_LIST_ITEM_BYTES) {
    reason = reason.slice(0, -1);
  }
  return reason || "Fix Wave failed";
}

function workerFindingPayload(
  dispositioned: DispositionedFinding,
): Record<string, unknown> {
  const { finding, disposition } = dispositioned;
  return {
    findingId: finding.id,
    disposition: disposition.disposition,
    ...(finding.location === undefined ? {} : { location: finding.location }),
    evidence: finding.evidence,
    reason: finding.reason,
    ...(finding.recommendedAction === undefined
      ? {}
      : { recommendedAction: finding.recommendedAction }),
  };
}

function buildFixWorkerRequest(
  plan: FixWavePreparation["wave"],
  acceptedFindings: readonly DispositionedFinding[],
  handoff: WorkerHandoff,
): ValidationResult<FixWorkerLaunchRequest> {
  const task = JSON.stringify({
    fixWave: {
      waveNumber: plan.waveNumber,
      acceptedFindingIds: [...plan.acceptedFindingIds],
    },
    requiredChanges: acceptedFindings.map(workerFindingPayload),
    allowedScope: handoff.scope,
    nonGoals: handoff.nonGoals,
    tests: {
      tddMode: handoff.tddMode,
      strategy: handoff.testStrategy,
      seams: handoff.testSeams,
      verificationCommands: handoff.verificationCommands,
      trustedGateExpectations: handoff.trustedGateExpectations,
    },
    stopCondition: handoff.stopCondition,
    authority: {
      sourceWrite: "approved-scope-only",
      prohibitedOperations: [...WORKER_FORBIDDEN_OPERATIONS],
    },
  });
  if (!isBoundedString(task, MAX_FIX_WORKER_TASK_BYTES, true)) {
    return invalidResult("Fix Worker task is too large");
  }
  return validResult({
    agent: "worker",
    context: "fresh",
    task,
    ...(handoff.tddMode === "required" ? { skill: ["tdd"] as const } : {}),
    output: FIX_WORKER_OUTPUT,
    outputMode: "file-only",
    worktree: false,
  });
}

function isFixWavePreparationInput(
  value: unknown,
): value is FixWavePreparationInput {
  return isRecord(value);
}

export function prepareFixWave(
  input: FixWavePreparationInput,
): FixWavePreparationResult {
  if (!isFixWavePreparationInput(input)) {
    return { prepared: false, reason: "INVALID_FIX_WORKER_INPUT" };
  }

  const plan = buildFixWavePlan(input.findings, input.completedWaveCount ?? 0);
  if (!plan.created) return { prepared: false, reason: plan.reason };

  const workerHandoff: WorkerHandoff = {
    contractVersion: 1,
    workflow: input.workflow,
    requirements: plan.plan.acceptedFindings.map(
      ({ finding }) => `Fix accepted Finding ${finding.id}`,
    ),
    scope: input.scope,
    nonGoals: input.nonGoals,
    tddMode: input.tddMode,
    testStrategy: input.testStrategy,
    testSeams: input.testSeams,
    verificationCommands: input.verificationCommands,
    trustedGateExpectations: input.trustedGateExpectations,
    stopCondition: input.stopCondition,
  };
  const handoff = validateWorkerHandoff(workerHandoff);
  if (!handoff.valid) {
    return {
      prepared: false,
      reason: "INVALID_FIX_WORKER_INPUT",
      errors: handoff.errors,
    };
  }

  const request = buildFixWorkerRequest(
    plan.plan.wave,
    plan.plan.acceptedFindings,
    handoff.value,
  );
  if (!request.valid) {
    return {
      prepared: false,
      reason: "INVALID_FIX_WORKER_INPUT",
      errors: request.errors,
    };
  }
  return {
    prepared: true,
    value: {
      wave: plan.plan.wave,
      acceptedFindings: plan.plan.acceptedFindings,
      workerHandoff: handoff.value,
      workerRequest: request.value,
    },
  };
}

function gateIdentity(gate: Pick<TrustedGate, "name" | "command">): string {
  return `${gate.name}\u0000${gate.command}`;
}

function gateMatchesSelector(gate: TrustedGate, selector: string): boolean {
  return selector === gate.name || selector === gateIdentity(gate);
}

function gatePendingForExecution(gate: TrustedGate): TrustedGate {
  return {
    name: gate.name,
    command: gate.command,
    requirement: gate.requirement,
    status: "UNKNOWN",
    source: gate.source,
    reason: "Fix Wave re-gate execution is pending.",
  };
}

function validateAffectedGateNames(
  value: readonly string[] | undefined,
): ValidationResult<readonly string[]> {
  if (value === undefined) return validResult([]);
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    return invalidResult("Affected Gate selection is not bounded");
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const name of value) {
    if (
      !isBoundedString(name, MAX_LIST_ITEM_BYTES, true) ||
      /[\r\n]/u.test(name) ||
      seen.has(name)
    ) {
      return invalidResult("Affected Gate selection contains an invalid name");
    }
    seen.add(name);
    names.push(name);
  }
  return validResult(names);
}

export function selectAffectedGates(
  input: AffectedGateSelectionInput,
): ValidationResult<AffectedGateSelection> {
  if (!isRecord(input)) return invalidResult("Affected Gate input is invalid");
  const finalGates = buildFinalGateSet(
    input.approvedGates,
    input.mechanicallyRequiredGates ?? [],
  );
  if (!finalGates.valid) return finalGates;

  const names = validateAffectedGateNames(input.affectedGateNames);
  if (!names.valid) return names;

  for (const selector of names.value) {
    if (!finalGates.value.some((gate) => gateMatchesSelector(gate, selector))) {
      return invalidResult(`Affected Gate is not declared: ${selector}`);
    }
  }

  const selected = finalGates.value
    .filter(
      (gate) =>
        gate.requirement === "required" ||
        names.value.some((selector) => gateMatchesSelector(gate, selector)),
    )
    .map(gatePendingForExecution);
  const requiredGateKeys = selected
    .filter((gate) => gate.requirement === "required")
    .map(gateIdentity);
  const selectedKeys = new Set(selected.map(gateIdentity));
  const skippedOptionalGates = finalGates.value
    .filter(
      (gate) =>
        gate.requirement === "optional" &&
        !selectedKeys.has(gateIdentity(gate)),
    )
    .map((gate) => ({
      name: gate.name,
      reason: "No affected Gate evidence was selected for this Fix Wave.",
    }));

  return validResult({
    gates: selected,
    requiredGateKeys,
    skippedOptionalGates,
  });
}

function validWorkflow(value: unknown): value is WorkerHandoff["workflow"] {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["workflowId", "workflowType", "cwd"]) &&
    isValidWorkflowId(value.workflowId) &&
    isWorkflowType(value.workflowType) &&
    isBoundedString(value.cwd, MAX_LIST_ITEM_BYTES, true) &&
    !/[\0\r\n]/u.test(value.cwd)
  );
}

function validStringList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LIST_ITEMS &&
    value.every((item) => isBoundedString(item, MAX_LIST_ITEM_BYTES, true))
  );
}

function validScope(value: unknown): value is WorkerHandoff["scope"] {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["allowedPaths", "allowedAreas"]) ||
    !Array.isArray(value.allowedPaths) ||
    !Array.isArray(value.allowedAreas) ||
    value.allowedPaths.length > MAX_LIST_ITEMS ||
    value.allowedAreas.length > MAX_LIST_ITEMS
  ) {
    return false;
  }
  return [...value.allowedPaths, ...value.allowedAreas].every(
    (path) =>
      isBoundedString(path, MAX_LIST_ITEM_BYTES, true) &&
      isSafeRelativePath(path),
  );
}

export function createFocusedReReviewRequest(
  input: FocusedReviewLaunchInput,
): ValidationResult<FocusedReviewLaunchRequest> {
  if (!isRecord(input)) {
    return invalidResult("Focused Re-review input is invalid");
  }
  if (
    !validWorkflow(input.workflow) ||
    !isValidArtifactRef(input.planArtifactRef) ||
    !isValidArtifactRef(input.planningHandoffRef) ||
    !isValidArtifactRef(input.fixWorkerDiffRef) ||
    !validScope(input.scope) ||
    !validStringList(input.nonGoals)
  ) {
    return invalidResult("Focused Re-review input is invalid");
  }
  const wave = validateFixWave({
    waveNumber: 1,
    acceptedFindingIds: input.acceptedFindingIds,
  });
  if (!wave.valid) return wave;
  if (wave.value.acceptedFindingIds.some((id) => !isValidFindingId(id))) {
    return invalidResult("Focused Re-review Finding IDs are invalid");
  }

  const task = JSON.stringify({
    purpose: "focused-re-review",
    workflow: input.workflow,
    acceptedFindingIds: [...wave.value.acceptedFindingIds],
    fixWorkerDiffRef: input.fixWorkerDiffRef,
    planArtifactRef: input.planArtifactRef,
    planningHandoffRef: input.planningHandoffRef,
    scope: input.scope,
    nonGoals: input.nonGoals,
    readOnly: true,
    result: ["RESOLVED", "STILL_PRESENT"],
  });
  if (!isBoundedString(task, MAX_FIX_WORKER_TASK_BYTES, true)) {
    return invalidResult("Focused Re-review task is too large");
  }
  return validResult({
    agent: "reviewer",
    context: "fresh",
    task,
    output: FOCUSED_REVIEW_OUTPUT,
    outputMode: "file-only",
    artifacts: true,
    worktree: false,
  });
}

function failed(
  reason: string,
  wave?: FixWave,
  extra: Pick<
    Extract<FixWaveExecutionResult, { status: "FAILED" }>,
    "worker" | "gates" | "focusedReReview"
  > = {},
): Extract<FixWaveExecutionResult, { status: "FAILED" }> {
  return {
    status: "FAILED",
    reason: boundedFailureReason(reason),
    ...(wave === undefined ? {} : { wave }),
    ...extra,
  };
}

export async function executeFixWave(
  input: FixWavePreparationInput,
  options: FixWaveExecutionOptions,
): Promise<FixWaveExecutionResult> {
  const prepared = prepareFixWave(input);
  if (!prepared.prepared) {
    if (prepared.reason === "NO_ACCEPTED_FINDINGS") {
      return { status: "NO_WAVE", reason: prepared.reason };
    }
    return failed(
      prepared.errors?.join("; ") ||
        `Fix Wave could not be prepared: ${prepared.reason}`,
    );
  }

  const selection = selectAffectedGates(options);
  if (!selection.valid) {
    return failed(selection.errors.join("; "), prepared.value.wave);
  }

  let workerRun: FixWorkerRun;
  try {
    workerRun = await options.fixWorkerRunner(
      "fix-wave-1",
      prepared.value.workerRequest,
    );
  } catch (error) {
    return failed(boundedFailureReason(error), prepared.value.wave);
  }
  if (!isRecord(workerRun) || !isValidArtifactRef(workerRun.diffRef)) {
    return failed(
      "Fix Worker diff artifact reference is invalid",
      prepared.value.wave,
    );
  }

  const worker = validateWorkerResult(
    workerRun.result,
    prepared.value.workerHandoff,
  );
  if (!worker.valid) {
    return failed(worker.errors.join("; "), prepared.value.wave);
  }
  if (worker.value.status !== "COMPLETED") {
    return failed(
      `Fix Worker ended with ${worker.value.status}`,
      prepared.value.wave,
      { worker: worker.value },
    );
  }

  const gates: TrustedGate[] = [];
  for (const [index, gate] of selection.value.gates.entries()) {
    const result = await executeTrustedGate(
      gate,
      options.gateRunner,
      `${FIX_WAVE_GATE_KEY_PREFIX}-${index + 1}`,
    );
    if (!result.valid) {
      return failed(result.errors.join("; "), prepared.value.wave, {
        worker: worker.value,
        gates,
      });
    }
    gates.push(result.value);
  }
  const gateEvaluation = evaluateTrustedGates(
    gates,
    selection.value.requiredGateKeys,
  );
  if (!gateEvaluation.passed) {
    return failed(
      gateEvaluation.blockers.map(({ reason }) => reason).join("; "),
      prepared.value.wave,
      { worker: worker.value, gates },
    );
  }

  const reviewRequest = createFocusedReReviewRequest({
    workflow: input.workflow,
    planArtifactRef: options.planArtifactRef,
    planningHandoffRef: options.planningHandoffRef,
    acceptedFindingIds: prepared.value.wave.acceptedFindingIds,
    fixWorkerDiffRef: workerRun.diffRef,
    scope: input.scope,
    nonGoals: input.nonGoals,
  });
  if (!reviewRequest.valid) {
    return failed(reviewRequest.errors.join("; "), prepared.value.wave, {
      worker: worker.value,
      gates,
    });
  }

  let focusedRun: FocusedReviewRun;
  try {
    focusedRun = await options.focusedReviewRunner(
      "focused-re-review-1",
      reviewRequest.value,
    );
  } catch (error) {
    return failed(boundedFailureReason(error), prepared.value.wave, {
      worker: worker.value,
      gates,
    });
  }
  if (!isRecord(focusedRun) || !isValidArtifactRef(focusedRun.reportRef)) {
    return failed(
      "Focused Re-review report artifact reference is invalid",
      prepared.value.wave,
      { worker: worker.value, gates },
    );
  }
  const focusedReview = validateFocusedReviewResult(focusedRun.result);
  if (!focusedReview.valid) {
    return failed(focusedReview.errors.join("; "), prepared.value.wave, {
      worker: worker.value,
      gates,
    });
  }
  const evaluation = evaluateFocusedReview(
    prepared.value.wave,
    focusedReview.value,
  );
  if (!evaluation.passed) {
    return failed(evaluation.reason, prepared.value.wave, {
      worker: worker.value,
      gates,
      focusedReReview: focusedReview.value,
    });
  }

  return {
    status: "COMPLETED",
    wave: prepared.value.wave,
    worker: worker.value,
    fixWorkerDiffRef: workerRun.diffRef,
    gates,
    skippedOptionalGates: selection.value.skippedOptionalGates,
    focusedReReview: focusedReview.value,
    focusedReviewReportRef: focusedRun.reportRef,
  };
}
