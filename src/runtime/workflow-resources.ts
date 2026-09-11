import { readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  FOREGROUND_POLICY,
  WORKFLOW_RESOURCE_OUTPUT_POLICIES,
} from "../core/phases/definitions";
import {
  MAX_RESOURCE_ARGS_BYTES,
  ResourceArgsSchemas,
  type DiscoveryArgsV1,
  type PlanningArgsV1,
  type ResearchArgsV1,
  type ResourceArgsPhase,
  validateResourceArgs,
} from "../core/phases/args";
import { formatValidationIssues } from "../core/validation";
import {
  DiscoveryMetadataSchema,
  ResearchMetadataSchema,
  MAX_DISCOVERY_METADATA_BYTES,
  MAX_DISCOVERY_METADATA_ITEMS,
  MAX_PLAN_REVIEW_BINDING_BYTES,
  MAX_PLAN_REVIEW_ROUNDS,
  MAX_RESEARCH_METADATA_BYTES,
  MAX_RESEARCH_QUESTIONS,
  MAX_HUMAN_INPUT_ENTRIES,
  MAX_HUMAN_INPUT_VALUE_BYTES,
  MAX_IDENTIFIER_BYTES,
  MAX_MISSION_STATE_BYTES,
  MAX_REGULAR_TEXT_BYTES,
  MAX_REFERENCE_BYTES,
  MAX_REQUEST_BYTES,
  MISSION_STATE_KEYS,
  MissionStateSchema,
  PlanReviewBindingSchema,
} from "../core/state/contracts";
import { MAX_JSON_DEPTH } from "../core/validation";
import { PlanningDecisionSchema } from "../core/planning/planning-decision-schema";
import {
  MAX_PLANNING_COMMAND_BYTES,
  MAX_PLANNING_DECISION_BYTES,
  MAX_PLANNING_IDENTIFIER_BYTES,
  MAX_PLANNING_TEXT_BYTES,
} from "../core/planning/planning-decision";
import {
  registerWorkflowResource,
  type RegisterWorkflowResourceInput,
  type WorkflowResourceDefinition,
  type WorkflowResourceRegistration,
} from "pi-subagents/workflow-resources";

export const WORKFLOW_RESOURCE_NAMES = [
  "pi-workflow.discovery",
  "pi-workflow.research",
  "pi-workflow.planning",
] as const;

export type WorkflowResourceName = (typeof WORKFLOW_RESOURCE_NAMES)[number];
export type WorkflowResourceRegistrar = (
  input: RegisterWorkflowResourceInput,
) => WorkflowResourceRegistration;

const RESOURCE_VERSION = 1;
const DISCOVERY_RESOURCE_MARKER = "resource";
const DISCOVERY_RESOURCE_START = "/* pi-workflow: discovery-resource:start */";
const DISCOVERY_RESOURCE_END = "/* pi-workflow: discovery-resource:end */";
const RESEARCH_RESOURCE_START = "/* pi-workflow: research-resource:start */";
const RESEARCH_RESOURCE_END = "/* pi-workflow: research-resource:end */";
const PLANNING_RESOURCE_START = "/* pi-workflow: planning-resource:start */";
const PLANNING_RESOURCE_END = "/* pi-workflow: planning-resource:end */";
const PLANNING_DECISION_INPUT_DIR = join(realpathSync(tmpdir()), "pi-workflow");
const PLANNING_DECISION_INPUT_BASENAME = "planning-decision.json";
const PLAN_ARTIFACT_HOST_KEY = "plan-artifact";
const PLAN_RENDERER_PATH = fileURLToPath(
  new URL("./plan-artifact.js", import.meta.url),
);

function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

interface PlanningArtifactBinding {
  decisionInputPath: string;
  correctionDecisionInputPath: string;
  planArtifactPath: string;
  rendererCommand: string;
}

