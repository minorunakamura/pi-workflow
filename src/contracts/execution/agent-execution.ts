import type { ExecutionId, RunId, StepId } from "../../domain/primitives/ids.js";

export const AGENT_EXECUTION_MODES = ["read-only", "write", "verify-only"] as const;
export type AgentExecutionMode = (typeof AGENT_EXECUTION_MODES)[number];

export const AGENT_OUTCOMES = ["completed", "blocked", "failed"] as const;
export type AgentOutcome = (typeof AGENT_OUTCOMES)[number];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

export type SkillReference = Readonly<{
  id: string;
  version: string;
}>;

export type AgentExecutionIdentity = Readonly<{
  runId: RunId;
  stepId: StepId;
  executionId: ExecutionId;
  agentId: string;
  agentVersion: string;
}>;

export type AgentExecutionRequestV1 = Readonly<{
  identity: AgentExecutionIdentity;
  objective: Readonly<{
    objective: string;
    type: string;
    completionCriteria: readonly string[];
  }>;
  retry: Readonly<{
    attempt: number;
    context: JsonValue;
  }>;
  execution: Readonly<{
    mode: AgentExecutionMode;
    timeoutMs: number;
    cancellationPolicy: JsonValue;
  }>;
  authority: Readonly<{
    maximumDLevel: string;
    escalationRules: readonly JsonValue[];
  }>;
  permissions: Readonly<{
    filesystem: readonly JsonValue[];
    shell: readonly JsonValue[];
    git: readonly JsonValue[];
    network: readonly JsonValue[];
    repositoryTargets: readonly JsonValue[];
  }>;
  skills: Readonly<{
    required: readonly SkillReference[];
    optional: readonly SkillReference[];
  }>;
  tools: Readonly<{
    resolved: readonly JsonValue[];
    policy: JsonValue;
  }>;
  model: Readonly<{
    requested: JsonValue;
    actual: JsonValue;
    thinkingLevel: string;
    allowedFallback: readonly JsonValue[];
  }>;
  context: Readonly<{
    pack: JsonObject;
    manifest: JsonObject;
    artifactRefs: readonly string[];
  }>;
  outputs: Readonly<{
    expectedArtifactTypes: readonly string[];
    outputContract: JsonValue;
  }>;
}>;

export type StepResultIdentity = Readonly<{
  runId: RunId;
  stepId: StepId;
  executionId: ExecutionId;
}>;

export type ResultCandidate = JsonObject;

export type StepResultV1 = Readonly<{
  identity: StepResultIdentity;
  outcome: AgentOutcome;
  mode?: AgentExecutionMode;
  summary: string;
  artifacts: readonly JsonValue[];
  uncertainty_candidates: readonly ResultCandidate[];
  decision_requests: readonly ResultCandidate[];
  requirement_candidates: Readonly<{
    acceptance_criteria: readonly ResultCandidate[];
    constraints: readonly ResultCandidate[];
    assumptions: readonly ResultCandidate[];
  }>;
  finding_candidates: readonly ResultCandidate[];
  finding_rechecks: readonly ResultCandidate[];
  plan_deviations: readonly ResultCandidate[];
  skill_requests: readonly ResultCandidate[];
  execution_checks: readonly ResultCandidate[];
  observations: readonly ResultCandidate[];
  blocked: JsonObject | null;
  failure: JsonObject | null;
  runtime: JsonObject;
}>;

export type ContractIssue = Readonly<{
  path: string;
  expected: string;
}>;

export class ContractValidationError extends Error {
  readonly contract: string;
  readonly issues: readonly ContractIssue[];

  constructor(contract: string, issue: ContractIssue) {
    super(`${contract} validation failed at ${issue.path || "<root>"}: expected ${issue.expected}`);
    this.name = "ContractValidationError";
    this.contract = contract;
    this.issues = [issue];
  }
}

export type SafeParseResult<T> =
  | Readonly<{ success: true; data: T }>
  | Readonly<{ success: false; error: ContractValidationError }>;

export interface RuntimeSchema<T> {
  parse(input: unknown): T;
  safeParse(input: unknown): SafeParseResult<T>;
}

const REQUEST_CONTRACT = "AgentExecutionRequestV1";
const RESULT_CONTRACT = "StepResultV1";
const AUTHORITATIVE_STATE_ID = /^(?:run|step|exec)-\d+$|^(?:U|D|G|F|P|V|PD|CS|VR|RR|AC|C)-\d+$/;

export const STEP_RESULT_AGENT_OUTPUT_GROUPS = [
  "uncertainty_candidates",
  "decision_requests",
  "requirement_candidates.acceptance_criteria",
  "requirement_candidates.constraints",
  "requirement_candidates.assumptions",
  "finding_candidates",
  "finding_rechecks",
  "plan_deviations",
  "skill_requests",
  "execution_checks",
  "observations",
] as const;

export const STEP_RESULT_REQUIREMENT_CANDIDATE_OPERATIONS = ["add", "clarify"] as const;
export const STEP_RESULT_REQUIREMENT_CANDIDATE_EFFECTS = [
  "preserving",
  "narrowing",
  "broadening",
  "changing",
] as const;
export const STEP_RESULT_REQUIREMENT_ELEMENT_KINDS = [
  "acceptanceCriteria",
  "constraints",
  "assumptions",
] as const;
export const STEP_RESULT_UNCERTAINTY_CATEGORIES = [
  "requirement",
  "behavior",
  "design",
  "external",
  "impact",
  "verification",
] as const;
export const STEP_RESULT_DECISION_CLASSES = ["D1", "D2", "D3"] as const;
export const STEP_RESULT_USER_INTERACTION_KINDS = ["approval", "options", "custom"] as const;
export const STEP_RESULT_FINDING_STATES = ["open", "resolved"] as const;
export const STEP_RESULT_FINDING_DISPOSITIONS = [
  "pending",
  "fix-required",
  "accepted",
  "fixed",
  "dismissed",
] as const;
export const STEP_RESULT_FINDING_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const STEP_RESULT_FINDING_CONFIDENCES = ["high", "medium", "low"] as const;
export const STEP_RESULT_FINDING_RECHECK_ACTIONS = ["fix", "dismiss", "reopen"] as const;
export const STEP_RESULT_VERIFICATION_CHECK_STATUSES = [
  "passed",
  "failed",
  "skipped",
  "unavailable",
] as const;
export const STEP_RESULT_VERIFICATION_CHECK_TYPES = [
  "test",
  "build",
  "lint",
  "typecheck",
  "format",
  "behavior",
  "regression",
  "inspection",
  "manual",
] as const;
export const STEP_RESULT_OBSERVATION_CLASSIFICATIONS = [
  "Fact",
  "Inference",
  "Assumption",
  "Recommendation",
] as const;
export const STEP_RESULT_BLOCKED_CLASSIFICATIONS = [
  "user-input-required",
  "decision-pending",
  "approval-pending",
  "uncertainty-unresolved",
  "environment-unavailable",
  "repository-drift",
  "recovery-required",
  "dependency-unavailable",
  "external-condition",
] as const;
export const STEP_RESULT_ERROR_CATEGORIES = [
  "configuration",
  "state",
  "runtime",
  "agent",
  "tool",
  "validation",
  "permission",
  "concurrency",
  "graph",
  "context",
  "artifact",
] as const;
export const STEP_RESULT_AGENT_ARTIFACT_TYPES = ["analysis", "research"] as const;
export const STEP_RESULT_ARTIFACT_STATUSES = ["complete", "partial"] as const;

