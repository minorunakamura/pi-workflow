import {
  withFileMutationQueue,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { Type, type Static } from "typebox";

import {
  PLAN_ARTIFACT_FILE_NAME,
  PLANNING_HANDOFF_FILE_NAME,
  createPlanningHandoff,
  createRunId,
  isRecord,
  isValidRunId,
  isValidWorkflowId,
  validatePlanArtifactTemplate,
  validatePlanningArtifactReferences,
  validatePlanningHandoffAgainstPlan,
  type ArtifactRef,
  type PlanningHandoff,
  type PlanHash,
  type TestStrategy,
  type TddMode,
} from "../core/index.ts";

export const PLAN_HANDOFF_TOOL_NAME = "pi_workflow_write_handoff" as const;

const ARTIFACT_REF_SCHEMA = Type.Object({
  kind: Type.String(),
  path: Type.String(),
  mediaType: Type.String(),
});

const MANAGED_PLAN_OUTPUT_SCHEMA = Type.Object({
  outputReference: Type.Optional(Type.Any()),
  outputPathMapping: Type.Optional(Type.Any()),
  artifactPaths: Type.Optional(Type.Any()),
});

const TEST_STRATEGY_SCHEMA = Type.Object({
  kind: Type.String(),
  required: Type.Boolean(),
  summary: Type.String(),
});

export const PLAN_HANDOFF_TOOL_PARAMETERS = Type.Object({
  workflowId: Type.String(),
  planArtifactRef: ARTIFACT_REF_SCHEMA,
  planningHandoffRef: ARTIFACT_REF_SCHEMA,
  managedPlanOutput: MANAGED_PLAN_OUTPUT_SCHEMA,
  tddMode: Type.String(),
  testStrategy: TEST_STRATEGY_SCHEMA,
  testSeams: Type.Array(Type.String()),
  constraints: Type.Array(Type.String()),
  nonGoals: Type.Array(Type.String()),
  planningRunId: Type.Optional(Type.String()),
});

export type PlanHandoffToolInput = Static<typeof PLAN_HANDOFF_TOOL_PARAMETERS>;

export interface PlanHandoffToolDetails {
  workflowId: string;
  planArtifactRef: ArtifactRef;
  planningHandoffRef: ArtifactRef;
  planHash: PlanHash;
}

interface ResolvedArtifactPaths {
  planPath: string;
  handoffPath: string;
  references: {
    planArtifactRef: ArtifactRef;
    planningHandoffRef: ArtifactRef;
  };
}

function toolError(message: string): Error {
  return new Error(`Cannot write Planning Handoff: ${message}`);
}

function ensureNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw toolError("operation was cancelled");
}

function isAbsoluteManagedPath(value: string): boolean {
  return (
    isAbsolute(value) ||
    value.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/u.test(value)
  );
}

function outputReferencePath(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.path === "string") return value.path;
  return undefined;
}

function validateManagedPlanPath(value: unknown, source: string): string {
  if (
    typeof value !== "string" ||
    !isAbsoluteManagedPath(value) ||
    /[\0\r\n]/u.test(value) ||
    value.split(/[\\/]/u).some((segment) => segment === "..") ||
    basename(value) !== PLAN_ARTIFACT_FILE_NAME
  ) {
    throw toolError(`${source} does not reference implementation-plan.md`);
  }
  return normalize(value);
}

function managedPlanPathFromOutput(value: unknown): string {
  if (!isRecord(value)) {
    throw toolError("managed Plan output reference is missing");
  }

  if (Object.hasOwn(value, "outputReference")) {
    const path = outputReferencePath(value.outputReference);
    if (path === undefined) {
      throw toolError("outputReference has no saved path");
    }
    return validateManagedPlanPath(path, "outputReference");
  }

  if (Object.hasOwn(value, "outputPathMapping")) {
    if (!isRecord(value.outputPathMapping)) {
      throw toolError("outputPathMapping is invalid");
    }
    if (
      value.outputPathMapping.requestedPath !== undefined &&
      (typeof value.outputPathMapping.requestedPath !== "string" ||
        basename(value.outputPathMapping.requestedPath) !==
          PLAN_ARTIFACT_FILE_NAME)
    ) {
      throw toolError("outputPathMapping requestedPath is invalid");
    }
    return validateManagedPlanPath(
      value.outputPathMapping.savedPath,
      "outputPathMapping.savedPath",
    );
  }

  if (Object.hasOwn(value, "artifactPaths")) {
    const paths = value.artifactPaths;
    if (isRecord(paths) && typeof paths.outputPath === "string") {
      return validateManagedPlanPath(
        paths.outputPath,
        "artifactPaths.outputPath",
      );
    }
    if (Array.isArray(paths)) {
      const matches = paths.filter(
        (path): path is string =>
          typeof path === "string" &&
          isAbsoluteManagedPath(path) &&
          basename(path) === PLAN_ARTIFACT_FILE_NAME,
      );
      if (matches.length === 1) {
        return validateManagedPlanPath(matches[0], "artifactPaths");
      }
      if (matches.length > 1) {
        throw toolError("artifactPaths has conflicting Plan paths");
      }
    }
  }

  throw toolError("managed Plan output has no usable public reference");
}

