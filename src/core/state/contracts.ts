import { Type, type Static, type TSchema } from "typebox";
import {
  isJsonValue,
  jsonBoundIssues,
  MAX_HUMAN_INPUT_ENTRIES,
  MAX_HUMAN_INPUT_VALUE_BYTES,
  MAX_IDENTIFIER_BYTES,
  MAX_MISSION_STATE_BYTES,
  MAX_REGULAR_TEXT_BYTES,
  MAX_REQUEST_BYTES,
  type ValidationIssue,
  validateSchema,
  type ValidationResult,
  utf8ByteIssues,
} from "../validation";
import { PlanningDecisionSchema } from "../planning/planning-decision-schema";
import { validatePlanningDecision } from "../planning/planning-decision";
import {
  ReferenceValueSchema,
  validateReferenceValue,
  type ReferenceValue,
} from "./references";

export {
  MAX_HUMAN_INPUT_ENTRIES,
  MAX_HUMAN_INPUT_VALUE_BYTES,
  MAX_IDENTIFIER_BYTES,
  MAX_MISSION_STATE_BYTES,
  MAX_PLAN_REVIEW_ROUNDS,
  MAX_REGULAR_TEXT_BYTES,
  MAX_REQUEST_BYTES,
} from "../validation";
export { MAX_REFERENCE_BYTES } from "./references";

const Identifier = () =>
  Type.String({ minLength: 1, maxLength: MAX_IDENTIFIER_BYTES });
const CompactText = () =>
  Type.String({ minLength: 1, maxLength: MAX_REGULAR_TEXT_BYTES });
const RequestText = () =>
  Type.String({ minLength: 1, maxLength: MAX_REQUEST_BYTES });

export const MAX_DISCOVERY_METADATA_BYTES = 8 * 1024;
export const MAX_RESEARCH_METADATA_BYTES = 8 * 1024;
export const MAX_PLAN_REVIEW_BINDING_BYTES = 8 * 1024;
export const MAX_DISCOVERY_METADATA_ITEMS = 8;
export const MAX_RESEARCH_QUESTIONS = 8;

export const RequestTypeSchema = Type.Union([
  Type.Literal("feature"),
  Type.Literal("bug"),
  Type.Literal("chore"),
  Type.Literal("hotfix"),
]);

export const MissionPhaseSchema = Type.Union([
  Type.Literal("discovery"),
  Type.Literal("research"),
  Type.Literal("planning"),
  Type.Literal("plan-review"),
]);

export const HumanInputSchema = Type.Object(
  {
    id: Identifier(),
    value: Type.String({
      minLength: 1,
      maxLength: MAX_HUMAN_INPUT_VALUE_BYTES,
    }),
  },
  { additionalProperties: false },
);

export const HumanInputsSchema = Type.Array(HumanInputSchema, {
  maxItems: MAX_HUMAN_INPUT_ENTRIES,
});
export const HumanDecisionSchema = HumanInputSchema;

export const DiscoveryUncertaintySchema = Type.Object(
  {
    id: Identifier(),
    question: CompactText(),
    material: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const DiscoveryMetadataSchema = Type.Object(
  {
    version: Type.Literal(1),
    status: Type.Union([Type.Literal("ready"), Type.Literal("blocked")]),
    externalResearchRequired: Type.Boolean(),
    humanClarificationRequired: Type.Boolean(),
    uncertainties: Type.Array(DiscoveryUncertaintySchema, {
      maxItems: MAX_DISCOVERY_METADATA_ITEMS,
    }),
    researchQuestions: Type.Array(CompactText(), {
      maxItems: MAX_RESEARCH_QUESTIONS,
    }),
  },
  { additionalProperties: false },
);

export const ResearchMetadataSchema = Type.Object(
  {
    version: Type.Literal(1),
    status: Type.Union([Type.Literal("completed"), Type.Literal("blocked")]),
    unresolvedQuestions: Type.Array(CompactText(), {
      maxItems: MAX_RESEARCH_QUESTIONS,
    }),
  },
  { additionalProperties: false },
);

export type RequestType = Static<typeof RequestTypeSchema>;
export type MissionPhase = Static<typeof MissionPhaseSchema>;

export const PlanReviewBindingSchema = Type.Object(
  {
    version: Type.Literal(1),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("approved"),
      Type.Literal("rejected"),
    ]),
    round: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    planRef: ReferenceValueSchema,
    reviewId: Type.Optional(ReferenceValueSchema),
    feedbackRef: Type.Optional(ReferenceValueSchema),
  },
  { additionalProperties: false },
);