const REQUIREMENT_CANDIDATE_OPERATIONS = STEP_RESULT_REQUIREMENT_CANDIDATE_OPERATIONS;
const REQUIREMENT_CANDIDATE_EFFECTS = STEP_RESULT_REQUIREMENT_CANDIDATE_EFFECTS;

const nonEmptyStringSchema = { type: "string", minLength: 1 } as const;
const stringArraySchema = { type: "array", items: nonEmptyStringSchema } as const;
const nonEmptyStringArraySchema = { ...stringArraySchema, minItems: 1 } as const;
const jsonValueSchema = {} as const;
const evidenceSchema = {
  anyOf: [
    nonEmptyStringSchema,
    { type: "array", items: jsonValueSchema },
    { type: "object", additionalProperties: true },
  ],
  description: "Evidence value; it may contain references but does not allocate identity.",
} as const;

function enumSchema<T extends readonly string[]>(values: T): Readonly<{ enum: T }> {
  return { enum: values };
}

const candidateCommonProperties = {
  localId: nonEmptyStringSchema,
  summary: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  statement: nonEmptyStringSchema,
  question: nonEmptyStringSchema,
  subject: nonEmptyStringSchema,
  topic: nonEmptyStringSchema,
  basis: evidenceSchema,
  evidence: evidenceSchema,
  impact: nonEmptyStringSchema,
  confidence: enumSchema(STEP_RESULT_FINDING_CONFIDENCES),
  needed_evidence: evidenceSchema,
  rationale: nonEmptyStringSchema,
  recommendation: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
  location: evidenceSchema,
  source: evidenceSchema,
  label: nonEmptyStringSchema,
  text: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  check: nonEmptyStringSchema,
  result: jsonValueSchema,
  command: nonEmptyStringSchema,
  write_scope: stringArraySchema,
  skill: nonEmptyStringSchema,
  skill_id: nonEmptyStringSchema,
  version: nonEmptyStringSchema,
  required: { type: "boolean" },
  value: jsonValueSchema,
  category: nonEmptyStringSchema,
} as const;
const CANDIDATE_COMMON_KEYS = Object.keys(candidateCommonProperties);
const DECISION_CANDIDATE_KEYS = [
  ...CANDIDATE_COMMON_KEYS,
  "class",
  "kind",
  "title",
  "message",
  "options",
  "placeholder",
];
const REQUIREMENT_CANDIDATE_KEYS = [
  ...CANDIDATE_COMMON_KEYS,
  "operation",
  "effect",
  "kind",
  "targetId",
  "targetIndex",
  "goal",
  "constraint",
];
const FINDING_CANDIDATE_KEYS = [...CANDIDATE_COMMON_KEYS, "severity"];
const FINDING_RECHECK_KEYS = [
  ...CANDIDATE_COMMON_KEYS,
  "findingId",
  "finding_id",
  "action",
  "state",
  "disposition",
];
const EXECUTION_CHECK_KEYS = [...CANDIDATE_COMMON_KEYS, "type", "status"];
const OBSERVATION_KEYS = [...CANDIDATE_COMMON_KEYS, "kind", "classification"];
const PLAN_DEVIATION_KEYS = [
  ...CANDIDATE_COMMON_KEYS,
  "plan",
  "unit",
  "required_action",
  "affected_areas",
];
const SKILL_REQUEST_KEYS = [...CANDIDATE_COMMON_KEYS, "skillId"];

function candidateObjectSchema(
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): JsonObject {
  return {
    type: "object",
    description,
    properties: properties as JsonObject,
    required,
    additionalProperties: false,
  } as JsonObject;
}

const uncertaintyCandidateSchema = candidateObjectSchema(
  "Uncertainty candidate: semantic evidence only; the Orchestrator allocates U-* and status.",
  {
    ...candidateCommonProperties,
    category: enumSchema(STEP_RESULT_UNCERTAINTY_CATEGORIES),
  },
  ["category"],
);

const decisionD1D2CandidateSchema = candidateObjectSchema(
  "Decision request candidate; D1/D2 authority remains outside the Agent.",
  {
    ...candidateCommonProperties,
    class: enumSchema(["D1", "D2"] as const),
  },
  ["class"],
);

const decisionD3BaseProperties = {
  ...candidateCommonProperties,
  class: enumSchema(["D3"] as const),
  title: nonEmptyStringSchema,
  message: nonEmptyStringSchema,
} as const;
const decisionD3ApprovalSchema = candidateObjectSchema(
  "D3 approval request routed through the Orchestrator to the User.",
  { ...decisionD3BaseProperties, kind: enumSchema(["approval"] as const) },
  ["class", "kind", "title", "message"],
);
const decisionD3OptionsSchema = candidateObjectSchema(
  "D3 options request routed through the Orchestrator to the User.",
  {
    ...decisionD3BaseProperties,
    kind: enumSchema(["options"] as const),
    options: nonEmptyStringArraySchema,
  },
  ["class", "kind", "title", "message", "options"],
);
const decisionD3CustomSchema = candidateObjectSchema(
  "D3 custom request routed through the Orchestrator to the User.",
  {
    ...decisionD3BaseProperties,
    kind: enumSchema(["custom"] as const),
    placeholder: nonEmptyStringSchema,
  },
  ["class", "kind", "title", "message"],
);
const decisionRequestSchema = {
  oneOf: [
    decisionD1D2CandidateSchema,
    decisionD3ApprovalSchema,
    decisionD3OptionsSchema,
    decisionD3CustomSchema,
  ],
  description: "Decision request candidate with an Orchestrator-allocated D-* identity.",
} as const;

const requirementCandidateProperties = {
  ...candidateCommonProperties,
  goal: nonEmptyStringSchema,
  constraint: nonEmptyStringSchema,
  effect: enumSchema(STEP_RESULT_REQUIREMENT_CANDIDATE_EFFECTS),
} as const;

