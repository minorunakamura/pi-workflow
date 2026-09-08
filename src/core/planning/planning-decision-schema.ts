import { Type } from "typebox";

const NonEmptyString = () => Type.String({ minLength: 1 });

export const AcceptanceCriterionSchema = Type.Object(
  {
    id: NonEmptyString(),
    text: NonEmptyString(),
  },
  { additionalProperties: false },
);

export const VerificationSchema = Type.Object(
  {
    id: NonEmptyString(),
    description: NonEmptyString(),
    command: NonEmptyString(),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const WorkUnitSchema = Type.Object(
  {
    id: NonEmptyString(),
    title: NonEmptyString(),
    objective: NonEmptyString(),
    dependsOn: Type.Array(NonEmptyString()),
    writeScope: Type.Array(NonEmptyString()),
    acceptanceCriteriaIds: Type.Array(NonEmptyString()),
    focusedVerificationIds: Type.Array(NonEmptyString()),
  },
  { additionalProperties: false },
);

export const UnresolvedDecisionSchema = Type.Object(
  {
    id: NonEmptyString(),
    question: NonEmptyString(),
    reason: NonEmptyString(),
  },
  { additionalProperties: false },
);

export const PlanningDecisionSchema = Type.Object(
  {
    version: Type.Literal(1),
    requestSummary: NonEmptyString(),
    scope: Type.Object(
      {
        inScope: Type.Array(NonEmptyString()),
        outOfScope: Type.Array(NonEmptyString()),
      },
      { additionalProperties: false },
    ),
    acceptanceCriteria: Type.Array(AcceptanceCriterionSchema),
    constraints: Type.Array(NonEmptyString()),
    risks: Type.Array(NonEmptyString()),
    verification: Type.Array(VerificationSchema),
    implementation: Type.Object(
      {
        mode: Type.Union([Type.Literal("single"), Type.Literal("lanes")]),
        workUnits: Type.Array(WorkUnitSchema, { minItems: 1 }),
        finalVerificationIds: Type.Array(NonEmptyString(), { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
    unresolvedDecisions: Type.Array(UnresolvedDecisionSchema),
  },
  { additionalProperties: false },
);
