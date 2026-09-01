import { isAbsolute, win32 } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  AgentExecutionRequestV1Schema,
  type AgentExecutionRequestV1,
  type JsonObject,
} from "../../contracts/execution/agent-execution.js";
import { ArtifactFrontMatterV1Schema } from "../../contracts/artifacts/artifact.js";
import {
  evaluateRepositoryDrift,
  isRepositoryDriftBlocking,
  type RepositoryDriftEvaluation,
  type RepositoryDriftPath,
  type RepositoryDriftPathClassification,
} from "../../domain/freshness/freshness.js";
import type { ArtifactRef, ArtifactStore } from "../../ports/artifact-store.js";
import type {
  RepositoryAdapter,
  RepositoryDiff,
  RepositoryFileDiff,
  RepositorySnapshot,
} from "../../ports/repository.js";
import type { WorkflowState } from "../../ports/run-reader.js";

export type RepositoryDriftPathClassifier = (
  path: string,
  file: RepositoryFileDiff,
) => RepositoryDriftPathClassification;

export type RepositoryDriftCheckInput = Readonly<{
  before: RepositorySnapshot;
  classifyPath?: RepositoryDriftPathClassifier;
  pathClassifications?: Readonly<Record<string, RepositoryDriftPathClassification>>;
}>;

export type RepositoryDriftCheckResult = RepositoryDriftEvaluation &
  Readonly<{
    before: RepositorySnapshot;
    after: RepositorySnapshot;
    diff: RepositoryDiff;
    paths: readonly RepositoryDriftPath[];
    changedFiles: readonly string[];
    controlPlaneChanged: boolean;
  }>;

export type RepositoryReconciliation = JsonObject;

export type RepositoryDriftRecoveryOptions = Readonly<{
  repository: RepositoryAdapter;
  artifactStore?: ArtifactStore;
  now?: () => Date;
}>;

export type RepositoryReconciliationFinalizationInput = Readonly<{
  request: AgentExecutionRequestV1;
  executionStateRevision: number;
  assessment: RepositoryDriftCheckResult;
  reconciliation: RepositoryReconciliation;
}>;

export type RepositoryReconciliationFinalization = Readonly<{
  artifact: ArtifactRef;
  contents: string;
}>;

export type RepositoryDriftRecoveryErrorCode =
  | "INVALID_PATH"
  | "INVALID_CLASSIFICATION"
  | "INVALID_REVISION"
  | "ARTIFACT_STORE_UNAVAILABLE";

export class RepositoryDriftRecoveryError extends Error {
  constructor(
    readonly code: RepositoryDriftRecoveryErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "RepositoryDriftRecoveryError";
  }
}

const DRIFT_PATH_CLASSIFICATIONS: readonly RepositoryDriftPathClassification[] = [
  "unrelated",
  "relevant",
  "critical",
  "unknown",
];

function isPathClassification(value: unknown): value is RepositoryDriftPathClassification {
  return (
    typeof value === "string" && (DRIFT_PATH_CLASSIFICATIONS as readonly string[]).includes(value)
  );
}

function repositoryPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\u0000") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.split("/").some((segment) => segment === "..")
  ) {
    throw new RepositoryDriftRecoveryError(
      "INVALID_PATH",
      `Repository drift path is unsafe: ${String(value)}`,
    );
  }
  return value;
}

function pathClassification(
  input: RepositoryDriftCheckInput,
  file: RepositoryFileDiff,
): RepositoryDriftPathClassification {
  const path = repositoryPath(file.path);
  let value: unknown;
  if (input.classifyPath !== undefined) {
    value = input.classifyPath(path, file);
  } else if (input.pathClassifications !== undefined) {
    value = input.pathClassifications[path] ?? "unknown";
  } else {
    value = "unknown";
  }

  if (!isPathClassification(value)) {
    throw new RepositoryDriftRecoveryError(
      "INVALID_CLASSIFICATION",
      `Invalid classification for ${path}: ${String(value)}`,
    );
  }
  return value;
}

function validRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RepositoryDriftRecoveryError(
      "INVALID_REVISION",
      "executionStateRevision must be a non-negative safe integer",
    );
  }
}

