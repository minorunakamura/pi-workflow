import type { Static } from "typebox";
import {
  duplicateIdIssues,
  type ValidationIssue,
  validateSchema,
  type ValidationResult,
} from "../validation";
import {
  PlanningDecisionSchema,
  type AcceptanceCriterionSchema,
  type UnresolvedDecisionSchema,
  type VerificationSchema,
  type WorkUnitSchema,
} from "./planning-decision-schema";

export type AcceptanceCriterion = Static<typeof AcceptanceCriterionSchema>;
export type Verification = Static<typeof VerificationSchema>;
export type WorkUnit = Static<typeof WorkUnitSchema>;
export type UnresolvedDecision = Static<typeof UnresolvedDecisionSchema>;
export type PlanningDecisionV1 = Static<typeof PlanningDecisionSchema>;

function semanticIssues(decision: PlanningDecisionV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [
    ...duplicateIdIssues(
      decision.acceptanceCriteria,
      "/acceptanceCriteria",
      "acceptanceCriteria ids must be unique",
    ),
    ...duplicateIdIssues(
      decision.verification,
      "/verification",
      "verification ids must be unique",
    ),
    ...duplicateIdIssues(
      decision.implementation.workUnits,
      "/implementation/workUnits",
      "work unit ids must be unique",
    ),
    ...duplicateIdIssues(
      decision.unresolvedDecisions,
      "/unresolvedDecisions",
      "unresolved decision ids must be unique",
    ),
  ];

  const acceptanceIds = new Set(
    decision.acceptanceCriteria.map((criterion) => criterion.id),
  );
  const verificationIds = new Set(
    decision.verification.map((verification) => verification.id),
  );
  const workUnitIds = new Set(
    decision.implementation.workUnits.map((workUnit) => workUnit.id),
  );

  decision.implementation.workUnits.forEach((workUnit, index) => {
    if (workUnit.writeScope.length === 0) {
      issues.push({
        path: `/implementation/workUnits/${index}/writeScope`,
        message: "writeScope must contain at least one path",
      });
    }

    workUnit.dependsOn.forEach((dependency, dependencyIndex) => {
      if (!workUnitIds.has(dependency)) {
        issues.push({
          path: `/implementation/workUnits/${index}/dependsOn/${dependencyIndex}`,
          message: `work unit ${workUnit.id} references unknown dependency ${dependency}`,
        });
      }
      if (dependency === workUnit.id) {
        issues.push({
          path: `/implementation/workUnits/${index}/dependsOn/${dependencyIndex}`,
          message: "work unit cannot depend on itself",
        });
      }
    });

    workUnit.acceptanceCriteriaIds.forEach((criterionId, criterionIndex) => {
      if (!acceptanceIds.has(criterionId)) {
        issues.push({
          path: `/implementation/workUnits/${index}/acceptanceCriteriaIds/${criterionIndex}`,
          message: `work unit ${workUnit.id} references unknown acceptance criterion ${criterionId}`,
        });
      }
    });

    workUnit.focusedVerificationIds.forEach(
      (verificationId, verificationIndex) => {
        if (!verificationIds.has(verificationId)) {
          issues.push({
            path: `/implementation/workUnits/${index}/focusedVerificationIds/${verificationIndex}`,
            message: `work unit ${workUnit.id} references unknown verification ${verificationId}`,
          });
        }
      },
    );
  });

  decision.implementation.finalVerificationIds.forEach(
    (verificationId, index) => {
      if (!verificationIds.has(verificationId)) {
        issues.push({
          path: `/implementation/finalVerificationIds/${index}`,
          message: `final verification references unknown verification ${verificationId}`,
        });
      }
    },
  );

  if (decision.implementation.mode === "lanes") {
    const hasDependency = decision.implementation.workUnits.some(
      (workUnit) => workUnit.dependsOn.length > 0,
    );
    if (hasDependency) {
      issues.push({
        path: "/implementation/workUnits",
        message: "lane mode work units must not depend on another work unit",
      });
    }
  }

  return issues;
}

export function validatePlanningDecision(
  value: unknown,
): ValidationResult<PlanningDecisionV1> {
  return validateSchema(PlanningDecisionSchema, value, semanticIssues);
}

export function validatePlanningDecisionForApproval(
  value: unknown,
): ValidationResult<PlanningDecisionV1> {
  const result = validatePlanningDecision(value);
  if (!result.ok || result.value.unresolvedDecisions.length === 0)
    return result;

  return {
    ok: false,
    errors: [
      {
        path: "/unresolvedDecisions",
        message: "unresolved decisions must be resolved before plan review",
      },
    ],
  };
}
