import {
  CONDITIONAL_PLANNING_CAPABILITIES,
  getWorkflowPolicy,
  PLANNING_CAPABILITIES,
  REQUIRED_PLANNING_CAPABILITIES,
  type PlanningCapability,
  type PlanningSelectionRecord,
  type WorkflowPolicy,
} from "./policy.ts";
import {
  TIMEOUTS,
  isValidArtifactRef,
  isValidRunId,
  isValidWorkflowId,
  isWorkflowType,
  type ArtifactRef,
  type RunId,
  type WorkflowId,
  type WorkflowType,
} from "./workflow.ts";
import {
  hasOnlyKeys,
  invalidResult,
  isBoundedString,
  isRecord,
  validResult,
  type ValidationResult,
} from "./validation.ts";

export const PLANNING_COORDINATOR_CONTRACT_VERSION = 1 as const;
export const PLANNING_COORDINATOR_RESULT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    contractVersion: { type: "integer", const: 1 },
    workflowId: { type: "string", minLength: 1, maxLength: 128 },
    status: { type: "string", enum: ["COMPLETED", "FAILED", "CANCELLED"] },
    planArtifactRef: { $ref: "#/$defs/artifactRef" },
    planningHandoffRef: { $ref: "#/$defs/artifactRef" },
    selectedCapabilities: {
      type: "array",
      maxItems: 7,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          capability: { type: "string", enum: [...PLANNING_CAPABILITIES] },
          reason: { type: "string", minLength: 1, maxLength: 4096 },
        },
        required: ["capability", "reason"],
      },
    },
    skippedCapabilities: {
      type: "array",
      maxItems: 7,
      items: { $ref: "#/$defs/selectionRecord" },
    },
    remainingBlockers: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          code: { type: "string", minLength: 1, maxLength: 4096 },
          reason: { type: "string", minLength: 1, maxLength: 4096 },
          evidenceRefs: {
            type: "array",
            maxItems: 32,
            items: { $ref: "#/$defs/artifactRef" },
          },
        },
        required: ["code", "reason"],
      },
    },
  },
  required: [
    "contractVersion",
    "workflowId",
    "status",
    "selectedCapabilities",
    "skippedCapabilities",
    "remainingBlockers",
  ],
  $defs: {
    artifactRef: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { const: "managed" },
        path: { type: "string", minLength: 1, maxLength: 4096 },
        mediaType: {
          type: "string",
          enum: [
            "text/markdown",
            "application/json",
            "text/plain",
            "text/x-diff",
          ],
        },
      },
      required: ["kind", "path", "mediaType"],
    },
    selectionRecord: {
      type: "object",
      additionalProperties: false,
      properties: {
        capability: { type: "string", enum: [...PLANNING_CAPABILITIES] },
        reason: { type: "string", minLength: 1, maxLength: 4096 },
        evidenceRefs: {
          type: "array",
          maxItems: 32,
          items: { $ref: "#/$defs/artifactRef" },
        },
      },
      required: ["capability", "reason"],
    },
  },
});

export interface PlanningCoordinatorInput {
  contractVersion: typeof PLANNING_COORDINATOR_CONTRACT_VERSION;
  workflow: {
    workflowId: WorkflowId;
    workflowType: WorkflowType;
    request: string;
    cwd: string;
  };
  policy: WorkflowPolicy;
  artifact: {
    planFileName: "implementation-plan.md";
    handoffFileName: "planning-handoff.json";
    outputMode: "file-only";
  };
  runtime: {
    coordinatorRunId?: RunId;
    maxChildCount: number;
    timeoutMs: number;
  };
}

export interface PlanningCoordinatorResult {
  contractVersion: typeof PLANNING_COORDINATOR_CONTRACT_VERSION;
  workflowId: WorkflowId;
  status: "COMPLETED" | "FAILED" | "CANCELLED";
  planArtifactRef?: ArtifactRef;
  planningHandoffRef?: ArtifactRef;
  selectedCapabilities: Array<{
    capability: PlanningCapability;
    reason: string;
  }>;
  skippedCapabilities: PlanningSelectionRecord[];
  remainingBlockers: Array<{
    code: string;
    reason: string;
    evidenceRefs?: ArtifactRef[];
  }>;
}

