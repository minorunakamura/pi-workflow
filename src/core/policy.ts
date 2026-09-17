import type { ArtifactRef, WorkflowType } from "./workflow.ts";

export type PlanningRequirement = "required" | "evidence-driven-conditional";

const commonPlanningRequirements = {
  scout: "required",
  "plan-composition": "required",
  researcher: "evidence-driven-conditional",
  grilling: "evidence-driven-conditional",
  "human-decision": "evidence-driven-conditional",
  "targeted-rescout": "evidence-driven-conditional",
  oracle: "evidence-driven-conditional",
} as const satisfies Readonly<Record<string, PlanningRequirement>>;

export const COMMON_PLANNING_REQUIREMENTS = Object.freeze(
  commonPlanningRequirements,
);
export type PlanningCapability = keyof typeof commonPlanningRequirements;

function isPlanningCapability(value: string): value is PlanningCapability {
  return Object.hasOwn(commonPlanningRequirements, value);
}

export const PLANNING_CAPABILITIES = Object.freeze(
  Object.keys(commonPlanningRequirements).filter(isPlanningCapability),
);

export interface WorkflowTypePolicy {
  workflowType: WorkflowType;
  scoutFocus: readonly string[];
}

export interface WorkflowPolicy {
  source: "package-built-in";
  commonPlanning: typeof COMMON_PLANNING_REQUIREMENTS;
  typePolicies: Readonly<Record<WorkflowType, WorkflowTypePolicy>>;
}

export interface PlanningSelectionRecord {
  capability: PlanningCapability;
  reason: string;
  evidenceRefs?: readonly ArtifactRef[];
}

const TYPE_POLICIES: Readonly<Record<WorkflowType, WorkflowTypePolicy>> =
  Object.freeze({
    feature: Object.freeze({
      workflowType: "feature",
      scoutFocus: Object.freeze([
        "existing implementation",
        "impact scope",
        "related tests",
        "existing patterns",
        "extension points",
      ]),
    }),
    bug: Object.freeze({
      workflowType: "bug",
      scoutFocus: Object.freeze([
        "symptom",
        "reproduction evidence",
        "expected vs actual",
        "affected path",
        "regression coverage",
        "evidence-based root-cause hypothesis",
        "blast radius",
      ]),
    }),
    chore: Object.freeze({
      workflowType: "chore",
      scoutFocus: Object.freeze([
        "target config/files",
        "dependencies",
        "scripts/CI/build impact",
        "generated files/lockfiles",
        "compatibility",
        "cleanup/removal scope",
      ]),
    }),
    hotfix: Object.freeze({
      workflowType: "hotfix",
      scoutFocus: Object.freeze([
        "incident/symptom",
        "affected component",
        "likely cause",
        "minimal safe change area",
        "blast radius",
        "regression test",
        "rollback/revert consideration",
        "data/security risk",
      ]),
    }),
  });

export const BUILT_IN_WORKFLOW_POLICY: WorkflowPolicy = Object.freeze({
  source: "package-built-in",
  commonPlanning: COMMON_PLANNING_REQUIREMENTS,
  typePolicies: TYPE_POLICIES,
});

export function getWorkflowPolicy(): WorkflowPolicy {
  return BUILT_IN_WORKFLOW_POLICY;
}

export function getWorkflowTypePolicy(
  workflowType: WorkflowType,
): WorkflowTypePolicy {
  return BUILT_IN_WORKFLOW_POLICY.typePolicies[workflowType];
}
