import { Type, type Static, type TSchema } from "typebox";
import {
  jsonBoundIssues,
  MAX_HUMAN_INPUT_ENTRIES,
  MAX_PLAN_REVIEW_ROUNDS,
  MAX_REQUEST_BYTES,
  MAX_RESOURCE_ARGS_BYTES,
  MAX_REVIEW_FIX_WAVES,
  MAX_VERIFICATION_FIX_ROUNDS,
  type ValidationIssue,
  validateSchema,
  type ValidationResult,
  utf8ByteIssues,
} from "../validation";
import {
  HumanInputSchema,
  RequestTypeSchema,
  validateHumanInputs,
  type HumanInputV1,
} from "../state/contracts";
import {
  ReferenceValueSchema,
  validateReferenceValue,
  type ReferenceValue,
} from "../state/references";

const RequestText = () =>
  Type.String({ minLength: 1, maxLength: MAX_REQUEST_BYTES });

export {
  MAX_HUMAN_INPUT_ENTRIES,
  MAX_PLAN_REVIEW_ROUNDS,
  MAX_REQUEST_BYTES,
  MAX_RESOURCE_ARGS_BYTES,
  MAX_REVIEW_FIX_WAVES,
  MAX_VERIFICATION_FIX_ROUNDS,
} from "../validation";

export const RESOURCE_ARGS_PHASES = [
  "discovery",
  "research",
  "planning",
  "implementation",
  "verification",
  "verification-fix",
  "review",
] as const;

export type ResourceArgsPhase = (typeof RESOURCE_ARGS_PHASES)[number];

export const DiscoveryArgsSchema = Type.Object(
  {
    requestType: RequestTypeSchema,
    request: RequestText(),
    attempt: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_PLAN_REVIEW_ROUNDS }),
    ),
  },
  { additionalProperties: false },
);

export const ResearchArgsSchema = Type.Object(
  {
    attempt: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_PLAN_REVIEW_ROUNDS }),
    ),
  },
  { additionalProperties: false },
);

export const PlanningArgsSchema = Type.Object(
  {
    round: Type.Integer({ minimum: 1, maximum: MAX_PLAN_REVIEW_ROUNDS }),
    humanInputs: Type.Optional(
      Type.Array(HumanInputSchema, { maxItems: MAX_HUMAN_INPUT_ENTRIES }),
    ),
    feedbackRef: Type.Optional(ReferenceValueSchema),
  },
  { additionalProperties: false },
);

export const ImplementationArgsSchema = Type.Object(
  {
    mode: Type.Union([
      Type.Literal("single"),
      Type.Literal("lanes"),
      Type.Literal("review-fix"),
    ]),
    verificationRound: Type.Optional(
      Type.Integer({ minimum: 0, maximum: MAX_VERIFICATION_FIX_ROUNDS }),
    ),
    reviewFixWave: Type.Optional(
      Type.Integer({ minimum: 0, maximum: MAX_REVIEW_FIX_WAVES }),
    ),
  },
  { additionalProperties: false },
);

export const VerificationArgsSchema = Type.Object(
  {
    round: Type.Integer({ minimum: 0, maximum: MAX_VERIFICATION_FIX_ROUNDS }),
  },
  { additionalProperties: false },
);

export const VerificationFixArgsSchema = Type.Object(
  {
    round: Type.Integer({
      minimum: 1,
      maximum: MAX_VERIFICATION_FIX_ROUNDS,
    }),
  },
  { additionalProperties: false },
);

export const ReviewArgsSchema = Type.Object(
  {
    wave: Type.Integer({ minimum: 0, maximum: MAX_REVIEW_FIX_WAVES }),
  },
  { additionalProperties: false },
);

export const ResourceArgsSchemas = {
  discovery: DiscoveryArgsSchema,
  research: ResearchArgsSchema,
  planning: PlanningArgsSchema,
  implementation: ImplementationArgsSchema,
  verification: VerificationArgsSchema,
  "verification-fix": VerificationFixArgsSchema,
  review: ReviewArgsSchema,
} as const satisfies Record<ResourceArgsPhase, TSchema>;