export const MissionStateSchema = Type.Object(
  {
    version: Type.Literal(1),
    requestType: Type.Optional(RequestTypeSchema),
    request: Type.Optional(RequestText()),
    phase: Type.Optional(MissionPhaseSchema),
    humanDecisions: Type.Optional(HumanInputsSchema),
    discoveryRef: Type.Optional(ReferenceValueSchema),
    discoveryMeta: Type.Optional(DiscoveryMetadataSchema),
    researchRef: Type.Optional(ReferenceValueSchema),
    researchMeta: Type.Optional(ResearchMetadataSchema),
    planRef: Type.Optional(ReferenceValueSchema),
    planningDecision: Type.Optional(
      // The Planning module owns the schema and semantic validator.
      // Keeping the same schema here prevents a second state-only shape.
      PlanningDecisionSchema,
    ),
    planReview: Type.Optional(PlanReviewBindingSchema),
  },
  { additionalProperties: false },
);

export const MISSION_STATE_KEYS = Object.freeze(
  Object.keys(MissionStateSchema.properties),
);

export type MissionStateKey = keyof Static<typeof MissionStateSchema>;

export type HumanInputV1 = Static<typeof HumanInputSchema>;
export type HumanDecisionV1 = HumanInputV1;
export type DiscoveryMetadataV1 = Static<typeof DiscoveryMetadataSchema>;
export type ResearchMetadataV1 = Static<typeof ResearchMetadataSchema>;
export type PlanReviewBindingV1 = Static<typeof PlanReviewBindingSchema>;
export type MissionStateV1 = Static<typeof MissionStateSchema>;

function utf8Issue(
  path: string,
  value: string,
  maximum: number,
  label: string,
): ValidationIssue[] {
  return utf8ByteIssues(path, value, maximum, label);
}

function prefixIssues(
  prefix: string,
  errors: readonly ValidationIssue[],
): ValidationIssue[] {
  return errors.map((error) => ({
    path: error.path === "/" ? prefix : `${prefix}${error.path}`,
    message: error.message,
  }));
}

function boundedSchemaResult<S extends TSchema>(
  schema: S,
  value: unknown,
  nestedIssues: (value: Static<S>) => ValidationIssue[],
  maxBytes?: number,
): ValidationResult<Static<S>> {
  const structural = validateSchema(schema, value);
  if (!structural.ok) return structural;

  const nested = nestedIssues(structural.value);
  if (nested.length > 0) return { ok: false, errors: nested };

  const aggregate = jsonBoundIssues(
    value,
    maxBytes === undefined ? {} : { maxBytes },
  );
  return aggregate.length > 0 ? { ok: false, errors: aggregate } : structural;
}