function requirementCandidateSchema(
  description: string,
  kind: (typeof STEP_RESULT_REQUIREMENT_ELEMENT_KINDS)[number],
  targetKey: "targetId" | "targetIndex",
  target: Record<string, unknown>,
): JsonObject {
  const add = candidateObjectSchema(
    `${description} operation=add has no existing-element target.`,
    {
      ...requirementCandidateProperties,
      operation: enumSchema(["add"] as const),
      kind: enumSchema([kind] as const),
    },
    ["operation", "effect"],
  );
  const clarify = candidateObjectSchema(
    `${description} operation=clarify requires its existing-element reference.`,
    {
      ...requirementCandidateProperties,
      operation: enumSchema(["clarify"] as const),
      kind: enumSchema([kind] as const),
      [targetKey]: target,
    },
    ["operation", "effect", targetKey],
  );
  return {
    oneOf: [add, clarify],
    description,
  } as JsonObject;
}

const acceptanceCriterionCandidateSchema = requirementCandidateSchema(
  "Acceptance Criterion candidate. targetId may reference an existing AC-* only.",
  "acceptanceCriteria",
  "targetId",
  { type: "string", pattern: "^AC-0*[1-9][0-9]*$" },
);
const constraintCandidateSchema = requirementCandidateSchema(
  "Constraint candidate. targetId may reference an existing C-* only.",
  "constraints",
  "targetId",
  { type: "string", pattern: "^C-0*[1-9][0-9]*$" },
);
const assumptionCandidateSchema = requirementCandidateSchema(
  "Assumption candidate. targetIndex may reference an existing assumption position.",
  "assumptions",
  "targetIndex",
  { type: "integer", minimum: 0 },
);

const findingCandidateSchema = candidateObjectSchema(
  "Finding candidate; the Orchestrator allocates F-* and chooses state/disposition.",
  {
    ...candidateCommonProperties,
    severity: enumSchema(STEP_RESULT_FINDING_SEVERITIES),
    confidence: enumSchema(STEP_RESULT_FINDING_CONFIDENCES),
  },
  ["severity", "confidence"],
);

const findingRecheckBaseProperties = {
  ...candidateCommonProperties,
  action: enumSchema(STEP_RESULT_FINDING_RECHECK_ACTIONS),
  state: enumSchema(STEP_RESULT_FINDING_STATES),
  disposition: enumSchema(STEP_RESULT_FINDING_DISPOSITIONS),
} as const;
const findingRecheckSchema = {
  oneOf: [
    candidateObjectSchema(
      "Finding recheck referencing an existing F-* Finding; this preserves that identity.",
      {
        ...findingRecheckBaseProperties,
        findingId: { type: "string", pattern: "^F-0*[1-9][0-9]*$" },
      },
      ["findingId"],
    ),
    candidateObjectSchema(
      "Finding recheck referencing an existing F-* Finding; this preserves that identity.",
      {
        ...findingRecheckBaseProperties,
        finding_id: { type: "string", pattern: "^F-0*[1-9][0-9]*$" },
      },
      ["finding_id"],
    ),
  ],
  description:
    "Exactly one of findingId or finding_id is required; it is an existing reference, not a new identity.",
} as const;

const planDeviationProperties = {
  ...candidateCommonProperties,
  plan: jsonValueSchema,
  unit: nonEmptyStringSchema,
  required_action: nonEmptyStringSchema,
  affected_areas: stringArraySchema,
} as const;
const planDeviationSchema = candidateObjectSchema(
  "Plan deviation candidate; the Orchestrator allocates PD-* and evaluates applicability.",
  planDeviationProperties,
);
const skillRequestProperties = {
  ...candidateCommonProperties,
  skillId: nonEmptyStringSchema,
} as const;
const skillRequestSchema = candidateObjectSchema(
  "Skill request candidate; the Orchestrator validates allowlists and selection.",
  skillRequestProperties,
);
const executionCheckSchema = candidateObjectSchema(
  "Verification check candidate with the finite Verification Check type/status vocabulary.",
  {
    ...candidateCommonProperties,
    type: enumSchema(STEP_RESULT_VERIFICATION_CHECK_TYPES),
    status: enumSchema(STEP_RESULT_VERIFICATION_CHECK_STATUSES),
    required: { type: "boolean" },
  },
  ["type", "status", "required"],
);
const observationSchema = candidateObjectSchema(
  "Observation evidence; classification uses the SOT Fact/Inference/Assumption/Recommendation labels when supplied.",
  {
    ...candidateCommonProperties,
    kind: enumSchema(STEP_RESULT_OBSERVATION_CLASSIFICATIONS),
    classification: enumSchema(STEP_RESULT_OBSERVATION_CLASSIFICATIONS),
  },
);

const artifactReferenceSchema = {
  type: "object",
  description:
    "Existing finalized Artifact reference; the runtime validates its Run-relative path.",
  properties: {
    runId: { type: "string", pattern: "^run-0*[1-9][0-9]*$" },
    path: nonEmptyStringSchema,
    status: enumSchema(STEP_RESULT_ARTIFACT_STATUSES),
  },
  required: ["runId", "path", "status"],
  additionalProperties: false,
} as const;
const artifactDraftSchema = {
  type: "object",
  description:
    "Agent Artifact draft. The Orchestrator adds front matter, redacts, validates, and finalizes it.",
  properties: {
    type: enumSchema(STEP_RESULT_AGENT_ARTIFACT_TYPES),
    purpose: nonEmptyStringSchema,
    content: nonEmptyStringSchema,
  },
  required: ["type", "purpose", "content"],
  additionalProperties: false,
} as const;
const artifactItemSchema = {
  anyOf: [artifactDraftSchema, artifactReferenceSchema],
  description:
    "Agent drafts are preferred; finalized references are accepted only as existing refs.",
} as const;

const blockedSchema = {
  type: "object",
  description: "Structured blocked information; the Orchestrator routes the blocker.",
  properties: {
    reason: nonEmptyStringSchema,
    classification: enumSchema(STEP_RESULT_BLOCKED_CLASSIFICATIONS),
    reference: nonEmptyStringSchema,
    ref: nonEmptyStringSchema,
    step_id: { type: "string", pattern: "^step-0*[1-9][0-9]*$" },
    decision_id: { type: "string", pattern: "^D-0*[1-9][0-9]*$" },
    uncertainty_id: { type: "string", pattern: "^U-0*[1-9][0-9]*$" },
    evidence: evidenceSchema,
  },
  required: ["reason"],
  additionalProperties: false,
} as const;
const failureSchema = {
  type: "object",
  description:
    "Structured Agent failure information; the Orchestrator owns recovery/failure policy.",
  properties: {
    reason: nonEmptyStringSchema,
    message: nonEmptyStringSchema,
    category: enumSchema(STEP_RESULT_ERROR_CATEGORIES),
    code: nonEmptyStringSchema,
    retryable: { type: "boolean" },
    recoverable: { type: "boolean" },
    reference: nonEmptyStringSchema,
    ref: nonEmptyStringSchema,
    evidence: evidenceSchema,
    details: jsonValueSchema,
  },
  required: ["reason"],
  additionalProperties: false,
} as const;
const runtimeSchema = {
  type: "object",
  description:
    "Optional Agent runtime metadata. Adapter telemetry is runtime-owned and appended after validation.",
  properties: {
    model: nonEmptyStringSchema,
    provider: nonEmptyStringSchema,
    tool_calls: stringArraySchema,
    tools_used: stringArraySchema,
    repository_root: nonEmptyStringSchema,
    read_only: { type: "boolean" },
    recoveryAttempt: { type: "integer", minimum: 0 },
    attempt: { type: "integer", minimum: 0 },
    tool_mode: nonEmptyStringSchema,
    commands_executed: stringArraySchema,
    shell_available: { type: "boolean" },
  },
  required: [],
  additionalProperties: false,
} as const;

