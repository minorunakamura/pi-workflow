import { Type, type Static, type TSchema } from "typebox";
import { VerificationSchema } from "../planning/planning-decision-schema";

const NonEmptyString = () => Type.String({ minLength: 1 });
const JsonObjectSchema = Type.Record(Type.String(), Type.Unknown());
const OutputPathSchema = Type.Optional(NonEmptyString());
const CriteriaSchema = Type.Array(NonEmptyString());

export const DiscoveryInputSchema = Type.Object(
  {
    task: NonEmptyString(),
    outputSchema: JsonObjectSchema,
    outputPath: OutputPathSchema,
  },
  { additionalProperties: false },
);

export const ResearchInputSchema = Type.Object(
  {
    task: NonEmptyString(),
    questions: Type.Optional(Type.Array(NonEmptyString())),
    outputPath: OutputPathSchema,
  },
  { additionalProperties: false },
);

export const PlanningInputSchema = Type.Object(
  {
    task: NonEmptyString(),
    outputSchema: JsonObjectSchema,
    outputPath: OutputPathSchema,
  },
  { additionalProperties: false },
);

export const ImplementationInputSchema = Type.Object(
  {
    mode: Type.Union([
      Type.Literal("single"),
      Type.Literal("lanes"),
      Type.Literal("review-fix"),
    ]),
    task: NonEmptyString(),
    criteria: CriteriaSchema,
    focusedVerification: Type.Array(VerificationSchema),
    outputPath: OutputPathSchema,
  },
  { additionalProperties: false },
);

export const VerificationInputSchema = Type.Object(
  {
    task: NonEmptyString(),
    criteria: CriteriaSchema,
    finalVerificationCommands: Type.Array(VerificationSchema, { minItems: 1 }),
    outputPath: OutputPathSchema,
  },
  { additionalProperties: false },
);

export const VerificationFixInputSchema = Type.Object(
  {
    task: NonEmptyString(),
    failureEvidence: JsonObjectSchema,
    allowedWriteScope: Type.Array(NonEmptyString(), { minItems: 1 }),
    outputPath: OutputPathSchema,
  },
  { additionalProperties: false },
);

export const ReviewInputSchema = Type.Object(
  {
    correctnessTask: NonEmptyString(),
    simplicityTask: NonEmptyString(),
    synthesisTask: NonEmptyString(),
    reviewDecisionSchema: JsonObjectSchema,
    outputPath: OutputPathSchema,
  },
  { additionalProperties: false },
);

export const PHASE_NAMES = [
  "discovery",
  "research",
  "planning",
  "implementation",
  "verification",
  "verification-fix",
  "review",
] as const;

export type PhaseName = (typeof PHASE_NAMES)[number];

export const PhaseSchemas = {
  discovery: DiscoveryInputSchema,
  research: ResearchInputSchema,
  planning: PlanningInputSchema,
  implementation: ImplementationInputSchema,
  verification: VerificationInputSchema,
  "verification-fix": VerificationFixInputSchema,
  review: ReviewInputSchema,
} as const satisfies Record<PhaseName, TSchema>;

export type DiscoveryInput = Static<typeof DiscoveryInputSchema>;
export type ResearchInput = Static<typeof ResearchInputSchema>;
export type PlanningInput = Static<typeof PlanningInputSchema>;
export type ImplementationInput = Static<typeof ImplementationInputSchema>;
export type VerificationInput = Static<typeof VerificationInputSchema>;
export type VerificationFixInput = Static<typeof VerificationFixInputSchema>;
export type ReviewInput = Static<typeof ReviewInputSchema>;

export type PhaseInput =
  | DiscoveryInput
  | ResearchInput
  | PlanningInput
  | ImplementationInput
  | VerificationInput
  | VerificationFixInput
  | ReviewInput;