function humanInputIssues(value: HumanInputV1[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  value.forEach((item, index) => {
    issues.push(
      ...utf8Issue(`/${index}/id`, item.id, MAX_IDENTIFIER_BYTES, "identifier"),
      ...utf8Issue(
        `/${index}/value`,
        item.value,
        MAX_HUMAN_INPUT_VALUE_BYTES,
        "human input",
      ),
    );
  });
  return issues;
}

export function validateHumanInputs(
  value: unknown,
): ValidationResult<HumanInputV1[]> {
  return boundedSchemaResult(HumanInputsSchema, value, humanInputIssues);
}

export const validateHumanDecisions = validateHumanInputs;

function metadataIssues(value: DiscoveryMetadataV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  value.uncertainties.forEach((item, index) => {
    issues.push(
      ...utf8Issue(
        `/uncertainties/${index}/id`,
        item.id,
        MAX_IDENTIFIER_BYTES,
        "identifier",
      ),
      ...utf8Issue(
        `/uncertainties/${index}/question`,
        item.question,
        MAX_REGULAR_TEXT_BYTES,
        "question",
      ),
    );
  });
  value.researchQuestions.forEach((question, index) => {
    issues.push(
      ...utf8Issue(
        `/researchQuestions/${index}`,
        question,
        MAX_REGULAR_TEXT_BYTES,
        "question",
      ),
    );
  });
  return issues;
}

export function validateDiscoveryMetadata(
  value: unknown,
): ValidationResult<DiscoveryMetadataV1> {
  return boundedSchemaResult(
    DiscoveryMetadataSchema,
    value,
    metadataIssues,
    MAX_DISCOVERY_METADATA_BYTES,
  );
}

function researchMetadataIssues(value: ResearchMetadataV1): ValidationIssue[] {
  return value.unresolvedQuestions.flatMap((question, index) =>
    utf8Issue(
      `/unresolvedQuestions/${index}`,
      question,
      MAX_REGULAR_TEXT_BYTES,
      "question",
    ),
  );
}

export function validateResearchMetadata(
  value: unknown,
): ValidationResult<ResearchMetadataV1> {
  return boundedSchemaResult(
    ResearchMetadataSchema,
    value,
    researchMetadataIssues,
    MAX_RESEARCH_METADATA_BYTES,
  );
}

function referenceIssues(
  path: string,
  value: ReferenceValue,
): ValidationIssue[] {
  return prefixIssues(path, validateReferenceValue(value).errors);
}

function planReviewBindingIssues(
  value: PlanReviewBindingV1,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [
    ...referenceIssues("/planRef", value.planRef),
  ];
  if (value.reviewId !== undefined) {
    issues.push(...referenceIssues("/reviewId", value.reviewId));
  }
  if (value.feedbackRef !== undefined) {
    issues.push(...referenceIssues("/feedbackRef", value.feedbackRef));
  }
  if (value.status === "pending") {
    if (value.feedbackRef !== undefined) {
      issues.push({
        path: "/feedbackRef",
        message: "pending Plan Review must not have a feedbackRef",
      });
    }
  } else {
    if (value.reviewId === undefined) {
      issues.push({
        path: "/reviewId",
        message: "terminal Plan Review requires a reviewId",
      });
    }
    if (value.status === "rejected" && value.feedbackRef === undefined) {
      issues.push({
        path: "/feedbackRef",
        message: "rejected Plan Review requires a feedbackRef",
      });
    }
    if (value.status === "approved" && value.feedbackRef !== undefined) {
      issues.push({
        path: "/feedbackRef",
        message: "approved Plan Review must not have a feedbackRef",
      });
    }
  }
  return issues;
}

export function validatePlanReviewBinding(
  value: unknown,
): ValidationResult<PlanReviewBindingV1> {
  return boundedSchemaResult(
    PlanReviewBindingSchema,
    value,
    planReviewBindingIssues,
    MAX_PLAN_REVIEW_BINDING_BYTES,
  );
}

function missionStateNestedIssues(value: MissionStateV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (value.request !== undefined) {
    issues.push(
      ...utf8Issue("/request", value.request, MAX_REQUEST_BYTES, "request"),
    );
  }
  if (value.humanDecisions !== undefined) {
    const result = validateHumanInputs(value.humanDecisions);
    if (!result.ok)
      issues.push(...prefixIssues("/humanDecisions", result.errors));
  }
  for (const [key, reference] of [
    ["discoveryRef", value.discoveryRef],
    ["researchRef", value.researchRef],
    ["planRef", value.planRef],
  ] as const) {
    if (reference !== undefined)
      issues.push(...referenceIssues(`/${key}`, reference));
  }
  if (value.discoveryMeta !== undefined) {
    const result = validateDiscoveryMetadata(value.discoveryMeta);
    if (!result.ok)
      issues.push(...prefixIssues("/discoveryMeta", result.errors));
  }
  if (value.researchMeta !== undefined) {
    const result = validateResearchMetadata(value.researchMeta);
    if (!result.ok)
      issues.push(...prefixIssues("/researchMeta", result.errors));
  }
  if (value.planningDecision !== undefined) {
    const result = validatePlanningDecision(value.planningDecision);
    if (!result.ok)
      issues.push(...prefixIssues("/planningDecision", result.errors));
  }
  if (value.planReview !== undefined) {
    const result = validatePlanReviewBinding(value.planReview);
    if (!result.ok) issues.push(...prefixIssues("/planReview", result.errors));
  }
  return issues;
}

export function validateMissionState(
  value: unknown,
): ValidationResult<MissionStateV1> {
  const structural = validateSchema(MissionStateSchema, value);
  if (!structural.ok) return structural;

  const nested = missionStateNestedIssues(structural.value);
  if (nested.length > 0) return { ok: false, errors: nested };

  if (!isJsonValue(value)) {
    return {
      ok: false,
      errors: [{ path: "/", message: "Mission state must be JSON" }],
    };
  }

  const aggregate = jsonBoundIssues(value, {
    maxBytes: MAX_MISSION_STATE_BYTES,
  });
  return aggregate.length > 0
    ? { ok: false, errors: aggregate }
    : { ok: true, value: structural.value, errors: [] };
}

export const validateMissionStateContract = validateMissionState;
export const MissionStateContractSchema = MissionStateSchema;
