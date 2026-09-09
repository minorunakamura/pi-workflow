import { Type, type Static } from "typebox";
import {
  jsonBoundIssues,
  MAX_IDENTIFIER_BYTES,
  MAX_REGULAR_TEXT_BYTES,
  type ValidationIssue,
  validateSchema,
  type ValidationResult,
  utf8ByteIssues,
} from "../validation";

export const MAX_REVIEW_DECISION_BYTES = 24 * 1024;
export const MAX_REVIEW_FINDINGS = 16;
export const MAX_REVIEW_DECISION_REQUIRED = 8;

const Identifier = () =>
  Type.String({ minLength: 1, maxLength: MAX_IDENTIFIER_BYTES });
const CompactText = () =>
  Type.String({ minLength: 1, maxLength: MAX_REGULAR_TEXT_BYTES });
const ReviewSourceSchema = Type.Union([
  Type.Literal("correctness"),
  Type.Literal("ponytail"),
]);

export const ReviewFindingSchema = Type.Object(
  {
    id: Identifier(),
    source: ReviewSourceSchema,
    location: Type.Optional(CompactText()),
    summary: CompactText(),
  },
  { additionalProperties: false },
);

export const RejectedReviewFindingSchema = Type.Object(
  {
    id: Identifier(),
    source: ReviewSourceSchema,
    location: Type.Optional(CompactText()),
    summary: CompactText(),
    reason: CompactText(),
  },
  { additionalProperties: false },
);

export const DecisionRequiredSchema = Type.Object(
  {
    id: Identifier(),
    question: CompactText(),
    context: CompactText(),
  },
  { additionalProperties: false },
);

export const ReviewDecisionSchema = Type.Object(
  {
    version: Type.Literal(1),
    blockers: Type.Array(ReviewFindingSchema, {
      maxItems: MAX_REVIEW_FINDINGS,
    }),
    fixNow: Type.Array(ReviewFindingSchema, { maxItems: MAX_REVIEW_FINDINGS }),
    deferred: Type.Array(ReviewFindingSchema, {
      maxItems: MAX_REVIEW_FINDINGS,
    }),
    rejected: Type.Array(RejectedReviewFindingSchema, {
      maxItems: MAX_REVIEW_FINDINGS,
    }),
    decisionRequired: Type.Array(DecisionRequiredSchema, {
      maxItems: MAX_REVIEW_DECISION_REQUIRED,
    }),
  },
  { additionalProperties: false },
);

export type ReviewFinding = Static<typeof ReviewFindingSchema>;
export type RejectedReviewFinding = Static<typeof RejectedReviewFindingSchema>;
export type DecisionRequired = Static<typeof DecisionRequiredSchema>;
export type ReviewDecisionV1 = Static<typeof ReviewDecisionSchema>;

function utf8Issue(
  path: string,
  value: string,
  maximum: number,
  label: string,
): ValidationIssue[] {
  return utf8ByteIssues(path, value, maximum, label);
}

function boundedIssues(decision: ReviewDecisionV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const addIdentifier = (path: string, value: string) => {
    issues.push(...utf8Issue(path, value, MAX_IDENTIFIER_BYTES, "identifier"));
  };
  const addText = (path: string, value: string) => {
    issues.push(...utf8Issue(path, value, MAX_REGULAR_TEXT_BYTES, "text"));
  };

  const findings = [
    ["/blockers", decision.blockers],
    ["/fixNow", decision.fixNow],
    ["/deferred", decision.deferred],
    ["/rejected", decision.rejected],
  ] as const;
  for (const [path, items] of findings) {
    items.forEach((item, index) => {
      addIdentifier(`${path}/${index}/id`, item.id);
      if (item.location !== undefined)
        addText(`${path}/${index}/location`, item.location);
      addText(`${path}/${index}/summary`, item.summary);
      if ("reason" in item && typeof item.reason === "string")
        addText(`${path}/${index}/reason`, item.reason);
    });
  }
  decision.decisionRequired.forEach((item, index) => {
    addIdentifier(`/decisionRequired/${index}/id`, item.id);
    addText(`/decisionRequired/${index}/question`, item.question);
    addText(`/decisionRequired/${index}/context`, item.context);
  });

  return issues;
}

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
  const structural = validateSchema(
    ReviewDecisionSchema,
    value,
    semanticIssues,
  );
  if (!structural.ok) return structural;

  const bounded = boundedIssues(structural.value);
  if (bounded.length > 0) return { ok: false, errors: bounded };

  const aggregate = jsonBoundIssues(value, {
    maxBytes: MAX_REVIEW_DECISION_BYTES,
  });
  return aggregate.length > 0 ? { ok: false, errors: aggregate } : structural;
}
