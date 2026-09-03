import { describe, expect, it } from "vitest";
import {
  AgentExecutionRequestV1Schema,
  STEP_RESULT_AGENT_OUTPUT_CONTRACT,
  STEP_RESULT_REQUIREMENT_CANDIDATE_EFFECTS,
  STEP_RESULT_REQUIREMENT_CANDIDATE_OPERATIONS,
  STEP_RESULT_UNCERTAINTY_CATEGORIES,
  STEP_RESULT_VERIFICATION_CHECK_TYPES,
  STEP_RESULT_VERIFICATION_CHECK_STATUSES,
  StepResultV1Schema,
} from "../../src/contracts/execution/agent-execution.js";
import {
  REQUIREMENT_CANDIDATE_EFFECTS,
  REQUIREMENT_CANDIDATE_OPERATIONS,
} from "../../src/domain/requirements/requirement.js";
import { UNCERTAINTY_CATEGORIES } from "../../src/domain/uncertainty/uncertainty.js";
import { FINDING_CONFIDENCES, FINDING_SEVERITIES } from "../../src/domain/findings/finding.js";
import {
  VERIFICATION_CHECK_STATUSES,
  VERIFICATION_CHECK_TYPES,
} from "../../src/application/execution/verifier-finalizer.js";

function validRequest() {
  return {
    identity: {
      runId: "run-001",
      stepId: "step-001",
      executionId: "exec-001",
      agentId: "worker",
      agentVersion: "1.0.0",
    },
    objective: {
      objective: "Implement the requested change",
      type: "implementation",
      completionCriteria: ["The contract is validated"],
    },
    retry: {
      attempt: 1,
      context: { previousAttempt: null },
    },
    execution: {
      mode: "write",
      timeoutMs: 60_000,
      cancellationPolicy: { onCancel: "stop" },
    },
    authority: {
      maximumDLevel: "D1",
      escalationRules: [],
    },
    permissions: {
      filesystem: ["repository"],
      shell: [],
      git: [],
      network: [],
      repositoryTargets: ["src/contracts"],
    },
    skills: {
      required: [{ id: "tdd", version: "1" }],
      optional: [],
    },
    tools: {
      resolved: ["read", "edit"],
      policy: { allow: ["read"] },
    },
    model: {
      requested: { provider: "test", model: "test" },
      actual: null,
      thinkingLevel: "medium",
      allowedFallback: [],
    },
    context: {
      pack: { requirements: [] },
      manifest: { artifactRefs: [] },
      artifactRefs: [],
    },
    outputs: {
      expectedArtifactTypes: ["source"],
      outputContract: { format: "typescript" },
    },
  };
}

function validResult() {
  return {
    identity: {
      runId: "run-001",
      stepId: "step-001",
      executionId: "exec-001",
    },
    outcome: "completed",
    summary: "The execution completed.",
    artifacts: [],
    uncertainty_candidates: [],
    decision_requests: [],
    requirement_candidates: {
      acceptance_criteria: [],
      constraints: [],
      assumptions: [],
    },
    finding_candidates: [],
    finding_rechecks: [],
    plan_deviations: [],
    skill_requests: [],
    execution_checks: [],
    observations: [],
    blocked: null,
    failure: null,
    runtime: {},
  };
}

type SchemaRecord = Record<string, unknown>;

function schemaRecord(value: unknown): SchemaRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a schema object");
  }
  return value as SchemaRecord;
}

function schemaProperties(value: unknown): SchemaRecord {
  return schemaRecord(schemaRecord(value).properties);
}

function schemaEnum(value: unknown): readonly unknown[] {
  const values = schemaRecord(value).enum;
  if (!Array.isArray(values)) throw new Error("Expected an enum schema");
  return values;
}

function schemaVariants(value: unknown): readonly SchemaRecord[] {
  const schema = schemaRecord(value);
  return Array.isArray(schema.oneOf) ? schema.oneOf.map(schemaRecord) : [schema];
}