export const STEP_RESULT_AGENT_OUTPUT_CONTRACT = {
  type: "object",
  title: "StepResultV1",
  description:
    "StepResultV1 from an Agent. Field shapes and finite values below are the LLM-facing contract; runtime validation remains authoritative.",
  candidateGroups: STEP_RESULT_AGENT_OUTPUT_GROUPS,
  candidateIdentity: "semantic-only; no Agent-generated authoritative identity",
  forbiddenFields: ["id", "authoritative_id", "state_id"],
  forbiddenAuthoritativePrefixes: [
    "U-*",
    "D-*",
    "F-*",
    "PD-*",
    "CS-*",
    "VR-*",
    "RR-*",
    "AC-*",
    "C-*",
    "G-*",
    "P-*",
    "V-*",
  ],
  allowedReferences: [
    "requirement_candidates.acceptance_criteria[].targetId → existing AC-*",
    "requirement_candidates.constraints[].targetId → existing C-*",
    "finding_rechecks[].findingId|finding_id → existing F-*",
    "evidence/basis may cite existing IDs without allocating them",
  ],
  findingRecheckReference:
    "findingId or finding_id may reference an existing F-* Finding only; it is not a new candidate identity",
  authoritativeAllocation:
    "Orchestrator normalization allocates identity after StepResultV1 validation",
  properties: {
    identity: {
      type: "object",
      description: "Execution identity supplied by the Orchestrator; preserve it exactly.",
      properties: {
        runId: { type: "string", pattern: "^run-0*[1-9][0-9]*$" },
        stepId: { type: "string", pattern: "^step-0*[1-9][0-9]*$" },
        executionId: { type: "string", pattern: "^exec-0*[1-9][0-9]*$" },
      },
      required: ["runId", "stepId", "executionId"],
      additionalProperties: false,
    },
    outcome: enumSchema(AGENT_OUTCOMES),
    mode: enumSchema(AGENT_EXECUTION_MODES),
    summary: nonEmptyStringSchema,
    artifacts: { type: "array", items: artifactItemSchema },
    uncertainty_candidates: { type: "array", items: uncertaintyCandidateSchema },
    decision_requests: { type: "array", items: decisionRequestSchema },
    requirement_candidates: {
      type: "object",
      properties: {
        acceptance_criteria: { type: "array", items: acceptanceCriterionCandidateSchema },
        constraints: { type: "array", items: constraintCandidateSchema },
        assumptions: { type: "array", items: assumptionCandidateSchema },
      },
      required: ["acceptance_criteria", "constraints", "assumptions"],
      additionalProperties: false,
    },
    finding_candidates: { type: "array", items: findingCandidateSchema },
    finding_rechecks: { type: "array", items: findingRecheckSchema },
    plan_deviations: { type: "array", items: planDeviationSchema },
    skill_requests: { type: "array", items: skillRequestSchema },
    execution_checks: { type: "array", items: executionCheckSchema },
    observations: { type: "array", items: observationSchema },
    blocked: { anyOf: [blockedSchema, { type: "null" }] },
    failure: { anyOf: [failureSchema, { type: "null" }] },
    runtime: runtimeSchema,
  },
  required: [
    "identity",
    "outcome",
    "summary",
    "artifacts",
    "uncertainty_candidates",
    "decision_requests",
    "requirement_candidates",
    "finding_candidates",
    "finding_rechecks",
    "plan_deviations",
    "skill_requests",
    "execution_checks",
    "observations",
    "blocked",
    "failure",
    "runtime",
  ],
  additionalProperties: false,
} as const;

export const STEP_RESULT_AGENT_OUTPUT_INSTRUCTIONS = [
  "StepResultV1 field-level output contract is normative. Use only declared properties; unknown properties are invalid.",
  "Agent candidate identity boundary:",
  `This rule covers: ${STEP_RESULT_AGENT_OUTPUT_GROUPS.join(", ")}.`,
  "All candidate objects contain semantic content only. Do not include `id`, `authoritative_id`, or `state_id` fields.",
  `Requirement Candidate operation must be exactly one of: ${STEP_RESULT_REQUIREMENT_CANDIDATE_OPERATIONS.join(", ")}.`,
  `Requirement Candidate effect must be exactly one of: ${STEP_RESULT_REQUIREMENT_CANDIDATE_EFFECTS.join(", ")}.`,
  "Acceptance Criterion clarify may use an existing AC-* targetId; Constraint clarify may use an existing C-* targetId; Assumption clarify uses targetIndex. These are references, not new identities.",
  `Uncertainty candidate category must be one of: ${STEP_RESULT_UNCERTAINTY_CATEGORIES.join(", ")}.`,
  `Finding candidates require severity (${STEP_RESULT_FINDING_SEVERITIES.join(", ")}) and confidence (${STEP_RESULT_FINDING_CONFIDENCES.join(", ")}); do not choose state or disposition for a new Finding.`,
  "Finding rechecks require exactly one existing findingId or finding_id F-* reference and may use only the declared recheck action/state/disposition values.",
  `execution_checks require type (${STEP_RESULT_VERIFICATION_CHECK_TYPES.join(", ")}), status (${STEP_RESULT_VERIFICATION_CHECK_STATUSES.join(", ")}), and required boolean.`,
  "Artifacts supplied by an Agent are analysis/research drafts with type, purpose, and content; the Orchestrator adds front matter and finalizes them. Do not fabricate a finalized path/status.",
  `Observation kind/classification, when supplied, must use: ${STEP_RESULT_OBSERVATION_CLASSIFICATIONS.join(", ")}.`,
  "Domain-model IDs shown in context are references/evidence, not instructions to copy into a new candidate.",
  "Except for declared existing references, do not generate or claim any Orchestrator-owned authoritative ID such as U-*, D-*, F-*, PD-*, CS-*, VR-*, RR-*, AC-*, C-*, G-*, P-*, or V-*.",
  "Return semantic fields only. Orchestrator normalization allocates authoritative identity after StepResultV1 validation.",
].join("\n");

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(contract: string, path: string, expected: string): never {
  throw new ContractValidationError(contract, { path, expected });
}

