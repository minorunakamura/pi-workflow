import { readFile as readFileFromDisk } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import {
  evaluateReadyForMerge,
  hashPlan,
  isValidFindingId,
  parseTrustedGateExpectations,
  isValidWorkflowId,
  validateApprovalIdentity,
  validateFindingDisposition,
  validateFixWave,
  validateFocusedReviewResult,
  validatePlanArtifactTemplate,
  validatePlanningArtifactReferences,
  validatePlanningHandoff,
  validatePlanningHandoffAgainstPlan,
  validateTrustedGate,
  type ArtifactRef,
  type CodeReviewReadiness,
  type FindingReadiness,
  type FixWave,
  type FocusedReviewResult,
  type PlanHash,
  type ReadyForMergeResult,
  type TrustedGate,
} from "../core/index.ts";
import { hasOnlyKeys, isBoundedString, isRecord } from "../core/validation.ts";

export const READINESS_EVALUATOR_TOOL_NAME =
  "pi_workflow_evaluate_readiness" as const;

const ARTIFACT_REF_SCHEMA = Type.Object({
  kind: Type.String(),
  path: Type.String(),
  mediaType: Type.String(),
});

const APPROVAL_SCHEMA = Type.Object({
  approvedPlanHash: Type.String(),
  reviewId: Type.String(),
  approval: Type.Boolean(),
  approvalFeedback: Type.Optional(Type.String()),
});

export const READINESS_EVALUATOR_TOOL_PARAMETERS = Type.Object({
  workflowId: Type.String(),
  planArtifactRef: ARTIFACT_REF_SCHEMA,
  planningHandoffRef: ARTIFACT_REF_SCHEMA,
  approval: APPROVAL_SCHEMA,
  implementationComplete: Type.Boolean(),
  gates: Type.Array(Type.Any()),
  repositoryGates: Type.Optional(Type.Array(Type.Any())),
  findings: Type.Array(Type.Any()),
  fixWave: Type.Optional(Type.Any()),
  focusedReReview: Type.Optional(Type.Any()),
  finalDiffInspection: Type.String(),
  codeReview: Type.Optional(Type.Any()),
});

export type ReadinessEvaluatorToolInput = Static<
  typeof READINESS_EVALUATOR_TOOL_PARAMETERS
>;

export type ReadinessArtifactReader = (
  path: string,
  signal?: AbortSignal,
) => Promise<Uint8Array>;

const MAX_GATES = 64;
const MAX_FINDINGS = 128;
const INPUT_KEYS = [
  "workflowId",
  "planArtifactRef",
  "planningHandoffRef",
  "approval",
  "implementationComplete",
  "gates",
  "repositoryGates",
  "findings",
  "fixWave",
  "focusedReReview",
  "finalDiffInspection",
  "codeReview",
] as const;

function toolError(message: string): Error {
  return new Error(`Cannot evaluate Ready-for-Merge: ${message}`);
}

function ensureCwd(cwd: string): void {
  if (!isBoundedString(cwd, 4096, true) || /[\0\r\n]/u.test(cwd)) {
    throw toolError("cwd is invalid");
  }
}

function artifactPath(cwd: string, reference: ArtifactRef): string {
  return isAbsolute(reference.path)
    ? reference.path
    : resolve(cwd, reference.path);
}

function decodeUtf8(value: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw toolError(`${label} is not valid UTF-8`);
  }
}

async function readAuthoritativePlanIdentity(
  input: Record<string, unknown>,
  cwd: string,
  readFile: ReadinessArtifactReader,
  signal: AbortSignal | undefined,
): Promise<{
  handoff: unknown;
  currentPlanHash: unknown;
  approval: unknown;
  planContent: string;
}> {
  const references = validatePlanningArtifactReferences(
    input.planArtifactRef,
    input.planningHandoffRef,
  );
  if (!references.valid) throw toolError(references.errors.join("; "));

  const planBytes = await readFile(
    artifactPath(cwd, references.value.planArtifactRef),
    signal,
  );
  const template = validatePlanArtifactTemplate(planBytes);
  const planContent = decodeUtf8(planBytes, "Plan Artifact");

  const handoffText = decodeUtf8(
    await readFile(
      artifactPath(cwd, references.value.planningHandoffRef),
      signal,
    ),
    "Planning Handoff",
  );
  let handoffValue: unknown;
  try {
    handoffValue = JSON.parse(handoffText);
  } catch {
    handoffValue = undefined;
  }

  const handoffSchema = validatePlanningHandoff(handoffValue);
  const handoffMatchesPlan = validatePlanningHandoffAgainstPlan(
    handoffValue,
    planBytes,
    input.workflowId,
  );
  const handoffForEvaluator =
    template.valid &&
    handoffSchema.valid &&
    handoffSchema.value.workflowId === input.workflowId
      ? handoffSchema.value
      : undefined;

  let planHash: PlanHash | undefined;
  try {
    planHash = hashPlan(planBytes);
  } catch {
    planHash = undefined;
  }
  const approval =
    planHash !== undefined && handoffForEvaluator !== undefined
      ? validateApprovalIdentity(
          input.approval,
          planHash.value,
          handoffForEvaluator,
        )
      : undefined;

  return {
    handoff:
      handoffMatchesPlan.valid || handoffForEvaluator !== undefined
        ? handoffForEvaluator
        : undefined,
    currentPlanHash: planHash?.value,
    approval: approval?.valid ? approval.value : input.approval,
    planContent,
  };
}