export const PhaseArgsSchemas = ResourceArgsSchemas;

export type DiscoveryArgsV1 = Static<typeof DiscoveryArgsSchema>;
export type ResearchArgsV1 = Static<typeof ResearchArgsSchema>;
export type PlanningArgsV1 = Static<typeof PlanningArgsSchema>;
export type ImplementationArgsV1 = Static<typeof ImplementationArgsSchema>;
export type VerificationArgsV1 = Static<typeof VerificationArgsSchema>;
export type VerificationFixArgsV1 = Static<typeof VerificationFixArgsSchema>;
export type ReviewArgsV1 = Static<typeof ReviewArgsSchema>;

export type ResourceArgs =
  | DiscoveryArgsV1
  | ResearchArgsV1
  | PlanningArgsV1
  | ImplementationArgsV1
  | VerificationArgsV1
  | VerificationFixArgsV1
  | ReviewArgsV1;

function isResourceArgsPhase(value: unknown): value is ResourceArgsPhase {
  return (
    typeof value === "string" &&
    (RESOURCE_ARGS_PHASES as readonly string[]).includes(value)
  );
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

function utf8Issue(
  path: string,
  value: string,
  maximum: number,
  label: string,
): ValidationIssue[] {
  return utf8ByteIssues(path, value, maximum, label);
}

function phaseNestedIssues(
  phase: ResourceArgsPhase,
  value: ResourceArgs,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (phase === "discovery" && "request" in value) {
    issues.push(
      ...utf8Issue("/request", value.request, MAX_REQUEST_BYTES, "request"),
    );
  }
  if (phase === "planning") {
    if ("humanInputs" in value && value.humanInputs !== undefined) {
      const humanInputs = validateHumanInputs(value.humanInputs);
      if (!humanInputs.ok)
        issues.push(...prefixIssues("/humanInputs", humanInputs.errors));
    }
    if ("feedbackRef" in value && value.feedbackRef !== undefined) {
      issues.push(
        ...prefixIssues(
          "/feedbackRef",
          validateReferenceValue(value.feedbackRef).errors,
        ),
      );
    }
  }
  if (phase === "implementation" && "mode" in value) {
    if (
      value.mode === "review-fix" &&
      value.reviewFixWave !== MAX_REVIEW_FIX_WAVES
    ) {
      issues.push({
        path: "/reviewFixWave",
        message: "review-fix requires reviewFixWave to be 1",
      });
    }
    if (
      value.mode !== "review-fix" &&
      value.reviewFixWave === MAX_REVIEW_FIX_WAVES
    ) {
      issues.push({
        path: "/reviewFixWave",
        message: "reviewFixWave is only valid for review-fix mode",
      });
    }
  }
  return issues;
}

export function validateResourceArgs(
  phase: unknown,
  value: unknown,
): ValidationResult<ResourceArgs> {
  if (!isResourceArgsPhase(phase)) {
    return {
      ok: false,
      errors: [{ path: "/phase", message: "unknown resource args phase" }],
    };
  }

  const structural = validateSchema(ResourceArgsSchemas[phase], value);
  if (!structural.ok) return { ok: false, errors: structural.errors };

  const nested = phaseNestedIssues(phase, structural.value);
  if (nested.length > 0) return { ok: false, errors: nested };

  const aggregate = jsonBoundIssues(value, {
    maxBytes: MAX_RESOURCE_ARGS_BYTES,
  });
  return aggregate.length > 0
    ? { ok: false, errors: aggregate }
    : { ok: true, value: structural.value, errors: [] };
}

export const validatePhaseArgs = validateResourceArgs;

export type PlanningHumanInput = HumanInputV1;
export type PlanningFeedbackReference = ReferenceValue;