function agentVersionNumber(version: string): number {
  const match = /^(\d+)(?:\.\d+){0,2}(?:[-+].*)?$/.exec(version.trim());
  const value = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RepositoryDriftRecoveryError(
      "INVALID_REVISION",
      `Agent version must start with a positive numeric version: ${version}`,
    );
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repositoryBlock(blocked: JsonObject | null): boolean {
  return blocked?.reason === "repository-drift";
}

function snapshotSummary(snapshot: RepositorySnapshot) {
  return {
    root: snapshot.root,
    head: snapshot.head,
    branch: snapshot.branch,
    status: snapshot.status,
    fingerprint: snapshot.fingerprint,
  };
}

export function applyRepositoryDrift(
  state: WorkflowState,
  assessment: RepositoryDriftCheckResult,
  reconciliation?: RepositoryReconciliation,
): WorkflowState {
  const resolution = reconciliation === undefined ? assessment.resolution : "reconciled";
  const blocking = isRepositoryDriftBlocking(assessment.classification, resolution);
  const material =
    assessment.classification === "relevant" ||
    assessment.classification === "critical" ||
    assessment.classification === "unknown";
  const currentPlan =
    material && state.run.current_plan !== null
      ? {
          ...state.run.current_plan,
          applicability: {
            ...state.run.current_plan.applicability,
            status: "replan-required" as const,
          },
        }
      : state.run.current_plan;
  const existingEvidence = state.run.repository.evidence;
  if (material && existingEvidence !== undefined && !isJsonObject(existingEvidence)) {
    throw new RepositoryDriftRecoveryError(
      "INVALID_CLASSIFICATION",
      "repository.evidence must be an object when repository drift invalidates it",
    );
  }
  const repository = {
    ...state.run.repository,
    classification: assessment.classification,
    resolution,
    changed_paths: [...assessment.changedFiles],
    path_classifications: Object.fromEntries(
      assessment.paths.map(({ path, classification }) => [path, classification]),
    ),
    control_plane_changed: assessment.controlPlaneChanged,
    drift: {
      blocking,
      head_changed: assessment.diff.headChanged,
      branch_changed: assessment.diff.branchChanged,
      status_changed: assessment.diff.statusChanged,
      fingerprint_changed: assessment.diff.fingerprintChanged,
    },
    ...(material
      ? {
          evidence: {
            ...(isJsonObject(existingEvidence) ? existingEvidence : {}),
            freshness: "stale",
            invalidated_by: "repository-drift",
          },
        }
      : {}),
  } satisfies JsonObject;

  let run = {
    ...state.run,
    current_plan: currentPlan,
    current_changes: {
      ...state.run.current_changes,
      ...(reconciliation === undefined ? {} : { external_reconciliation: reconciliation }),
    },
    repository,
  };

  if (blocking && !run.finalized) {
    run = {
      ...run,
      status: "blocked",
      blocked: {
        reason: "repository-drift",
        classification: assessment.classification,
        paths: [...assessment.changedFiles],
      },
    };
  } else if (!blocking && repositoryBlock(state.run.blocked) && state.run.status === "blocked") {
    run = { ...run, status: "running", blocked: null };
  }

  return { ...state, run };
}

export class RepositoryDriftRecovery {
  private readonly artifactStore: ArtifactStore | undefined;
  private readonly now: () => Date;

  constructor(private readonly options: RepositoryDriftRecoveryOptions) {
    this.artifactStore = options.artifactStore;
    this.now = options.now ?? (() => new Date());
  }

  async check(input: RepositoryDriftCheckInput): Promise<RepositoryDriftCheckResult> {
    const after = await this.options.repository.captureSnapshot();
    const diff = await this.options.repository.diff(input.before, after);
    const paths = diff.files.map((file) => ({
      path: repositoryPath(file.path),
      classification: pathClassification(input, file),
    }));
    const controlPlaneChanged = diff.headChanged || diff.branchChanged;
    const evaluation = evaluateRepositoryDrift({
      paths,
      controlPlaneChanged,
      unknownChange:
        paths.length === 0 &&
        (diff.statusChanged || diff.fingerprintChanged || diff.changedFiles.length > 0),
    });

    return {
      ...evaluation,
      before: input.before,
      after,
      diff,
      paths,
      changedFiles: diff.changedFiles.map(repositoryPath),
      controlPlaneChanged,
    };
  }

  apply(
    state: WorkflowState,
    assessment: RepositoryDriftCheckResult,
    reconciliation?: RepositoryReconciliation,
  ): WorkflowState {
    return applyRepositoryDrift(state, assessment, reconciliation);
  }

  async finalizeReconciliation(
    input: RepositoryReconciliationFinalizationInput,
  ): Promise<RepositoryReconciliationFinalization> {
    if (this.artifactStore === undefined) {
      throw new RepositoryDriftRecoveryError(
        "ARTIFACT_STORE_UNAVAILABLE",
        "Repository reconciliation finalization requires an ArtifactStore",
      );
    }
    const request = AgentExecutionRequestV1Schema.parse(input.request);
    validRevision(input.executionStateRevision);
    const createdAt = this.now();
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
      throw new RepositoryDriftRecoveryError("INVALID_REVISION", "now must return a valid Date");
    }
    const frontMatter = ArtifactFrontMatterV1Schema.parse({
      schema_version: 1,
      run_id: request.identity.runId,
      step_id: request.identity.stepId,
      execution_id: request.identity.executionId,
      execution_state_revision: input.executionStateRevision,
      agent: {
        id: request.identity.agentId,
        version: agentVersionNumber(request.identity.agentVersion),
      },
      artifact: { type: "reconciliation", status: "complete" },
      created_at: createdAt.toISOString(),
      skills: [...request.skills.required, ...request.skills.optional],
    });
    const payload = {
      classification: input.assessment.classification,
      resolution: "reconciled",
      changed_paths: input.assessment.changedFiles,
      path_classifications: input.assessment.paths,
      repository: {
        before: snapshotSummary(input.assessment.before),
        after: snapshotSummary(input.assessment.after),
        diff: {
          changed_files: input.assessment.diff.changedFiles,
          head_changed: input.assessment.diff.headChanged,
          branch_changed: input.assessment.diff.branchChanged,
          status_changed: input.assessment.diff.statusChanged,
          fingerprint_changed: input.assessment.diff.fingerprintChanged,
        },
      },
      reconciliation: input.reconciliation,
    };
    const contents = [
      "---",
      stringifyYaml(frontMatter).trimEnd(),
      "---",
      "## Repository Reconciliation",
      "",
      "```json",
      JSON.stringify(payload, null, 2),
      "```",
      "",
    ].join("\n");
    const staged = await this.artifactStore.stage({
      runId: request.identity.runId,
      executionId: request.identity.executionId,
      contents,
    });
    const artifact = await this.artifactStore.finalize(
      staged,
      `implementation/reconciliation-${request.identity.executionId}.md`,
    );
    return { artifact, contents };
  }
}