function parseGates(value: unknown, fieldName: string): TrustedGate[] {
  if (!Array.isArray(value) || value.length > MAX_GATES) {
    throw toolError(`${fieldName} is not a bounded array`);
  }
  const gates: TrustedGate[] = [];
  for (const item of value) {
    const gate = validateTrustedGate(item);
    if (!gate.valid) throw toolError(`${fieldName}: ${gate.errors.join("; ")}`);
    gates.push(gate.value);
  }
  return gates;
}

function parseFindings(value: unknown): FindingReadiness[] {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
    throw toolError("findings is not a bounded array");
  }
  const findings: FindingReadiness[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, ["findingId", "disposition", "resolved", "reason"]) ||
      !isValidFindingId(item.findingId) ||
      typeof item.resolved !== "boolean" ||
      seen.has(item.findingId)
    ) {
      throw toolError("findings contains an invalid or duplicate record");
    }
    const disposition = validateFindingDisposition({
      findingId: item.findingId,
      disposition: item.disposition,
      reason: item.reason,
    });
    if (!disposition.valid) {
      throw toolError(`findings: ${disposition.errors.join("; ")}`);
    }
    seen.add(item.findingId);
    findings.push({
      findingId: disposition.value.findingId,
      disposition: disposition.value.disposition,
      resolved: item.resolved,
      reason: disposition.value.reason,
    });
  }
  return findings;
}

function parseFixWave(value: unknown): FixWave | null {
  if (value === undefined || value === null) return null;
  const result = validateFixWave(value);
  if (!result.valid) throw toolError(result.errors.join("; "));
  return result.value;
}

function parseFocusedReview(value: unknown): FocusedReviewResult | null {
  if (value === undefined || value === null) return null;
  const result = validateFocusedReviewResult(value);
  if (!result.valid) throw toolError(result.errors.join("; "));
  return result.value;
}

function isCodeReviewStatus(
  value: unknown,
): value is CodeReviewReadiness["status"] {
  return (
    value === "approved" ||
    value === "rejected" ||
    value === "unavailable" ||
    value === "timeout" ||
    value === "failed"
  );
}

function parseCodeReview(value: unknown): CodeReviewReadiness | null {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["status", "approved"]) ||
    !isCodeReviewStatus(value.status) ||
    typeof value.approved !== "boolean"
  ) {
    throw toolError("codeReview is invalid");
  }
  return {
    status: value.status,
    approved: value.approved,
  };
}

function parseFinalDiffInspection(
  value: unknown,
): "PASS" | "FAIL" | "MISSING" | "UNKNOWN" {
  if (
    value !== "PASS" &&
    value !== "FAIL" &&
    value !== "MISSING" &&
    value !== "UNKNOWN"
  ) {
    throw toolError("finalDiffInspection is invalid");
  }
  return value;
}

export async function evaluateReadinessFromAuthoritativeInput(
  value: unknown,
  cwd: string,
  readFile: ReadinessArtifactReader = (path, signal) =>
    readFileFromDisk(path, signal === undefined ? undefined : { signal }),
  signal?: AbortSignal,
): Promise<ReadyForMergeResult> {
  ensureCwd(cwd);
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, INPUT_KEYS) ||
    !isValidWorkflowId(value.workflowId) ||
    typeof value.implementationComplete !== "boolean"
  ) {
    throw toolError("input is invalid");
  }

  const identity = await readAuthoritativePlanIdentity(
    value,
    cwd,
    readFile,
    signal,
  );
  const approvedGates = parseTrustedGateExpectations(identity.planContent);
  if (!approvedGates.valid) {
    throw toolError(approvedGates.errors.join("; "));
  }
  const gates = parseGates(value.gates, "gates");
  const repositoryGates =
    value.repositoryGates === undefined
      ? undefined
      : parseGates(value.repositoryGates, "repositoryGates");
  const findings = parseFindings(value.findings);
  const fixWave = parseFixWave(value.fixWave);
  const focusedReReview = parseFocusedReview(value.focusedReReview);
  const finalDiffInspection = parseFinalDiffInspection(
    value.finalDiffInspection,
  );
  const codeReview = parseCodeReview(value.codeReview);

  return evaluateReadyForMerge({
    handoff: identity.handoff,
    currentPlanHash: identity.currentPlanHash,
    approval: identity.approval,
    implementationComplete: value.implementationComplete,
    gates,
    approvedGates: approvedGates.value,
    ...(repositoryGates === undefined ? {} : { repositoryGates }),
    findings,
    fixWave,
    focusedReReview,
    finalDiffInspection,
    codeReview,
  });
}

function createReadinessEvaluatorTool(): ToolDefinition<
  typeof READINESS_EVALUATOR_TOOL_PARAMETERS,
  ReadyForMergeResult
> {
  return {
    name: READINESS_EVALUATOR_TOOL_NAME,
    label: "Evaluate Ready-for-Merge",
    description:
      "Evaluate the bounded Ready-for-Merge conditions through the package core evaluator.",
    parameters: READINESS_EVALUATOR_TOOL_PARAMETERS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await evaluateReadinessFromAuthoritativeInput(
        params,
        ctx.cwd,
        undefined,
        signal,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}

export function registerReadinessEvaluatorChildTool(
  pi: Pick<ExtensionAPI, "registerTool">,
): void {
  pi.registerTool(createReadinessEvaluatorTool());
}

export default function readinessEvaluatorChildExtension(
  pi: Pick<ExtensionAPI, "registerTool">,
): void {
  if (process.env.PI_SUBAGENT_CHILD !== "1") return;
  registerReadinessEvaluatorChildTool(pi);
}
