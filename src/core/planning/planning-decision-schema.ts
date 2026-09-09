import { Type } from "typebox";
import {
  MAX_PLANNING_ACCEPTANCE_CRITERIA,
  MAX_PLANNING_COMMAND_BYTES,
  MAX_PLANNING_CONSTRAINTS,
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

const Identifier = () =>
  Type.String({ minLength: 1, maxLength: MAX_PLANNING_IDENTIFIER_BYTES });
const CompactText = () =>
  Type.String({ minLength: 1, maxLength: MAX_PLANNING_TEXT_BYTES });
const CommandEntry = () =>
  Type.String({ minLength: 1, maxLength: MAX_PLANNING_COMMAND_BYTES });

export const AcceptanceCriterionSchema = Type.Object(
  {
    id: Identifier(),
    text: CompactText(),
  },
  { additionalProperties: false },
);

export const VerificationSchema = Type.Object(
  {
    id: Identifier(),
    description: CompactText(),
    command: CommandEntry(),
    timeoutMs: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_VERIFICATION_TIMEOUT_MS }),
    ),
  },
  { additionalProperties: false },
);

export const WorkUnitSchema = Type.Object(
  {
    id: Identifier(),
    title: CompactText(),
    objective: CompactText(),
    dependsOn: Type.Array(Identifier(), { maxItems: MAX_WORK_UNIT_REFERENCES }),
    writeScope: Type.Array(CommandEntry(), {
      maxItems: MAX_WORK_UNIT_REFERENCES,
    }),
    acceptanceCriteriaIds: Type.Array(Identifier(), {
      maxItems: MAX_WORK_UNIT_REFERENCES,
    }),
    focusedVerificationIds: Type.Array(Identifier(), {
      maxItems: MAX_WORK_UNIT_REFERENCES,
    }),
  },
  { additionalProperties: false },
);

export const UnresolvedDecisionSchema = Type.Object(
  {
    id: Identifier(),
    question: CompactText(),
    reason: CompactText(),
  },
  { additionalProperties: false },
);

export const PlanningDecisionSchema = Type.Object(
  {
    version: Type.Literal(1),
    requestSummary: CompactText(),
    scope: Type.Object(
      {
        inScope: Type.Array(CompactText(), {
          maxItems: MAX_PLANNING_SCOPE_ITEMS,
        }),
        outOfScope: Type.Array(CompactText(), {
          maxItems: MAX_PLANNING_SCOPE_ITEMS,
        }),
      },
      { additionalProperties: false },
    ),
    acceptanceCriteria: Type.Array(AcceptanceCriterionSchema, {
      maxItems: MAX_PLANNING_ACCEPTANCE_CRITERIA,
    }),
    constraints: Type.Array(CompactText(), {
      maxItems: MAX_PLANNING_CONSTRAINTS,
    }),
    risks: Type.Array(CompactText(), { maxItems: MAX_PLANNING_RISKS }),
    verification: Type.Array(VerificationSchema, {
      maxItems: MAX_PLANNING_VERIFICATIONS,
    }),
    implementation: Type.Object(
      {
        mode: Type.Union([Type.Literal("single"), Type.Literal("lanes")]),
        workUnits: Type.Array(WorkUnitSchema, {
          minItems: 1,
          maxItems: MAX_PLANNING_WORK_UNITS,
        }),
        finalVerificationIds: Type.Array(Identifier(), {
          minItems: 1,
          maxItems: MAX_PLANNING_FINAL_VERIFICATIONS,
        }),
      },
      { additionalProperties: false },
    ),
    unresolvedDecisions: Type.Array(UnresolvedDecisionSchema, {
      maxItems: MAX_UNRESOLVED_DECISIONS,
    }),
  },
  { additionalProperties: false },
);
