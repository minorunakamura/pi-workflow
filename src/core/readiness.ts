import { validateApprovalIdentity, validatePlanningHandoff } from "./plan.ts";
import {
  evaluateFocusedReview,
  isValidFindingId,
  validateFindingDisposition,
  type FixWave,
  type FocusedReviewResult,
  type FindingReadiness,
} from "./findings.ts";
import {
  evaluateTrustedGates,
  validateRequiredGateResolution,
  validateRequiredGatesPreserved,
  type TrustedGate,
} from "./gates.ts";
import { hasOnlyKeys, isRecord, type ValidationResult } from "./validation.ts";
import type { ArtifactRef } from "./workflow.ts";

export type ReadinessCheckStatus = "PASS" | "FAIL" | "MISSING" | "UNKNOWN";

export type ReadinessCheckId =
  | "approved-plan-identity"
  | "implementation-complete"
  | "required-gates"
  | "accepted-findings"
  | "focused-re-review"
  | "final-diff-inspection"
  | "code-review";

export interface ReadinessCheck {
  id: ReadinessCheckId;
  status: ReadinessCheckStatus;
  reason: string;
  evidenceRefs?: readonly ArtifactRef[];
}

export interface ReadyForMergeResult {
  ready: boolean;
  status: "READY_FOR_MERGE" | "BLOCKED";
  checks: ReadinessCheck[];
  blockers: Array<{
    code: string;
    reason: string;
    evidenceRefs?: readonly ArtifactRef[];
  }>;
}