const MAX_SELECTIONS = PLANNING_CAPABILITIES.length;
const MAX_BLOCKERS = 32;
const MAX_REASON_BYTES = 4096;
const MAX_CHILD_COUNT = 32;
const PLAN_FILE_NAME = "implementation-plan.md";
const HANDOFF_FILE_NAME = "planning-handoff.json";

function isPlanningCapability(value: unknown): value is PlanningCapability {
  return (
    typeof value === "string" &&
    (PLANNING_CAPABILITIES as readonly string[]).includes(value)
  );
}

function copyArtifactRef(value: ArtifactRef): ArtifactRef {
  return { kind: value.kind, path: value.path, mediaType: value.mediaType };
}

function validateArtifactRef(
  value: unknown,
  expectedMediaType?: ArtifactRef["mediaType"],
): ValidationResult<ArtifactRef> {
  if (!isValidArtifactRef(value)) {
    return invalidResult("Planning artifact reference is invalid");
  }
  if (
    expectedMediaType !== undefined &&
    value.mediaType !== expectedMediaType
  ) {
    return invalidResult(
      "Planning artifact reference has an invalid media type",
    );
  }
  return validResult(copyArtifactRef(value));
}

function artifactFileName(path: string): string {
  const segments = path.split(/[\\/]/u);
  return segments[segments.length - 1] ?? "";
}

function validateReferenceFileName(
  value: unknown,
  fileName: string,
  mediaType: ArtifactRef["mediaType"],
): ValidationResult<ArtifactRef> {
  const reference = validateArtifactRef(value, mediaType);
  if (!reference.valid) return reference;
  return artifactFileName(reference.value.path) === fileName
    ? reference
    : invalidResult(`Artifact reference must point to ${fileName}`);
}

function validateArtifactRefs(
  value: unknown,
  fieldName: string,
): ValidationResult<ArtifactRef[]> {
  if (!Array.isArray(value) || value.length > 32) {
    return invalidResult(`${fieldName} must contain at most 32 references`);
  }
  const refs: ArtifactRef[] = [];
  for (const item of value) {
    const reference = validateArtifactRef(item);
    if (!reference.valid) {
      return invalidResult(`${fieldName} contains an invalid reference`);
    }
    refs.push(reference.value);
  }
  return validResult(refs);
}

function validatePolicy(value: unknown): ValidationResult<WorkflowPolicy> {
  const expected = getWorkflowPolicy();
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["source", "commonPlanning", "typePolicies"])
  ) {
    return invalidResult("Planning policy has unknown or missing fields");
  }
  if (value.source !== expected.source || !isRecord(value.commonPlanning)) {
    return invalidResult("Planning policy is not package-built-in");
  }

  const common = value.commonPlanning;
  if (
    !hasOnlyKeys(common, PLANNING_CAPABILITIES) ||
    PLANNING_CAPABILITIES.some(
      (capability) =>
        common[capability] !== expected.commonPlanning[capability],
    )
  ) {
    return invalidResult("Planning policy common requirements are invalid");
  }

  if (
    !isRecord(value.typePolicies) ||
    !hasOnlyKeys(value.typePolicies, ["feature", "bug", "chore", "hotfix"])
  ) {
    return invalidResult("Planning policy type policies are invalid");
  }
  for (const workflowType of ["feature", "bug", "chore", "hotfix"] as const) {
    const policy = value.typePolicies[workflowType];
    const expectedPolicy = expected.typePolicies[workflowType];
    if (
      !isRecord(policy) ||
      !hasOnlyKeys(policy, ["workflowType", "scoutFocus"]) ||
      policy.workflowType !== workflowType ||
      !Array.isArray(policy.scoutFocus) ||
      policy.scoutFocus.length !== expectedPolicy.scoutFocus.length ||
      policy.scoutFocus.some(
        (focus, index) =>
          focus !== expectedPolicy.scoutFocus[index] ||
          !isBoundedString(focus, MAX_REASON_BYTES, true),
      )
    ) {
      return invalidResult("Planning policy type policies are invalid");
    }
  }
  return validResult(expected);
}