function createPlanningArtifactBinding(): PlanningArtifactBinding {
  const token = randomUUID();
  const decisionInputPath = join(
    PLANNING_DECISION_INPUT_DIR,
    `planning-decision-${token}-${PLANNING_DECISION_INPUT_BASENAME}`,
  );
  const correctionDecisionInputPath = join(
    PLANNING_DECISION_INPUT_DIR,
    `planning-decision-${token}-correction-${PLANNING_DECISION_INPUT_BASENAME}`,
  );
  const planArtifactPath = join(
    PLANNING_DECISION_INPUT_DIR,
    `plan-${token}.md`,
  );
  return {
    decisionInputPath,
    correctionDecisionInputPath,
    planArtifactPath,
    rendererCommand: [
      shellQuote("node"),
      shellQuote(PLAN_RENDERER_PATH),
      "--output",
      shellQuote(planArtifactPath),
      shellQuote(decisionInputPath),
      shellQuote(correctionDecisionInputPath),
    ].join(" "),
  };
}

function resourceWorkflowTemplate(
  path: string,
  startMarker: string,
  endMarker: string,
  label: string,
): string {
  const source = readFileSync(
    new URL(path, import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start < 0 || end < start) {
    throw new Error(`${label} resource script markers are invalid.`);
  }
  return source.slice(start + startMarker.length, end);
}

function discoveryWorkflowTemplate(): string {
  return resourceWorkflowTemplate(
    "../../workflow-scripts/discovery.js",
    DISCOVERY_RESOURCE_START,
    DISCOVERY_RESOURCE_END,
    "Discovery",
  );
}

function researchWorkflowTemplate(): string {
  return resourceWorkflowTemplate(
    "../../workflow-scripts/research.js",
    RESEARCH_RESOURCE_START,
    RESEARCH_RESOURCE_END,
    "Research",
  );
}

function planningWorkflowTemplate(): string {
  return resourceWorkflowTemplate(
    "../../workflow-scripts/planning.js",
    PLANNING_RESOURCE_START,
    PLANNING_RESOURCE_END,
    "Planning",
  );
}

export function buildDiscoveryWorkflowScript(args: DiscoveryArgsV1): string {
  const input = {
    [DISCOVERY_RESOURCE_MARKER]: "pi-workflow.discovery",
    ...args,
    discoveryMetadataSchema: DiscoveryMetadataSchema,
    missionStateSchema: MissionStateSchema,
    stateKeys: MISSION_STATE_KEYS,
    discoveryBounds: {
      stateBytes: MAX_MISSION_STATE_BYTES,
      referenceBytes: MAX_REFERENCE_BYTES,
      identifierBytes: MAX_IDENTIFIER_BYTES,
      requestBytes: MAX_REQUEST_BYTES,
      textBytes: MAX_REGULAR_TEXT_BYTES,
      humanInputs: MAX_HUMAN_INPUT_ENTRIES,
      humanValueBytes: MAX_HUMAN_INPUT_VALUE_BYTES,
      metadataBytes: MAX_DISCOVERY_METADATA_BYTES,
      metadataItems: MAX_DISCOVERY_METADATA_ITEMS,
      jsonDepth: MAX_JSON_DEPTH,
      resultBytes: MAX_RESOURCE_ARGS_BYTES,
    },
  };
  return `const input = ${JSON.stringify(input)};\n${discoveryWorkflowTemplate()}`;
}

export function buildResearchWorkflowScript(args: ResearchArgsV1): string {
  const input = {
    [DISCOVERY_RESOURCE_MARKER]: "pi-workflow.research",
    ...args,
    discoveryMetadataSchema: DiscoveryMetadataSchema,
    researchMetadataSchema: ResearchMetadataSchema,
    missionStateSchema: MissionStateSchema,
    stateKeys: MISSION_STATE_KEYS,
    researchBounds: {
      stateBytes: MAX_MISSION_STATE_BYTES,
      referenceBytes: MAX_REFERENCE_BYTES,
      identifierBytes: MAX_IDENTIFIER_BYTES,
      requestBytes: MAX_REQUEST_BYTES,
      textBytes: MAX_REGULAR_TEXT_BYTES,
      metadataBytes: MAX_RESEARCH_METADATA_BYTES,
      metadataItems: MAX_RESEARCH_QUESTIONS,
      jsonDepth: MAX_JSON_DEPTH,
      resultBytes: MAX_RESOURCE_ARGS_BYTES,
    },
  };
  return `const input = ${JSON.stringify(input)};\n${researchWorkflowTemplate()}`;
}

export function buildPlanningWorkflowScript(
  args: PlanningArgsV1,
  binding?: PlanningArtifactBinding,
): string {
  const artifactBinding =
    binding ??
    ((args.operation ?? "plan") === "plan"
      ? createPlanningArtifactBinding()
      : undefined);
  const input = {
    [DISCOVERY_RESOURCE_MARKER]: "pi-workflow.planning",
    ...args,
    planningDecisionSchema: PlanningDecisionSchema,
    planReviewBindingSchema: PlanReviewBindingSchema,
    missionStateSchema: MissionStateSchema,
    stateKeys: MISSION_STATE_KEYS,
    ...(artifactBinding === undefined
      ? {}
      : {
          planningDecisionInputPath: artifactBinding.decisionInputPath,
          correctionDecisionInputPath:
            artifactBinding.correctionDecisionInputPath,
          planArtifactPath: artifactBinding.planArtifactPath,
          planRendererCommand: artifactBinding.rendererCommand,
        }),
    planningBounds: {
      stateBytes: MAX_MISSION_STATE_BYTES,
      referenceBytes: MAX_REFERENCE_BYTES,
      identifierBytes: MAX_PLANNING_IDENTIFIER_BYTES,
      requestBytes: MAX_REQUEST_BYTES,
      textBytes: MAX_PLANNING_TEXT_BYTES,
      commandBytes: MAX_PLANNING_COMMAND_BYTES,
      humanInputs: MAX_HUMAN_INPUT_ENTRIES,
      humanValueBytes: MAX_HUMAN_INPUT_VALUE_BYTES,
      decisionBytes: MAX_PLANNING_DECISION_BYTES,
      planReviewBindingBytes: MAX_PLAN_REVIEW_BINDING_BYTES,
      planReviewRounds: MAX_PLAN_REVIEW_ROUNDS,
      metadataBytes: MAX_DISCOVERY_METADATA_BYTES,
      metadataItems: MAX_DISCOVERY_METADATA_ITEMS,
      jsonDepth: MAX_JSON_DEPTH,
      resultBytes: MAX_RESOURCE_ARGS_BYTES,
    },
  };
  return `const input = ${JSON.stringify(input)};\n${planningWorkflowTemplate()}`;
}

export const WORKFLOW_RESOURCE_CONTRACTS = {
  "pi-workflow.discovery": {
    argsPhase: "discovery",
    argsSchema: ResourceArgsSchemas.discovery,
    outputPolicy: WORKFLOW_RESOURCE_OUTPUT_POLICIES.discovery,
    foreground: FOREGROUND_POLICY,
  },
  "pi-workflow.research": {
    argsPhase: "research",
    argsSchema: ResourceArgsSchemas.research,
    outputPolicy: WORKFLOW_RESOURCE_OUTPUT_POLICIES.research,
    foreground: FOREGROUND_POLICY,
  },
  "pi-workflow.planning": {
    argsPhase: "planning",
    argsSchema: ResourceArgsSchemas.planning,
    outputPolicy: WORKFLOW_RESOURCE_OUTPUT_POLICIES.planning,
    foreground: FOREGROUND_POLICY,
  },
} as const satisfies Record<
  WorkflowResourceName,
  {
    argsPhase: ResourceArgsPhase;
    argsSchema: TSchema;
    outputPolicy: unknown;
    foreground: typeof FOREGROUND_POLICY;
  }
>;

function resolveDiscovery(
  args: Readonly<Record<string, unknown>>,
): ReturnType<WorkflowResourceDefinition["resolve"]> {
  const validation = validateResourceArgs("discovery", args);
  if (!validation.ok) {
    return {
      error: `Invalid args for 'pi-workflow.discovery': ${formatValidationIssues(validation.errors)}`,
    };
  }
  return {
    script: buildDiscoveryWorkflowScript(validation.value as DiscoveryArgsV1),
  };
}

function resolveResearch(
  args: Readonly<Record<string, unknown>>,
): ReturnType<WorkflowResourceDefinition["resolve"]> {
  const validation = validateResourceArgs("research", args);
  if (!validation.ok) {
    return {
      error: `Invalid args for 'pi-workflow.research': ${formatValidationIssues(validation.errors)}`,
    };
  }
  return {
    script: buildResearchWorkflowScript(validation.value as ResearchArgsV1),
  };
}

function resolvePlanning(
  args: Readonly<Record<string, unknown>>,
): ReturnType<WorkflowResourceDefinition["resolve"]> {
  const validation = validateResourceArgs("planning", args);
  if (!validation.ok) {
    return {
      error: `Invalid args for 'pi-workflow.planning': ${formatValidationIssues(validation.errors)}`,
    };
  }
  const argsValue = validation.value as PlanningArgsV1;
  const operation = argsValue.operation ?? "plan";
  const binding =
    operation === "plan" ? createPlanningArtifactBinding() : undefined;
  return {
    script: buildPlanningWorkflowScript(argsValue, binding),
    ...(binding === undefined
      ? {}
      : {
          hostCommands: [
            { key: PLAN_ARTIFACT_HOST_KEY, command: binding.rendererCommand },
          ],
        }),
  };
}

export const WORKFLOW_RESOURCE_DEFINITIONS: readonly WorkflowResourceDefinition[] =
  [
    {
      name: "pi-workflow.discovery",
      version: RESOURCE_VERSION,
      resolve: resolveDiscovery,
    },
    {
      name: "pi-workflow.research",
      version: RESOURCE_VERSION,
      resolve: resolveResearch,
    },
    {
      name: "pi-workflow.planning",
      version: RESOURCE_VERSION,
      resolve: resolvePlanning,
    },
  ];

function disposeAll(
  registrations: readonly WorkflowResourceRegistration[],
): unknown[] {
  const errors: unknown[] = [];
  for (const registration of registrations.toReversed()) {
    try {
      registration.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export interface WorkflowResourceLifecycle {
  register(sessionId: string): void;
  dispose(sessionId: string): void;
}

export function createWorkflowResourceLifecycle(
  registrar: WorkflowResourceRegistrar = registerWorkflowResource,
): WorkflowResourceLifecycle {
  const activeBySession = new Map<
    string,
    readonly WorkflowResourceRegistration[]
  >();

  return {
    register(sessionId) {
      if (activeBySession.has(sessionId)) {
        throw new Error(
          `Session '${sessionId}' already has active workflow resources.`,
        );
      }

      const registrations: WorkflowResourceRegistration[] = [];
      try {
        for (const definition of WORKFLOW_RESOURCE_DEFINITIONS) {
          registrations.push(registrar({ sessionId, definition }));
        }
      } catch (error) {
        const rollbackErrors = disposeAll(registrations);
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            "Failed to register pi-workflow resources.",
            { cause: error },
          );
        }
        throw error;
      }

      activeBySession.set(sessionId, registrations);
    },

    dispose(sessionId) {
      const registrations = activeBySession.get(sessionId);
      if (!registrations) return;
      activeBySession.delete(sessionId);

      const cleanupErrors = disposeAll(registrations);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          `Failed to dispose pi-workflow resources for session '${sessionId}'.`,
        );
      }
    },
  };
}

export function registerWorkflowResourceLifecycle(
  pi: Pick<ExtensionAPI, "on">,
  registrar?: WorkflowResourceRegistrar,
): void {
  const lifecycle = createWorkflowResourceLifecycle(registrar);

  pi.on("session_start", (_event, ctx) => {
    lifecycle.register(ctx.sessionManager.getSessionId());
  });
  pi.on("session_shutdown", (_event, ctx) => {
    lifecycle.dispose(ctx.sessionManager.getSessionId());
  });
}
