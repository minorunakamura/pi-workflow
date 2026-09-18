import {
  withFileMutationQueue,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Type, type Static } from "typebox";

import {
  createPlanningHandoff,
  createRunId,
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

const TEST_STRATEGY_SCHEMA = Type.Object({
  kind: Type.String(),
  required: Type.Boolean(),
  summary: Type.String(),
});

export const PLAN_HANDOFF_TOOL_PARAMETERS = Type.Object({
  workflowId: Type.String(),
  planArtifactRef: ARTIFACT_REF_SCHEMA,
  planningHandoffRef: ARTIFACT_REF_SCHEMA,
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

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

async function realPathInside(root: string, target: string): Promise<void> {
  const targetPath = await realpath(target);
  if (!isWithin(root, targetPath)) {
    throw toolError("artifact path escapes the managed artifact directory");
  }
}

async function parentPathInside(root: string, target: string): Promise<void> {
  await realPathInside(root, dirname(target));
}

async function resolveArtifactPaths(
  cwd: string,
  planArtifact: unknown,
  planningHandoff: unknown,
): Promise<ResolvedArtifactPaths> {
  const references = validatePlanningArtifactReferences(
    planArtifact,
    planningHandoff,
  );
  if (!references.valid) {
    throw toolError(references.errors.join("; "));
  }

  const root = await realpath(cwd);
  const planPath = resolve(root, references.value.planArtifactRef.path);
  const handoffPath = resolve(root, references.value.planningHandoffRef.path);
  if (!isWithin(root, planPath) || !isWithin(root, handoffPath)) {
    throw toolError("artifact path escapes the managed artifact directory");
  }

  await realPathInside(root, planPath);
  await parentPathInside(root, handoffPath);
  const planDirectory = await realpath(dirname(planPath));
  const handoffDirectory = await realpath(dirname(handoffPath));
  if (planDirectory !== handoffDirectory) {
    throw toolError(
      "Plan Artifact and Planning Handoff must share a directory",
    );
  }

  return {
    planPath,
    handoffPath,
    references: references.value,
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
  cwd: string,
  signal?: AbortSignal,
): Promise<PlanHandoffToolDetails> {
  const paths = await resolveArtifactPaths(
    cwd,
    input.planArtifactRef,
    input.planningHandoffRef,
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

    const persisted = JSON.parse(
      await readFile(paths.handoffPath, { encoding: "utf8" }),
    ) as unknown;
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
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const details = await writePlanningHandoffArtifact(
        params,
        ctx.cwd,
        signal,
      );
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