function isPlanningRuntime(
  value: unknown,
): value is PlanningCoordinatorInput["runtime"] {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["coordinatorRunId", "maxChildCount", "timeoutMs"]) ||
    typeof value.maxChildCount !== "number" ||
    !Number.isInteger(value.maxChildCount) ||
    value.maxChildCount < 0 ||
    value.maxChildCount > MAX_CHILD_COUNT ||
    value.timeoutMs !== TIMEOUTS.coordinatorTimeoutMs
  ) {
    return false;
  }
  return !(
    "coordinatorRunId" in value && !isValidRunId(value.coordinatorRunId)
  );
}

function validateWorkflowInput(
  value: unknown,
): ValidationResult<PlanningCoordinatorInput["workflow"]> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["workflowId", "workflowType", "request", "cwd"])
  ) {
    return invalidResult(
      "Planning workflow input has unknown or missing fields",
    );
  }
  if (
    !isValidWorkflowId(value.workflowId) ||
    !isWorkflowType(value.workflowType) ||
    !isBoundedString(value.request, 64 * 1024, true) ||
    !isBoundedString(value.cwd, 4096, true) ||
    /[\0\r\n]/u.test(value.cwd)
  ) {
    return invalidResult("Planning workflow input is invalid");
  }
  return validResult({
    workflowId: value.workflowId,
    workflowType: value.workflowType,
    request: value.request,
    cwd: value.cwd,
  });
}

export function validatePlanningCoordinatorInput(
  value: unknown,
): ValidationResult<PlanningCoordinatorInput> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "contractVersion",
      "workflow",
      "policy",
      "artifact",
      "runtime",
    ])
  ) {
    return invalidResult(
      "Planning Coordinator input has unknown or missing fields",
    );
  }
  const workflow = validateWorkflowInput(value.workflow);
  const policy = validatePolicy(value.policy);
  const artifact = value.artifact;
  const runtime = value.runtime;
  if (
    value.contractVersion !== PLANNING_COORDINATOR_CONTRACT_VERSION ||
    !workflow.valid ||
    !policy.valid ||
    !isRecord(artifact) ||
    !hasOnlyKeys(artifact, ["planFileName", "handoffFileName", "outputMode"]) ||
    artifact.planFileName !== PLAN_FILE_NAME ||
    artifact.handoffFileName !== HANDOFF_FILE_NAME ||
    artifact.outputMode !== "file-only" ||
    !isPlanningRuntime(runtime)
  ) {
    return invalidResult(
      "Planning Coordinator input is invalid",
      ...(!workflow.valid ? workflow.errors : []),
      ...(!policy.valid ? policy.errors : []),
    );
  }

  const runtimeValue = {
    maxChildCount: runtime.maxChildCount,
    timeoutMs: runtime.timeoutMs,
    ...(runtime.coordinatorRunId === undefined
      ? {}
      : { coordinatorRunId: runtime.coordinatorRunId }),
  };
  return validResult({
    contractVersion: PLANNING_COORDINATOR_CONTRACT_VERSION,
    workflow: workflow.value,
    policy: policy.value,
    artifact: {
      planFileName: PLAN_FILE_NAME,
      handoffFileName: HANDOFF_FILE_NAME,
      outputMode: "file-only",
    },
    runtime: runtimeValue,
  });
}

