import type { Static } from "typebox";
import {
  duplicateIdIssues,
  jsonBoundIssues,
  type ValidationIssue,
  validateSchema,
  type ValidationResult,
  utf8ByteIssues,
} from "../validation";
import {
  PlanningDecisionSchema,
  type AcceptanceCriterionSchema,
  type UnresolvedDecisionSchema,
  type VerificationSchema,
  type WorkUnitSchema,
} from "./planning-decision-schema";
import {
  MAX_PLANNING_COMMAND_BYTES,
  MAX_PLANNING_DECISION_BYTES,
  MAX_PLANNING_IDENTIFIER_BYTES,
  MAX_PLANNING_TEXT_BYTES,
} from "./limits";

export {
  MAX_PLANNING_ACCEPTANCE_CRITERIA,
  MAX_PLANNING_COMMAND_BYTES,
  MAX_PLANNING_CONSTRAINTS,
  MAX_PLANNING_DECISION_BYTES,
  MAX_PLANNING_FINAL_VERIFICATIONS,
  MAX_PLANNING_IDENTIFIER_BYTES,
  MAX_PLANNING_RISKS,
  MAX_PLANNING_SCOPE_ITEMS,
  MAX_PLANNING_TEXT_BYTES,
  MAX_PLANNING_VERIFICATIONS,
  MAX_PLANNING_WORK_UNITS,
  MAX_UNRESOLVED_DECISIONS,
  MAX_VERIFICATION_TIMEOUT_MS,
  MAX_WORK_UNIT_REFERENCES,
} from "./limits";

export type AcceptanceCriterion = Static<typeof AcceptanceCriterionSchema>;
export type Verification = Static<typeof VerificationSchema>;
export type WorkUnit = Static<typeof WorkUnitSchema>;
export type UnresolvedDecision = Static<typeof UnresolvedDecisionSchema>;
export type PlanningDecisionV1 = Static<typeof PlanningDecisionSchema>;

function utf8Issue(
  path: string,
  value: string,
  maximum: number,
  label: string,
): ValidationIssue[] {
  return utf8ByteIssues(path, value, maximum, label);
}

function boundedIssues(decision: PlanningDecisionV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [
    ...utf8Issue(
      "/requestSummary",
      decision.requestSummary,
      MAX_PLANNING_TEXT_BYTES,
      "requestSummary",
    ),
  ];
  const addText = (path: string, value: string) => {
    issues.push(...utf8Issue(path, value, MAX_PLANNING_TEXT_BYTES, "text"));
  };
  const addIdentifier = (path: string, value: string) => {
    issues.push(
      ...utf8Issue(path, value, MAX_PLANNING_IDENTIFIER_BYTES, "identifier"),
    );
  };
  const addCommand = (path: string, value: string) => {
    issues.push(
      ...utf8Issue(path, value, MAX_PLANNING_COMMAND_BYTES, "command or scope"),
    );
  };

  for (const [scope, values] of Object.entries(decision.scope)) {
    values.forEach((value, index) =>
      addText(`/scope/${scope}/${index}`, value),
    );
  }
  decision.acceptanceCriteria.forEach((criterion, index) => {
    addIdentifier(`/acceptanceCriteria/${index}/id`, criterion.id);
    addText(`/acceptanceCriteria/${index}/text`, criterion.text);
  });
  decision.constraints.forEach((value, index) =>
    addText(`/constraints/${index}`, value),
  );
  decision.risks.forEach((value, index) => addText(`/risks/${index}`, value));
  decision.verification.forEach((verification, index) => {
    addIdentifier(`/verification/${index}/id`, verification.id);
    addText(`/verification/${index}/description`, verification.description);
    addCommand(`/verification/${index}/command`, verification.command);
  });
  decision.implementation.workUnits.forEach((workUnit, index) => {
    addIdentifier(`/implementation/workUnits/${index}/id`, workUnit.id);
    addText(`/implementation/workUnits/${index}/title`, workUnit.title);
    addText(`/implementation/workUnits/${index}/objective`, workUnit.objective);
    workUnit.dependsOn.forEach((value, valueIndex) =>
      addIdentifier(
        `/implementation/workUnits/${index}/dependsOn/${valueIndex}`,
        value,
      ),
    );
    workUnit.writeScope.forEach((value, valueIndex) =>
      addCommand(
        `/implementation/workUnits/${index}/writeScope/${valueIndex}`,
        value,
      ),
    );
    workUnit.acceptanceCriteriaIds.forEach((value, valueIndex) =>
      addIdentifier(
        `/implementation/workUnits/${index}/acceptanceCriteriaIds/${valueIndex}`,
        value,
      ),
    );
    workUnit.focusedVerificationIds.forEach((value, valueIndex) =>
      addIdentifier(
        `/implementation/workUnits/${index}/focusedVerificationIds/${valueIndex}`,
        value,
      ),
    );
  });
  decision.implementation.finalVerificationIds.forEach((value, index) =>
    addIdentifier(`/implementation/finalVerificationIds/${index}`, value),
  );
  decision.unresolvedDecisions.forEach((item, index) => {
    addIdentifier(`/unresolvedDecisions/${index}/id`, item.id);
    addText(`/unresolvedDecisions/${index}/question`, item.question);
    addText(`/unresolvedDecisions/${index}/reason`, item.reason);
  });

  return issues;
}

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
  const structural = validateSchema(
    PlanningDecisionSchema,
    value,
    semanticIssues,
  );
  if (!structural.ok) return structural;

  const bounded = boundedIssues(structural.value);
  if (bounded.length > 0) return { ok: false, errors: bounded };

  const aggregate = jsonBoundIssues(value, {
    maxBytes: MAX_PLANNING_DECISION_BYTES,
  });
  return aggregate.length > 0 ? { ok: false, errors: aggregate } : structural;
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