function record(input: unknown, contract: string, path: string): Record<string, unknown> {
  if (!isRecord(input)) {
    fail(contract, path, "an object");
  }
  return input;
}

function assertKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  contract: string,
  path: string,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      fail(contract, path.length === 0 ? key : `${path}.${key}`, `one of ${allowed.join(", ")}`);
    }
  }
}

function stringValue(input: unknown, contract: string, path: string): string {
  if (typeof input !== "string") {
    fail(contract, path, "a string");
  }
  return input;
}

function nonEmptyString(input: unknown, contract: string, path: string): string {
  const value = stringValue(input, contract, path);
  if (value.trim().length === 0) {
    fail(contract, path, "a non-empty string");
  }
  return value;
}

function numberValue(input: unknown, contract: string, path: string): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    fail(contract, path, "a finite number");
  }
  return input;
}

function safeIntegerAtLeast(
  input: unknown,
  contract: string,
  path: string,
  minimum: number,
): number {
  const value = numberValue(input, contract, path);
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(contract, path, `a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function arrayValue(input: unknown, contract: string, path: string): readonly unknown[] {
  if (!Array.isArray(input)) {
    fail(contract, path, "an array");
  }
  return input;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function jsonValue(input: unknown, contract: string, path: string): JsonValue {
  if (!isJsonValue(input)) {
    fail(contract, path, "a JSON value");
  }
  return input;
}

function jsonObject(input: unknown, contract: string, path: string): JsonObject {
  const value = record(input, contract, path);
  for (const key of Object.keys(value)) {
    jsonValue(value[key], contract, `${path}.${key}`);
  }
  return value as JsonObject;
}

function jsonArray(input: unknown, contract: string, path: string): readonly JsonValue[] {
  const value = arrayValue(input, contract, path);
  return value.map((entry, index) => jsonValue(entry, contract, `${path}[${index}]`));
}

function stringArray(input: unknown, contract: string, path: string): readonly string[] {
  const value = arrayValue(input, contract, path);
  return value.map((entry, index) => nonEmptyString(entry, contract, `${path}[${index}]`));
}

function skillReferences(
  input: unknown,
  contract: string,
  path: string,
): readonly SkillReference[] {
  const value = arrayValue(input, contract, path);
  return value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const item = record(entry, contract, itemPath);
    return {
      id: nonEmptyString(item.id, contract, `${itemPath}.id`),
      version: nonEmptyString(item.version, contract, `${itemPath}.version`),
    };
  });
}

function idValue(
  input: unknown,
  contract: string,
  path: string,
  prefix: "run" | "step" | "exec",
): string {
  const value = nonEmptyString(input, contract, path);
  if (!new RegExp(`^${prefix}-\\d+$`).test(value)) {
    fail(contract, path, `${prefix}-<number> identity`);
  }
  return value;
}

function requestIdentity(input: unknown): AgentExecutionIdentity {
  const value = record(input, REQUEST_CONTRACT, "identity");
  return {
    runId: idValue(value.runId, REQUEST_CONTRACT, "identity.runId", "run") as RunId,
    stepId: idValue(value.stepId, REQUEST_CONTRACT, "identity.stepId", "step") as StepId,
    executionId: idValue(
      value.executionId,
      REQUEST_CONTRACT,
      "identity.executionId",
      "exec",
    ) as ExecutionId,
    agentId: nonEmptyString(value.agentId, REQUEST_CONTRACT, "identity.agentId"),
    agentVersion: nonEmptyString(value.agentVersion, REQUEST_CONTRACT, "identity.agentVersion"),
  };
}

function resultIdentity(input: unknown): StepResultIdentity {
  const value = record(input, RESULT_CONTRACT, "identity");
  return {
    runId: idValue(value.runId, RESULT_CONTRACT, "identity.runId", "run") as RunId,
    stepId: idValue(value.stepId, RESULT_CONTRACT, "identity.stepId", "step") as StepId,
    executionId: idValue(
      value.executionId,
      RESULT_CONTRACT,
      "identity.executionId",
      "exec",
    ) as ExecutionId,
  };
}

function modeValue(input: unknown, contract: string, path: string): AgentExecutionMode {
  const value = stringValue(input, contract, path);
  if (!(AGENT_EXECUTION_MODES as readonly string[]).includes(value)) {
    fail(contract, path, `one of ${AGENT_EXECUTION_MODES.join(", ")}`);
  }
  return value as AgentExecutionMode;
}

function outcomeValue(input: unknown): AgentOutcome {
  const value = stringValue(input, RESULT_CONTRACT, "outcome");
  if (!(AGENT_OUTCOMES as readonly string[]).includes(value)) {
    fail(RESULT_CONTRACT, "outcome", `one of ${AGENT_OUTCOMES.join(", ")}`);
  }
  return value as AgentOutcome;
}

function enumCandidateValue<T extends readonly string[]>(
  candidate: ResultCandidate,
  key: string,
  values: T,
  path: string,
): T[number] {
  const value = stringValue(candidate[key], RESULT_CONTRACT, path);
  if (!(values as readonly string[]).includes(value)) {
    fail(RESULT_CONTRACT, path, `one of ${values.join(", ")}`);
  }
  return value as T[number];
}

function nullableStructuredObject(
  input: unknown,
  contract: string,
  path: string,
): JsonObject | null {
  if (input === null) {
    return null;
  }
  const value = jsonObject(input, contract, path);
  if (Object.keys(value).length === 0) {
    fail(contract, path, "a non-empty object or null");
  }
  nonEmptyString(value.reason, contract, `${path}.reason`);
  if (path === "blocked" && value.classification !== undefined) {
    const classification = stringValue(value.classification, contract, `${path}.classification`);
    if (!(STEP_RESULT_BLOCKED_CLASSIFICATIONS as readonly string[]).includes(classification)) {
      fail(
        contract,
        `${path}.classification`,
        `one of ${STEP_RESULT_BLOCKED_CLASSIFICATIONS.join(", ")}`,
      );
    }
  }
  if (path === "failure" && value.category !== undefined) {
    const category = stringValue(value.category, contract, `${path}.category`);
    if (!(STEP_RESULT_ERROR_CATEGORIES as readonly string[]).includes(category)) {
      fail(contract, `${path}.category`, `one of ${STEP_RESULT_ERROR_CATEGORIES.join(", ")}`);
    }
  }
  return value;
}

function artifactStatusValue(
  input: unknown,
  path: string,
): (typeof STEP_RESULT_ARTIFACT_STATUSES)[number] {
  const value = stringValue(input, RESULT_CONTRACT, path);
  if (!(STEP_RESULT_ARTIFACT_STATUSES as readonly string[]).includes(value)) {
    fail(RESULT_CONTRACT, path, `one of ${STEP_RESULT_ARTIFACT_STATUSES.join(", ")}`);
  }
  return value as (typeof STEP_RESULT_ARTIFACT_STATUSES)[number];
}

function artifactArray(input: unknown, contract: string, path: string): readonly JsonValue[] {
  const value = arrayValue(input, contract, path);
  return value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const artifact = jsonObject(entry, contract, itemPath);
    const isReference = "runId" in artifact || "path" in artifact || "status" in artifact;
    if (isReference) {
      idValue(artifact.runId, contract, `${itemPath}.runId`, "run");
      nonEmptyString(artifact.path, contract, `${itemPath}.path`);
      artifactStatusValue(artifact.status, `${itemPath}.status`);
      if (Object.keys(artifact).some((key) => !["runId", "path", "status"].includes(key))) {
        fail(
          contract,
          itemPath,
          "a finalized Artifact reference with only runId, path, and status",
        );
      }
      return artifact;
    }

    for (const key of Object.keys(artifact)) {
      if (!["type", "purpose", "content"].includes(key)) {
        fail(
          contract,
          `${itemPath}.${key}`,
          "only type, purpose, and content in an Agent Artifact draft",
        );
      }
    }
    const type = stringValue(artifact.type, contract, `${itemPath}.type`);
    if (!(STEP_RESULT_AGENT_ARTIFACT_TYPES as readonly string[]).includes(type)) {
      fail(contract, `${itemPath}.type`, `one of ${STEP_RESULT_AGENT_ARTIFACT_TYPES.join(", ")}`);
    }
    nonEmptyString(artifact.purpose, contract, `${itemPath}.purpose`);
    nonEmptyString(artifact.content, contract, `${itemPath}.content`);
    return artifact;
  });
}

function candidateArray(
  input: unknown,
  contract: string,
  path: string,
  allowedReferenceKeys: readonly string[] = [],
  allowedKeys: readonly string[] = CANDIDATE_COMMON_KEYS,
): readonly ResultCandidate[] {
  const value = arrayValue(input, contract, path);
  const allowed = new Set(allowedReferenceKeys);
  return value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const candidate = jsonObject(entry, contract, itemPath);
    const identityFree = Object.fromEntries(
      Object.entries(candidate).filter(([key]) => !allowed.has(key)),
    ) as JsonObject;
    const stateIdPath = findAuthoritativeStateId(identityFree, itemPath);
    if (stateIdPath) {
      fail(contract, stateIdPath, "no authoritative State ID in an Agent candidate");
    }
    for (const key of ["id", "authoritative_id", "state_id"] as const) {
      if (key in candidate) {
        fail(contract, `${itemPath}.${key}`, "no Agent-generated candidate identity field");
      }
    }
    assertKeys(candidate, allowedKeys, contract, itemPath);
    return candidate;
  });
}

function uncertaintyCandidateArray(input: unknown, path: string): readonly ResultCandidate[] {
  const candidates = candidateArray(input, RESULT_CONTRACT, path);
  return candidates.map((candidate, index) => {
    enumCandidateValue(
      candidate,
      "category",
      STEP_RESULT_UNCERTAINTY_CATEGORIES,
      `${path}[${index}].category`,
    );
    if ("status" in candidate) {
      fail(RESULT_CONTRACT, `${path}[${index}].status`, "no Agent-owned Uncertainty status");
    }
    return candidate;
  });
}

function decisionRequestArray(input: unknown, path: string): readonly ResultCandidate[] {
  const candidates = candidateArray(input, RESULT_CONTRACT, path, [], DECISION_CANDIDATE_KEYS);
  return candidates.map((candidate, index) => {
    const itemPath = `${path}[${index}]`;
    const decisionClass = enumCandidateValue(
      candidate,
      "class",
      STEP_RESULT_DECISION_CLASSES,
      `${itemPath}.class`,
    );
    if (decisionClass !== "D3") return candidate;

    const kind = enumCandidateValue(
      candidate,
      "kind",
      STEP_RESULT_USER_INTERACTION_KINDS,
      `${itemPath}.kind`,
    );
    nonEmptyString(candidate.title, RESULT_CONTRACT, `${itemPath}.title`);
    nonEmptyString(candidate.message, RESULT_CONTRACT, `${itemPath}.message`);
    if (kind === "options") {
      const options = arrayValue(candidate.options, RESULT_CONTRACT, `${itemPath}.options`);
      if (options.length === 0) {
        fail(RESULT_CONTRACT, `${itemPath}.options`, "a non-empty string array");
      }
      options.forEach((option, optionIndex) =>
        nonEmptyString(option, RESULT_CONTRACT, `${itemPath}.options[${optionIndex}]`),
      );
    }
    if (kind === "custom" && candidate.placeholder !== undefined) {
      nonEmptyString(candidate.placeholder, RESULT_CONTRACT, `${itemPath}.placeholder`);
    }
    return candidate;
  });
}

function findingCandidateArray(input: unknown, path: string): readonly ResultCandidate[] {
  const candidates = candidateArray(input, RESULT_CONTRACT, path, [], FINDING_CANDIDATE_KEYS);
  return candidates.map((candidate, index) => {
    const itemPath = `${path}[${index}]`;
    enumCandidateValue(
      candidate,
      "severity",
      STEP_RESULT_FINDING_SEVERITIES,
      `${itemPath}.severity`,
    );
    enumCandidateValue(
      candidate,
      "confidence",
      STEP_RESULT_FINDING_CONFIDENCES,
      `${itemPath}.confidence`,
    );
    for (const key of ["state", "disposition"] as const) {
      if (key in candidate) {
        fail(RESULT_CONTRACT, `${itemPath}.${key}`, "no Agent-owned Finding lifecycle field");
      }
    }
    return candidate;
  });
}

function findingRecheckArray(
  input: unknown,
  contract: string,
  path: string,
): readonly ResultCandidate[] {
  const value = arrayValue(input, contract, path);
  return value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const candidate = jsonObject(entry, contract, itemPath);
    const referenceKeys = ["findingId", "finding_id"].filter((key) => key in candidate);
    if (referenceKeys.length !== 1) {
      fail(contract, itemPath, "exactly one findingId or finding_id Finding reference");
    }
    const referenceKey = referenceKeys[0]!;
    const reference = candidate[referenceKey];
    if (typeof reference !== "string" || !/^F-\d+$/.test(reference)) {
      fail(contract, `${itemPath}.${referenceKey}`, "an F-<number> Finding identity");
    }
    for (const [key, entryValue] of Object.entries(candidate)) {
      if (key === referenceKey) continue;
      const stateIdPath = findAuthoritativeStateId(entryValue, `${itemPath}.${key}`);
      if (stateIdPath) {
        fail(contract, stateIdPath, "no authoritative State ID outside the Finding reference");
      }
    }
    for (const key of ["id", "authoritative_id", "state_id"] as const) {
      if (key in candidate) {
        fail(contract, `${itemPath}.${key}`, "no Agent-generated candidate identity field");
      }
    }
    assertKeys(candidate, FINDING_RECHECK_KEYS, contract, itemPath);
    let hasTransition = false;
    if (candidate.action !== undefined) {
      enumCandidateValue(
        candidate,
        "action",
        STEP_RESULT_FINDING_RECHECK_ACTIONS,
        `${itemPath}.action`,
      );
      hasTransition = true;
    }
    if (candidate.state !== undefined) {
      enumCandidateValue(candidate, "state", STEP_RESULT_FINDING_STATES, `${itemPath}.state`);
      hasTransition = true;
    }
    if (candidate.disposition !== undefined) {
      enumCandidateValue(
        candidate,
        "disposition",
        STEP_RESULT_FINDING_DISPOSITIONS,
        `${itemPath}.disposition`,
      );
      hasTransition = true;
    }
    if (!hasTransition) {
      fail(contract, itemPath, "a finding recheck action, state, or disposition");
    }
    return candidate;
  });
}

function requirementCandidateArray(input: unknown, path: string): readonly ResultCandidate[] {
  const candidates = candidateArray(
    input,
    RESULT_CONTRACT,
    path,
    ["targetId"],
    REQUIREMENT_CANDIDATE_KEYS,
  );
  const kind = path.endsWith("acceptance_criteria")
    ? "acceptanceCriteria"
    : path.endsWith("constraints")
      ? "constraints"
      : "assumptions";
  return candidates.map((candidate, index) => {
    const itemPath = `${path}[${index}]`;
    const operation = enumCandidateValue(
      candidate,
      "operation",
      REQUIREMENT_CANDIDATE_OPERATIONS,
      `${itemPath}.operation`,
    );
    enumCandidateValue(candidate, "effect", REQUIREMENT_CANDIDATE_EFFECTS, `${itemPath}.effect`);
    if (candidate.kind !== undefined) {
      const candidateKind = enumCandidateValue(
        candidate,
        "kind",
        STEP_RESULT_REQUIREMENT_ELEMENT_KINDS,
        `${itemPath}.kind`,
      );
      if (candidateKind !== kind) {
        fail(RESULT_CONTRACT, `${itemPath}.kind`, `the ${kind} candidate kind`);
      }
    }
    if (candidate.targetId !== undefined && kind === "assumptions") {
      fail(RESULT_CONTRACT, `${itemPath}.targetId`, "no targetId for an assumption candidate");
    }
    if (candidate.targetId !== undefined) {
      const prefix = kind === "acceptanceCriteria" ? "AC" : "C";
      if (
        typeof candidate.targetId !== "string" ||
        !new RegExp(`^${prefix}-\\d+$`).test(candidate.targetId)
      ) {
        fail(RESULT_CONTRACT, `${itemPath}.targetId`, `an existing ${prefix}-<number> reference`);
      }
    }
    if (candidate.targetIndex !== undefined) {
      safeIntegerAtLeast(candidate.targetIndex, RESULT_CONTRACT, `${itemPath}.targetIndex`, 0);
    }
    if (candidate.targetId !== undefined && candidate.targetIndex !== undefined) {
      fail(RESULT_CONTRACT, itemPath, "at most one targetId or targetIndex reference");
    }
    if (
      operation === "add" &&
      (candidate.targetId !== undefined || candidate.targetIndex !== undefined)
    ) {
      fail(RESULT_CONTRACT, itemPath, "an add candidate without an existing-element target");
    }
    if (operation === "clarify") {
      const hasTarget =
        kind === "assumptions"
          ? candidate.targetIndex !== undefined
          : candidate.targetId !== undefined;
      if (!hasTarget) {
        fail(
          RESULT_CONTRACT,
          itemPath,
          kind === "assumptions" ? "a clarify targetIndex" : "a clarify targetId reference",
        );
      }
    }
    if (kind !== "assumptions" && candidate.targetIndex !== undefined) {
      fail(RESULT_CONTRACT, `${itemPath}.targetIndex`, "no targetIndex for an AC/C candidate");
    }
    return candidate;
  });
}

function executionCheckArray(input: unknown, path: string): readonly ResultCandidate[] {
  const candidates = candidateArray(input, RESULT_CONTRACT, path, [], EXECUTION_CHECK_KEYS);
  return candidates.map((candidate, index) => {
    const itemPath = `${path}[${index}]`;
    enumCandidateValue(candidate, "type", STEP_RESULT_VERIFICATION_CHECK_TYPES, `${itemPath}.type`);
    enumCandidateValue(
      candidate,
      "status",
      STEP_RESULT_VERIFICATION_CHECK_STATUSES,
      `${itemPath}.status`,
    );
    if (typeof candidate.required !== "boolean") {
      fail(RESULT_CONTRACT, `${itemPath}.required`, "a boolean");
    }
    return candidate;
  });
}

function observationArray(input: unknown, path: string): readonly ResultCandidate[] {
  const candidates = candidateArray(input, RESULT_CONTRACT, path, [], OBSERVATION_KEYS);
  return candidates.map((candidate, index) => {
    for (const key of ["kind", "classification"] as const) {
      if (candidate[key] !== undefined) {
        enumCandidateValue(
          candidate,
          key,
          STEP_RESULT_OBSERVATION_CLASSIFICATIONS,
          `${path}[${index}].${key}`,
        );
      }
    }
    return candidate;
  });
}

function findAuthoritativeStateId(value: JsonValue, path: string): string | undefined {
  if (typeof value === "string") {
    return AUTHORITATIVE_STATE_ID.test(value) ? path : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findAuthoritativeStateId(entry, `${path}[${index}]`);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as JsonObject;
    for (const key of Object.keys(object)) {
      if (AUTHORITATIVE_STATE_ID.test(key)) {
        return `${path}.${key}`;
      }
      if (["evidence", "basis", "needed_evidence"].includes(key)) {
        continue;
      }
      const entry = object[key];
      if (entry === undefined) {
        continue;
      }
      const found = findAuthoritativeStateId(entry, `${path}.${key}`);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

export function parseAgentExecutionRequestV1(input: unknown): AgentExecutionRequestV1 {
  const root = record(input, REQUEST_CONTRACT, "");
  requestIdentity(root.identity);

  const objective = record(root.objective, REQUEST_CONTRACT, "objective");
  nonEmptyString(objective.objective, REQUEST_CONTRACT, "objective.objective");
  nonEmptyString(objective.type, REQUEST_CONTRACT, "objective.type");
  stringArray(objective.completionCriteria, REQUEST_CONTRACT, "objective.completionCriteria");

  const retry = record(root.retry, REQUEST_CONTRACT, "retry");
  safeIntegerAtLeast(retry.attempt, REQUEST_CONTRACT, "retry.attempt", 1);
  jsonValue(retry.context, REQUEST_CONTRACT, "retry.context");

  const execution = record(root.execution, REQUEST_CONTRACT, "execution");
  modeValue(execution.mode, REQUEST_CONTRACT, "execution.mode");
  if (numberValue(execution.timeoutMs, REQUEST_CONTRACT, "execution.timeoutMs") < 0) {
    fail(REQUEST_CONTRACT, "execution.timeoutMs", "a non-negative finite number");
  }
  jsonValue(execution.cancellationPolicy, REQUEST_CONTRACT, "execution.cancellationPolicy");

  const authority = record(root.authority, REQUEST_CONTRACT, "authority");
  nonEmptyString(authority.maximumDLevel, REQUEST_CONTRACT, "authority.maximumDLevel");
  jsonArray(authority.escalationRules, REQUEST_CONTRACT, "authority.escalationRules");

  const permissions = record(root.permissions, REQUEST_CONTRACT, "permissions");
  for (const name of ["filesystem", "shell", "git", "network", "repositoryTargets"] as const) {
    jsonArray(permissions[name], REQUEST_CONTRACT, `permissions.${name}`);
  }

  const skills = record(root.skills, REQUEST_CONTRACT, "skills");
  skillReferences(skills.required, REQUEST_CONTRACT, "skills.required");
  skillReferences(skills.optional, REQUEST_CONTRACT, "skills.optional");

  const tools = record(root.tools, REQUEST_CONTRACT, "tools");
  jsonArray(tools.resolved, REQUEST_CONTRACT, "tools.resolved");
  jsonValue(tools.policy, REQUEST_CONTRACT, "tools.policy");

  const model = record(root.model, REQUEST_CONTRACT, "model");
  jsonValue(model.requested, REQUEST_CONTRACT, "model.requested");
  jsonValue(model.actual, REQUEST_CONTRACT, "model.actual");
  nonEmptyString(model.thinkingLevel, REQUEST_CONTRACT, "model.thinkingLevel");
  jsonArray(model.allowedFallback, REQUEST_CONTRACT, "model.allowedFallback");

  const context = record(root.context, REQUEST_CONTRACT, "context");
  jsonObject(context.pack, REQUEST_CONTRACT, "context.pack");
  jsonObject(context.manifest, REQUEST_CONTRACT, "context.manifest");
  stringArray(context.artifactRefs, REQUEST_CONTRACT, "context.artifactRefs");

  const outputs = record(root.outputs, REQUEST_CONTRACT, "outputs");
  stringArray(outputs.expectedArtifactTypes, REQUEST_CONTRACT, "outputs.expectedArtifactTypes");
  jsonValue(outputs.outputContract, REQUEST_CONTRACT, "outputs.outputContract");

  return input as AgentExecutionRequestV1;
}

export function parseStepResultV1(input: unknown): StepResultV1 {
  const root = record(input, RESULT_CONTRACT, "");
  assertKeys(
    root,
    [
      "identity",
      "outcome",
      "mode",
      "summary",
      "artifacts",
      "uncertainty_candidates",
      "decision_requests",
      "requirement_candidates",
      "finding_candidates",
      "finding_rechecks",
      "plan_deviations",
      "skill_requests",
      "execution_checks",
      "observations",
      "blocked",
      "failure",
      "runtime",
    ],
    RESULT_CONTRACT,
    "",
  );
  resultIdentity(root.identity);
  if ("mode" in root) {
    modeValue(root.mode, RESULT_CONTRACT, "mode");
  }

  const outcome = outcomeValue(root.outcome);
  nonEmptyString(root.summary, RESULT_CONTRACT, "summary");
  artifactArray(root.artifacts, RESULT_CONTRACT, "artifacts");

  uncertaintyCandidateArray(root.uncertainty_candidates, "uncertainty_candidates");
  decisionRequestArray(root.decision_requests, "decision_requests");
  findingCandidateArray(root.finding_candidates, "finding_candidates");
  findingRecheckArray(root.finding_rechecks, RESULT_CONTRACT, "finding_rechecks");
  executionCheckArray(root.execution_checks, "execution_checks");
  observationArray(root.observations, "observations");
  candidateArray(root.plan_deviations, RESULT_CONTRACT, "plan_deviations", [], PLAN_DEVIATION_KEYS);
  candidateArray(root.skill_requests, RESULT_CONTRACT, "skill_requests", [], SKILL_REQUEST_KEYS);

  const requirements = record(
    root.requirement_candidates,
    RESULT_CONTRACT,
    "requirement_candidates",
  );
  assertKeys(
    requirements,
    ["acceptance_criteria", "constraints", "assumptions"],
    RESULT_CONTRACT,
    "requirement_candidates",
  );
  for (const name of ["acceptance_criteria", "constraints", "assumptions"] as const) {
    requirementCandidateArray(requirements[name], `requirement_candidates.${name}`);
  }

  const blocked = nullableStructuredObject(root.blocked, RESULT_CONTRACT, "blocked");
  const failure = nullableStructuredObject(root.failure, RESULT_CONTRACT, "failure");
  jsonObject(root.runtime, RESULT_CONTRACT, "runtime");

  if (outcome === "completed" && (blocked !== null || failure !== null)) {
    fail(RESULT_CONTRACT, "outcome", "null blocked and failure fields for a completed result");
  }
  if (outcome === "blocked" && (blocked === null || failure !== null)) {
    fail(RESULT_CONTRACT, "blocked", "a structured blocked value and null failure");
  }
  if (outcome === "failed" && (failure === null || blocked !== null)) {
    fail(RESULT_CONTRACT, "failure", "a structured failure value and null blocked");
  }

  return input as StepResultV1;
}

function createRuntimeSchema<T>(parser: (input: unknown) => T): RuntimeSchema<T> {
  return {
    parse: parser,
    safeParse(input: unknown): SafeParseResult<T> {
      try {
        return { success: true, data: parser(input) };
      } catch (error) {
        if (error instanceof ContractValidationError) {
          return { success: false, error };
        }
        throw error;
      }
    },
  };
}

export const AgentExecutionRequestV1Schema = createRuntimeSchema(parseAgentExecutionRequestV1);
export const StepResultV1Schema = createRuntimeSchema(parseStepResultV1);

export const agentExecutionRequestV1Schema = AgentExecutionRequestV1Schema;
export const stepResultV1Schema = StepResultV1Schema;