function validateSelection(
  value: unknown,
  fieldName: string,
  allowsEvidenceRefs: boolean,
): ValidationResult<PlanningSelectionRecord> {
  const allowedKeys = allowsEvidenceRefs
    ? ["capability", "reason", "evidenceRefs"]
    : ["capability", "reason"];
  if (!isRecord(value) || !hasOnlyKeys(value, allowedKeys)) {
    return invalidResult(`${fieldName} has unknown or missing fields`);
  }
  if (
    !isPlanningCapability(value.capability) ||
    !isBoundedString(value.reason, MAX_REASON_BYTES, true)
  ) {
    return invalidResult(`${fieldName} is invalid`);
  }
  const record: PlanningSelectionRecord = {
    capability: value.capability,
    reason: value.reason,
  };
  if (allowsEvidenceRefs && "evidenceRefs" in value) {
    const references = validateArtifactRefs(value.evidenceRefs, "evidenceRefs");
    if (!references.valid) return references;
    record.evidenceRefs = references.value;
  }
  return validResult(record);
}

function validateSelectedCapabilities(
  value: unknown,
): ValidationResult<PlanningCoordinatorResult["selectedCapabilities"]> {
  if (!Array.isArray(value) || value.length > MAX_SELECTIONS) {
    return invalidResult("selectedCapabilities must contain at most 7 items");
  }
  const selections: PlanningCoordinatorResult["selectedCapabilities"] = [];
  const seen = new Set<PlanningCapability>();
  for (const item of value) {
    const selection = validateSelection(item, "selected capability", false);
    if (!selection.valid) return selection;
    if (seen.has(selection.value.capability)) {
      return invalidResult(
        "selectedCapabilities contains a duplicate capability",
      );
    }
    seen.add(selection.value.capability);
    selections.push({
      capability: selection.value.capability,
      reason: selection.value.reason,
    });
  }
  return validResult(selections);
}

function validateSkippedCapabilities(
  value: unknown,
): ValidationResult<PlanningSelectionRecord[]> {
  if (!Array.isArray(value) || value.length > MAX_SELECTIONS) {
    return invalidResult("skippedCapabilities must contain at most 7 items");
  }
  const selections: PlanningSelectionRecord[] = [];
  const seen = new Set<PlanningCapability>();
  for (const item of value) {
    const selection = validateSelection(item, "skipped capability", true);
    if (!selection.valid) return selection;
    if (seen.has(selection.value.capability)) {
      return invalidResult(
        "skippedCapabilities contains a duplicate capability",
      );
    }
    seen.add(selection.value.capability);
    selections.push(selection.value);
  }
  return validResult(selections);
}

function validateBlockers(
  value: unknown,
): ValidationResult<PlanningCoordinatorResult["remainingBlockers"]> {
  if (!Array.isArray(value) || value.length > MAX_BLOCKERS) {
    return invalidResult("remainingBlockers must contain at most 32 items");
  }
  const blockers: PlanningCoordinatorResult["remainingBlockers"] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, ["code", "reason", "evidenceRefs"]) ||
      !isBoundedString(item.code, MAX_REASON_BYTES, true) ||
      !isBoundedString(item.reason, MAX_REASON_BYTES, true)
    ) {
      return invalidResult("remainingBlockers contains an invalid item");
    }
    const blocker: PlanningCoordinatorResult["remainingBlockers"][number] = {
      code: item.code,
      reason: item.reason,
    };
    if ("evidenceRefs" in item) {
      const references = validateArtifactRefs(
        item.evidenceRefs,
        "evidenceRefs",
      );
      if (!references.valid) return references;
      blocker.evidenceRefs = references.value;
    }
    blockers.push(blocker);
  }
  return validResult(blockers);
}