async function resolveArtifactPaths(
  planArtifact: unknown,
  planningHandoff: unknown,
  managedPlanOutput: unknown,
): Promise<ResolvedArtifactPaths> {
  const references = validatePlanningArtifactReferences(
    planArtifact,
    planningHandoff,
  );
  if (!references.valid) {
    throw toolError(references.errors.join("; "));
  }

  const requestedPlanPath = managedPlanPathFromOutput(managedPlanOutput);
  const planPath = await realpath(requestedPlanPath);
  const planStat = await lstat(requestedPlanPath);
  if (!planStat.isFile() || planStat.isSymbolicLink()) {
    throw toolError("managed Plan reference is not a regular file");
  }
  if (basename(planPath) !== PLAN_ARTIFACT_FILE_NAME) {
    throw toolError("managed Plan reference resolves to the wrong file");
  }

  const managedDirectory = await realpath(dirname(planPath));
  const handoffPath = join(managedDirectory, PLANNING_HANDOFF_FILE_NAME);
  return {
    planPath,
    handoffPath,
    references: {
      planArtifactRef: {
        kind: "managed",
        path: planPath,
        mediaType: "text/markdown",
      },
      planningHandoffRef: {
        kind: "managed",
        path: handoffPath,
        mediaType: "application/json",
      },
    },
  };
}

function tddModeFrom(value: string): TddMode | undefined {
  switch (value) {
    case "required":
    case "optional":
    case "not-applicable":
      return value;
    default:
      return undefined;
  }
}

function testStrategyFrom(
  value: PlanHandoffToolInput["testStrategy"],
): TestStrategy | undefined {
  switch (value.kind) {
    case "unit":
    case "integration":
    case "mixed":
    case "none":
      return {
        kind: value.kind,
        required: value.required,
        summary: value.summary,
      };
    default:
      return undefined;
  }
}

function createHandoff(
  input: PlanHandoffToolInput,
  planContent: Uint8Array,
): PlanningHandoff {
  if (!isValidWorkflowId(input.workflowId)) {
    throw toolError("workflowId is invalid");
  }

  const tddMode = tddModeFrom(input.tddMode);
  const testStrategy = testStrategyFrom(input.testStrategy);
  if (tddMode === undefined || testStrategy === undefined) {
    throw toolError("TDD mode or test strategy is invalid");
  }

  let planningRunId: ReturnType<typeof createRunId> | undefined;
  if (input.planningRunId !== undefined) {
    if (!isValidRunId(input.planningRunId)) {
      throw toolError("planningRunId is invalid");
    }
    planningRunId = createRunId(input.planningRunId);
  }

  const result = createPlanningHandoff({
    workflowId: input.workflowId,
    planContent,
    tddMode,
    testStrategy,
    testSeams: input.testSeams,
    constraints: input.constraints,
    nonGoals: input.nonGoals,
    ...(planningRunId === undefined ? {} : { planningRunId }),
  });
  if (!result.valid) throw toolError(result.errors.join("; "));
  return result.value;
}

export async function writePlanningHandoffArtifact(
  input: PlanHandoffToolInput,
  signal?: AbortSignal,
): Promise<PlanHandoffToolDetails> {
  const paths = await resolveArtifactPaths(
    input.planArtifactRef,
    input.planningHandoffRef,
    input.managedPlanOutput,
  );

  return withFileMutationQueue(paths.handoffPath, async () => {
    ensureNotAborted(signal);
    const planContent = await readFile(paths.planPath);
    ensureNotAborted(signal);
    const template = validatePlanArtifactTemplate(planContent);
    if (!template.valid) throw toolError(template.errors.join("; "));
    const handoff = createHandoff(input, planContent);
    const serialized = `${JSON.stringify(handoff, null, 2)}\n`;

    await writeFile(paths.handoffPath, serialized, {
      encoding: "utf8",
      flag: "wx",
    });

    const persisted: unknown = JSON.parse(
      await readFile(paths.handoffPath, { encoding: "utf8" }),
    );
    const verification = validatePlanningHandoffAgainstPlan(
      persisted,
      planContent,
      input.workflowId,
    );
    if (!verification.valid) {
      throw toolError(verification.errors.join("; "));
    }

    return {
      workflowId: input.workflowId,
      planArtifactRef: paths.references.planArtifactRef,
      planningHandoffRef: paths.references.planningHandoffRef,
      planHash: verification.value.planHash,
    };
  });
}

function createPlanningHandoffTool(): ToolDefinition<
  typeof PLAN_HANDOFF_TOOL_PARAMETERS,
  PlanHandoffToolDetails
> {
  return {
    name: PLAN_HANDOFF_TOOL_NAME,
    label: "Write Planning Handoff",
    description:
      "Create the immutable planning-handoff.json beside the canonical implementation-plan.md after validating its hash and metadata.",
    parameters: PLAN_HANDOFF_TOOL_PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const details = await writePlanningHandoffArtifact(params, signal);
      return {
        content: [
          {
            type: "text",
            text: `Created ${details.planningHandoffRef.path} for ${details.workflowId}.`,
          },
        ],
        details,
      };
    },
  };
}

export function registerPlanningHandoffChildTool(
  pi: Pick<ExtensionAPI, "registerTool">,
): void {
  pi.registerTool(createPlanningHandoffTool());
}

export default function planningHandoffChildExtension(
  pi: Pick<ExtensionAPI, "registerTool">,
): void {
  if (process.env.PI_SUBAGENT_CHILD !== "1") return;
  registerPlanningHandoffChildTool(pi);
}
