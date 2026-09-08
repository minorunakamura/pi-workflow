import { Type, type Static } from "typebox";
import {
  type ValidationIssue,
  validateSchema,
  type ValidationResult,
} from "../validation";

const NonEmptyString = () => Type.String({ minLength: 1 });
const ReviewSourceSchema = Type.Union([
  Type.Literal("correctness"),
  Type.Literal("ponytail"),
]);

export const ReviewFindingSchema = Type.Object(
  {
    id: NonEmptyString(),
    source: ReviewSourceSchema,
    location: Type.Optional(NonEmptyString()),
    summary: NonEmptyString(),
  },
  { additionalProperties: false },
);

export const RejectedReviewFindingSchema = Type.Object(
  {
    id: NonEmptyString(),
    source: ReviewSourceSchema,
    location: Type.Optional(NonEmptyString()),
    summary: NonEmptyString(),
    reason: NonEmptyString(),
  },
  { additionalProperties: false },
);

export const DecisionRequiredSchema = Type.Object(
  {
    id: NonEmptyString(),
    question: NonEmptyString(),
    context: NonEmptyString(),
  },
  { additionalProperties: false },
);

export const ReviewDecisionSchema = Type.Object(
  {
    version: Type.Literal(1),
    blockers: Type.Array(ReviewFindingSchema),
    fixNow: Type.Array(ReviewFindingSchema),
    deferred: Type.Array(ReviewFindingSchema),
    rejected: Type.Array(RejectedReviewFindingSchema),
    decisionRequired: Type.Array(DecisionRequiredSchema),
  },
  { additionalProperties: false },
);

export type ReviewFinding = Static<typeof ReviewFindingSchema>;
export type RejectedReviewFinding = Static<typeof RejectedReviewFindingSchema>;
export type DecisionRequired = Static<typeof DecisionRequiredSchema>;
export type ReviewDecisionV1 = Static<typeof ReviewDecisionSchema>;

function semanticIssues(decision: ReviewDecisionV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  const findings = [
    ["/blockers", decision.blockers],
    ["/fixNow", decision.fixNow],
    ["/deferred", decision.deferred],
    ["/rejected", decision.rejected],
  ] as const;

  for (const [path, items] of findings) {
    items.forEach((item, index) => {
      if (seen.has(item.id)) {
        issues.push({
          path: `${path}/${index}/id`,
          message: "review ids must be unique",
        });
      } else {
        seen.add(item.id);
      }
    });
  }

  decision.decisionRequired.forEach((item, index) => {
    if (seen.has(item.id)) {
      issues.push({
        path: `/decisionRequired/${index}/id`,
        message: "review ids must be unique",
      });
    } else {
      seen.add(item.id);
    }
  });

  return issues;
}

export function validateReviewDecision(
  value: unknown,
): ValidationResult<ReviewDecisionV1> {
  return validateSchema(ReviewDecisionSchema, value, semanticIssues);
}