export function validatePlanningCoordinatorResult(
  value: unknown,
): ValidationResult<PlanningCoordinatorResult> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "contractVersion",
      "workflowId",
      "status",
      "planArtifactRef",
      "planningHandoffRef",
      "selectedCapabilities",
      "skippedCapabilities",
      "remainingBlockers",
    ])
  ) {
    return invalidResult(
      "Planning Coordinator result has unknown or missing fields",
    );
  }

  const selected = validateSelectedCapabilities(value.selectedCapabilities);
  const skipped = validateSkippedCapabilities(value.skippedCapabilities);
  const blockers = validateBlockers(value.remainingBlockers);
  if (
    value.contractVersion !== PLANNING_COORDINATOR_CONTRACT_VERSION ||
    !isValidWorkflowId(value.workflowId) ||
    (value.status !== "COMPLETED" &&
      value.status !== "FAILED" &&
      value.status !== "CANCELLED") ||
    !selected.valid ||
    !skipped.valid ||
    !blockers.valid
  ) {
    return invalidResult(
      "Planning Coordinator result is invalid",
      ...(!selected.valid ? selected.errors : []),
      ...(!skipped.valid ? skipped.errors : []),
      ...(!blockers.valid ? blockers.errors : []),
    );
  }

  const selectedCapabilities = new Set(
    selected.value.map(({ capability }) => capability),
  );
  const skippedCapabilities = new Set(
    skipped.value.map(({ capability }) => capability),
  );
  for (const record of skipped.value) {
    if (selectedCapabilities.has(record.capability)) {
      return invalidResult(
        `Planning capability is both selected and skipped: ${record.capability}`,
      );
    }
    if (
      REQUIRED_PLANNING_CAPABILITIES.some(
        (capability) => capability === record.capability,
      )
    ) {
      return invalidResult(
        `Required Planning capability cannot be skipped: ${record.capability}`,
      );
    }
  }

  const planArtifactRef =
    "planArtifactRef" in value
      ? validateReferenceFileName(
          value.planArtifactRef,
          PLAN_FILE_NAME,
          "text/markdown",
        )
      : undefined;
  const planningHandoffRef =
    "planningHandoffRef" in value
      ? validateReferenceFileName(
          value.planningHandoffRef,
          HANDOFF_FILE_NAME,
          "application/json",
        )
      : undefined;
  if (
    (planArtifactRef !== undefined && !planArtifactRef.valid) ||
    (planningHandoffRef !== undefined && !planningHandoffRef.valid)
  ) {
    return invalidResult("Planning Coordinator artifact reference is invalid");
  }

  if (value.status === "COMPLETED") {
    if (
      planArtifactRef === undefined ||
      !planArtifactRef.valid ||
      planningHandoffRef === undefined ||
      !planningHandoffRef.valid
    ) {
      return invalidResult(
        "Completed Planning requires Plan Artifact and Handoff references",
      );
    }
    if (blockers.value.length > 0) {
      return invalidResult(
        "Completed Planning cannot contain remaining blockers",
      );
    }
    if (
      !REQUIRED_PLANNING_CAPABILITIES.every((capability) =>
        selectedCapabilities.has(capability),
      )
    ) {
      return invalidResult(
        "Completed Planning requires Scout and Plan Composition selections",
      );
    }
    if (
      selectedCapabilities.size + skippedCapabilities.size !==
      PLANNING_CAPABILITIES.length
    ) {
      return invalidResult(
        "Completed Planning must select or explicitly skip every Planning capability",
      );
    }
    if (
      !CONDITIONAL_PLANNING_CAPABILITIES.every(
        (capability) =>
          selectedCapabilities.has(capability) ||
          skippedCapabilities.has(capability),
      )
    ) {
      return invalidResult(
        "Completed Planning must record every conditional capability decision",
      );
    }
  }

  const result: PlanningCoordinatorResult = {
    contractVersion: PLANNING_COORDINATOR_CONTRACT_VERSION,
    workflowId: value.workflowId,
    status: value.status,
    selectedCapabilities: selected.value,
    skippedCapabilities: skipped.value,
    remainingBlockers: blockers.value,
  };
  if (planArtifactRef?.valid) result.planArtifactRef = planArtifactRef.value;
  if (planningHandoffRef?.valid) {
    result.planningHandoffRef = planningHandoffRef.value;
  }
  return validResult(result);
}

export function isPlanningCoordinatorResult(
  value: unknown,
): value is PlanningCoordinatorResult {
  return validatePlanningCoordinatorResult(value).valid;
}