export interface CodeReviewReadiness {
  status: "approved" | "rejected" | "unavailable" | "timeout" | "failed";
  approved: boolean;
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

export type DiffInspectionStatus = "PASS" | "FAIL" | "MISSING" | "UNKNOWN";

export interface ReadyForMergeInput {
  handoff: unknown;
  currentPlanHash: unknown;
  approval: unknown;
  implementationComplete: boolean;
  gates: readonly TrustedGate[];
  approvedGates: readonly TrustedGate[];
  repositoryGates?: readonly TrustedGate[];
  requiredGateKeys?: readonly string[];
  findings: readonly FindingReadiness[];
  fixWave?: FixWave | null;
  focusedReReview?: FocusedReviewResult | null;
  finalDiffInspection: DiffInspectionStatus;
  codeReview?: CodeReviewReadiness | null;
}

function check(
  id: ReadinessCheckId,
  status: ReadinessCheckStatus,
  reason: string,
): ReadinessCheck {
  return { id, status, reason };
}

function gateCheckStatus(
  evaluation: ReturnType<typeof evaluateTrustedGates>,
): ReadinessCheckStatus {
  if (evaluation.passed) {
    return "PASS";
  }
  if (
    evaluation.blockers.some(({ code }) => code === "MISSING_REQUIRED_GATE")
  ) {
    return "MISSING";
  }
  if (evaluation.blockers.some(({ code }) => code === "INVALID_GATE")) {
    return "UNKNOWN";
  }
  return "FAIL";
}

function evaluateFindings(
  findings: readonly FindingReadiness[],
): ValidationResult<true> {
  if (!Array.isArray(findings)) {
    return { valid: false, errors: ["Finding input must be an array"] };
  }
  const seen = new Set<string>();
  for (const finding of findings) {
    if (
      !isRecord(finding) ||
      !hasOnlyKeys(finding, [
        "findingId",
        "disposition",
        "resolved",
        "reason",
      ]) ||
      !isValidFindingId(finding.findingId) ||
      typeof finding.resolved !== "boolean" ||
      seen.has(finding.findingId)
    ) {
      return { valid: false, errors: ["Finding readiness record is invalid"] };
    }
    seen.add(finding.findingId);
    const disposition: ValidationResult<unknown> = validateFindingDisposition({
      findingId: finding.findingId,
      disposition: finding.disposition,
      reason: finding.reason,
    });
    if (!disposition.valid) {
      return { valid: false, errors: disposition.errors };
    }
    if (
      (finding.disposition === "BLOCKER" ||
        finding.disposition === "FIX_NOW") &&
      !finding.resolved
    ) {
      return {
        valid: false,
        errors: [`Accepted Finding remains unresolved: ${finding.findingId}`],
      };
    }
  }
  return { valid: true, value: true };
}

function evaluateCodeReview(
  codeReview: CodeReviewReadiness | null | undefined,
): ReadinessCheck {
  if (codeReview === undefined || codeReview === null) {
    return check(
      "code-review",
      "MISSING",
      "Plannotator code review result is missing",
    );
  }
  if (
    !isRecord(codeReview) ||
    !hasOnlyKeys(codeReview, ["status", "approved"]) ||
    !isCodeReviewStatus(codeReview.status) ||
    typeof codeReview.approved !== "boolean"
  ) {
    return check("code-review", "UNKNOWN", "Code review result is invalid");
  }
  return codeReview.status === "approved" && codeReview.approved
    ? check("code-review", "PASS", "approved")
    : check("code-review", "FAIL", "Code review was not approved");
}

export function evaluateReadyForMerge(
  input: ReadyForMergeInput,
): ReadyForMergeResult {
  if (!isRecord(input)) {
    return {
      ready: false,
      status: "BLOCKED",
      checks: [],
      blockers: [
        { code: "invalid-input", reason: "Readiness input is invalid" },
      ],
    };
  }

  const checks: ReadinessCheck[] = [];
  const blockers: ReadyForMergeResult["blockers"] = [];
  const record = (result: ReadinessCheck) => {
    checks.push(result);
    if (result.status !== "PASS") {
      blockers.push({ code: result.id, reason: result.reason });
    }
  };

  const handoff = validatePlanningHandoff(input.handoff);
  const approval = validateApprovalIdentity(
    input.approval,
    input.currentPlanHash,
    handoff.valid ? handoff.value : input.handoff,
  );
  record(
    approval.valid && handoff.valid
      ? check(
          "approved-plan-identity",
          "PASS",
          "approved plan identity is valid",
        )
      : check(
          "approved-plan-identity",
          input.approval === undefined || input.handoff === undefined
            ? "MISSING"
            : "FAIL",
          handoff.valid
            ? "Approval Identity is invalid"
            : "Planning Handoff is invalid",
        ),
  );

  record(
    input.implementationComplete
      ? check("implementation-complete", "PASS", "implementation is complete")
      : check(
          "implementation-complete",
          "FAIL",
          "implementation is incomplete",
        ),
  );

  const approvedGateBaseline =
    input.approvedGates === undefined
      ? undefined
      : evaluateTrustedGates(input.approvedGates);
  const approvedRequiredGateKeys =
    approvedGateBaseline?.valid && Array.isArray(input.approvedGates)
      ? input.approvedGates
          .filter((gate) => gate.requirement === "required")
          .map((gate) => gate.name)
      : [];
  const requiredGateKeys = input.requiredGateKeys ?? approvedRequiredGateKeys;
  const gateEvaluation = evaluateTrustedGates(input.gates, requiredGateKeys);
  const gateBlockers = [...gateEvaluation.blockers];
  if (input.approvedGates === undefined) {
    gateBlockers.push({
      code: "APPROVED_GATE_BASELINE_MISSING",
      reason: "Approved Gate baseline is missing",
    });
  } else if (approvedGateBaseline?.valid !== true) {
    gateBlockers.push({
      code: "INVALID_APPROVED_GATE_BASELINE",
      reason: "Approved Gate baseline is invalid",
    });
  } else {
    const preserved = validateRequiredGatesPreserved(
      input.approvedGates,
      input.gates,
    );
    if (!preserved.valid) {
      gateBlockers.push({
        code: "REQUIRED_GATE_DOWNGRADED",
        reason: preserved.errors.join("; "),
      });
    }
    if (input.repositoryGates !== undefined) {
      const resolved = validateRequiredGateResolution(
        input.approvedGates,
        input.repositoryGates,
      );
      if (!resolved.valid) {
        gateBlockers.push({
          code: "REQUIRED_GATE_DRIFT",
          reason: resolved.errors.join("; "),
        });
      }
    }
  }
  const gatesPassed = gateEvaluation.passed && gateBlockers.length === 0;
  const requiredGatesStatus =
    input.approvedGates === undefined
      ? "MISSING"
      : approvedGateBaseline?.valid !== true
        ? "UNKNOWN"
        : gateCheckStatus({
            ...gateEvaluation,
            passed: false,
            blockers: gateBlockers,
          });
  record(
    check(
      "required-gates",
      gatesPassed ? "PASS" : requiredGatesStatus,
      gatesPassed
        ? "all required Gates passed"
        : gateBlockers.map(({ reason }) => reason).join("; "),
    ),
  );

  const findings = evaluateFindings(input.findings);
  record(
    findings.valid
      ? check("accepted-findings", "PASS", "all accepted Findings are resolved")
      : check("accepted-findings", "FAIL", findings.errors.join("; ")),
  );

  const focusedReview = evaluateFocusedReview(
    input.fixWave,
    input.focusedReReview,
  );
  record(
    check(
      "focused-re-review",
      focusedReview.passed
        ? "PASS"
        : input.focusedReReview === undefined || input.focusedReReview === null
          ? "MISSING"
          : "FAIL",
      focusedReview.reason,
    ),
  );

  const finalDiffStatus: ReadinessCheckStatus = [
    "PASS",
    "FAIL",
    "MISSING",
    "UNKNOWN",
  ].includes(input.finalDiffInspection)
    ? input.finalDiffInspection
    : input.finalDiffInspection === undefined
      ? "MISSING"
      : "UNKNOWN";
  record(
    finalDiffStatus === "PASS"
      ? check("final-diff-inspection", "PASS", "final diff inspection passed")
      : check(
          "final-diff-inspection",
          finalDiffStatus,
          "final diff inspection did not pass",
        ),
  );

  record(evaluateCodeReview(input.codeReview));

  return {
    ready: blockers.length === 0,
    status: blockers.length === 0 ? "READY_FOR_MERGE" : "BLOCKED",
    checks,
    blockers,
  };
}