describe("Agent execution contracts", () => {
  it("accepts a request with valid identity, arrays, and mode", () => {
    expect(AgentExecutionRequestV1Schema.parse(validRequest())).toEqual(validRequest());
  });

  it("keeps the shared LLM contract aligned with authoritative finite vocabularies", () => {
    const root = schemaRecord(STEP_RESULT_AGENT_OUTPUT_CONTRACT);
    const properties = schemaProperties(root);
    expect(schemaEnum(properties.outcome)).toEqual(["completed", "blocked", "failed"]);

    const plan = schemaRecord(properties.plan);
    expect(schemaProperties(plan).write_scope).toMatchObject({ type: "array" });
    expect(plan.required).toEqual(["write_scope"]);
    expect(plan.additionalProperties).toBe(false);

    const requirements = schemaProperties(properties.requirement_candidates);
    const acceptance = schemaRecord(requirements.acceptance_criteria);
    const constraints = schemaRecord(requirements.constraints);
    const assumptions = schemaRecord(requirements.assumptions);
    const acceptanceVariants = schemaVariants(acceptance.items);
    const constraintVariants = schemaVariants(constraints.items);
    const assumptionVariants = schemaVariants(assumptions.items);
    const acceptanceProperties = schemaProperties(acceptanceVariants[0]);
    const acceptanceClarifyProperties = schemaProperties(acceptanceVariants[1]);
    const constraintClarifyProperties = schemaProperties(constraintVariants[1]);
    const assumptionProperties = schemaProperties(assumptionVariants[0]);
    const assumptionClarifyProperties = schemaProperties(assumptionVariants[1]);

    expect(
      acceptanceVariants.map((variant) => schemaEnum(schemaProperties(variant).operation)),
    ).toEqual(STEP_RESULT_REQUIREMENT_CANDIDATE_OPERATIONS.map((operation) => [operation]));
    expect(
      acceptanceVariants.flatMap((variant) => schemaEnum(schemaProperties(variant).operation)),
    ).toEqual(REQUIREMENT_CANDIDATE_OPERATIONS);
    expect(schemaEnum(acceptanceProperties.effect)).toEqual(REQUIREMENT_CANDIDATE_EFFECTS);
    expect(schemaEnum(acceptanceProperties.effect)).toEqual(
      STEP_RESULT_REQUIREMENT_CANDIDATE_EFFECTS,
    );
    expect(schemaEnum(schemaProperties(constraintVariants[0]!).operation)).toEqual(["add"]);
    expect(schemaEnum(assumptionProperties.effect)).toEqual(
      STEP_RESULT_REQUIREMENT_CANDIDATE_EFFECTS,
    );
    expect(schemaRecord(acceptanceClarifyProperties.targetId).pattern).toBe("^AC-0*[1-9][0-9]*$");
    expect(schemaRecord(constraintClarifyProperties.targetId).pattern).toBe("^C-0*[1-9][0-9]*$");
    expect(acceptanceProperties).not.toHaveProperty("targetId");
    expect(assumptionProperties).not.toHaveProperty("targetIndex");
    expect(schemaRecord(assumptionClarifyProperties.targetIndex)).toMatchObject({
      type: "integer",
      minimum: 0,
    });
    expect(schemaRecord(assumptionVariants[0]).required).toEqual(["operation", "effect"]);
    expect(schemaRecord(assumptionVariants[1]).required).toEqual([
      "operation",
      "effect",
      "targetIndex",
    ]);

    const uncertainty = schemaRecord(properties.uncertainty_candidates);
    expect(schemaEnum(schemaProperties(uncertainty.items).category)).toEqual(
      UNCERTAINTY_CATEGORIES,
    );
    expect(schemaEnum(schemaProperties(uncertainty.items).category)).toEqual(
      STEP_RESULT_UNCERTAINTY_CATEGORIES,
    );

    const findings = schemaRecord(properties.finding_candidates);
    expect(schemaEnum(schemaProperties(findings.items).severity)).toEqual(FINDING_SEVERITIES);
    expect(schemaEnum(schemaProperties(findings.items).confidence)).toEqual(FINDING_CONFIDENCES);

    const checks = schemaRecord(properties.execution_checks);
    expect(schemaEnum(schemaProperties(checks.items).type)).toEqual(VERIFICATION_CHECK_TYPES);
    expect(schemaEnum(schemaProperties(checks.items).type)).toEqual(
      STEP_RESULT_VERIFICATION_CHECK_TYPES,
    );
    expect(schemaEnum(schemaProperties(checks.items).status)).toEqual(VERIFICATION_CHECK_STATUSES);
    expect(schemaEnum(schemaProperties(checks.items).status)).toEqual(
      STEP_RESULT_VERIFICATION_CHECK_STATUSES,
    );

    const rechecks = schemaRecord(properties.finding_rechecks);
    const variants = schemaRecord(rechecks.items).oneOf;
    if (!Array.isArray(variants)) throw new Error("Expected Finding recheck schema variants");
    expect(variants.map((variant) => schemaRecord(variant).required)).toEqual([
      ["findingId"],
      ["finding_id"],
    ]);
    expect(root.additionalProperties).toBe(false);
  });

  it("rejects malformed identity and array fields", () => {
    expect(() =>
      AgentExecutionRequestV1Schema.parse({
        ...validRequest(),
        identity: { ...validRequest().identity, runId: "step-001" },
      }),
    ).toThrow(/identity.runId.*run-<number> identity/);
    expect(() =>
      AgentExecutionRequestV1Schema.parse({
        ...validRequest(),
        permissions: { ...validRequest().permissions, shell: "bash" },
      }),
    ).toThrow(/permissions.shell.*array/);
  });

  it("rejects an invalid mode and reports the same deterministic error", () => {
    const invalid = {
      ...validRequest(),
      execution: { ...validRequest().execution, mode: "interactive" },
    };

    const first = AgentExecutionRequestV1Schema.safeParse(invalid);
    const second = AgentExecutionRequestV1Schema.safeParse(invalid);

    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
    if (first.success || second.success) {
      throw new Error("Expected both parses to fail");
    }
    expect(first.error.message).toBe(second.error.message);
    expect(first.error.issues).toEqual([
      { path: "execution.mode", expected: "one of read-only, write, verify-only" },
    ]);
  });

  it("requires every stable result array and validates the outcome", () => {
    const { observations: _observations, ...missingArray } = validResult();
    expect(() => StepResultV1Schema.parse(missingArray)).toThrow(/observations.*array/);

    expect(() => StepResultV1Schema.parse({ ...validResult(), outcome: "partial" })).toThrow(
      /outcome.*completed, blocked, failed/,
    );
  });

  it("accepts structured Planner Plan content and keeps its Write Scope machine-readable", () => {
    const parsed = StepResultV1Schema.parse({
      ...validResult(),
      plan: {
        summary: "Implement greeting behavior",
        strategy: "Add the script and node:test coverage.",
        implementation_units: [{ localId: "greeting" }],
        verification_checks: [{ localId: "greeting-tests" }],
        affected_areas: ["scripts"],
        write_scope: ["scripts/greet.mjs", "scripts/greet.test.mjs"],
        dependencies: [],
        constraints: ["no external dependencies"],
        assumptions: [],
        acceptance_criterion_coverage: [],
        related_decisions: [],
        unresolved_blockers: [],
      },
    });

    expect(parsed.plan?.write_scope).toEqual(["scripts/greet.mjs", "scripts/greet.test.mjs"]);
  });

  it("rejects Write Scope hidden in observations", () => {
    expect(() =>
      StepResultV1Schema.parse({
        ...validResult(),
        observations: [{ write_scope: ["src"] }],
      }),
    ).toThrow(/observations\[0\].write_scope/);
  });

  it("accepts a semantic candidate without an Agent-generated identity", () => {
    const parsed = StepResultV1Schema.parse({
      ...validResult(),
      uncertainty_candidates: [{ category: "behavior", summary: "Current behavior is unclear" }],
    });

    expect(parsed.uncertainty_candidates).toEqual([
      { category: "behavior", summary: "Current behavior is unclear" },
    ]);
    expect(parsed.uncertainty_candidates[0]).not.toHaveProperty("id");
  });

  it("rejects authoritative State IDs in every Agent candidate group", () => {
    const invalidResults = [
      { ...validResult(), uncertainty_candidates: [{ id: "U-001" }] },
      { ...validResult(), decision_requests: [{ id: "D-001" }] },
      {
        ...validResult(),
        requirement_candidates: {
          ...validResult().requirement_candidates,
          acceptance_criteria: [{ id: "AC-001", operation: "add", effect: "preserving" }],
        },
      },
      {
        ...validResult(),
        requirement_candidates: {
          ...validResult().requirement_candidates,
          constraints: [{ id: "C-001", operation: "add", effect: "preserving" }],
        },
      },
      {
        ...validResult(),
        requirement_candidates: {
          ...validResult().requirement_candidates,
          assumptions: [{ id: "AC-001" }],
        },
      },
      { ...validResult(), finding_candidates: [{ id: "F-001" }] },
      { ...validResult(), finding_rechecks: [{ findingId: "F-001", id: "F-002" }] },
      { ...validResult(), plan_deviations: [{ id: "PD-001" }] },
      { ...validResult(), skill_requests: [{ id: "CS-001" }] },
      { ...validResult(), skill_requests: [{ id: "VR-001" }] },
      { ...validResult(), execution_checks: [{ id: "V-001" }] },
      { ...validResult(), observations: [{ id: "G-001" }] },
      { ...validResult(), observations: [{ id: "RR-001" }] },
      { ...validResult(), observations: [{ id: "local-observation" }] },
    ];

    for (const invalid of invalidResults) {
      expect(() => StepResultV1Schema.parse(invalid)).toThrow(
        /authoritative State ID|candidate identity field/,
      );
    }
  });

  it("validates requirement candidate operations and effects", () => {
    for (const operation of ["add", "clarify"] as const) {
      for (const effect of ["preserving", "narrowing", "broadening", "changing"] as const) {
        expect(() =>
          StepResultV1Schema.parse({
            ...validResult(),
            requirement_candidates: {
              ...validResult().requirement_candidates,
              acceptance_criteria: [
                {
                  operation,
                  effect,
                  ...(operation === "clarify" ? { targetId: "AC-001" } : {}),
                },
              ],
            },
          }),
        ).not.toThrow();
      }
    }

    for (const operation of ["remove", "replace", "supersede", "unknown"] as const) {
      expect(() =>
        StepResultV1Schema.parse({
          ...validResult(),
          requirement_candidates: {
            ...validResult().requirement_candidates,
            acceptance_criteria: [{ operation, effect: "changing" }],
          },
        }),
      ).toThrow(/requirement_candidates\.acceptance_criteria\[0\]\.operation.*add, clarify/);
    }

    expect(() =>
      StepResultV1Schema.parse({
        ...validResult(),
        requirement_candidates: {
          ...validResult().requirement_candidates,
          constraints: [{ operation: "clarify", effect: "unknown" }],
        },
      }),
    ).toThrow(
      /requirement_candidates\.constraints\[0\]\.effect.*preserving, narrowing, broadening, changing/,
    );

    expect(() =>
      StepResultV1Schema.parse({
        ...validResult(),
        requirement_candidates: {
          ...validResult().requirement_candidates,
          assumptions: [{ operation: "clarify", effect: "changing", targetId: "AC-001" }],
        },
      }),
    ).toThrow(/no targetId for an assumption candidate/);
  });

  it("allows existing Requirement references while keeping candidate identity Agent-owned", () => {
    expect(
      StepResultV1Schema.parse({
        ...validResult(),
        requirement_candidates: {
          acceptance_criteria: [{ operation: "clarify", effect: "preserving", targetId: "AC-001" }],
          constraints: [{ operation: "clarify", effect: "changing", targetId: "C-001" }],
          assumptions: [],
        },
      }).requirement_candidates,
    ).toMatchObject({
      acceptance_criteria: [{ targetId: "AC-001" }],
      constraints: [{ targetId: "C-001" }],
    });
  });

  it("requires structured information for blocked and failed outcomes", () => {
    expect(() => StepResultV1Schema.parse({ ...validResult(), outcome: "blocked" })).toThrow(
      /blocked.*structured blocked value/,
    );
    expect(() => StepResultV1Schema.parse({ ...validResult(), outcome: "failed" })).toThrow(
      /failure.*structured failure value/,
    );

    expect(
      StepResultV1Schema.parse({
        ...validResult(),
        outcome: "blocked",
        blocked: { reason: "waiting for user input" },
      }).outcome,
    ).toBe("blocked");
  });
});
