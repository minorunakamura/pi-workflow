import { describe, expect, it } from "vitest";
import {
  AgentExecutionRequestV1Schema,
  StepResultV1Schema,
} from "../../src/contracts/execution/agent-execution.js";

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

describe("Agent execution contracts", () => {
  it("accepts a request with valid identity, arrays, and mode", () => {
    expect(AgentExecutionRequestV1Schema.parse(validRequest())).toEqual(validRequest());
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
    ];

    for (const invalid of invalidResults) {
      expect(() => StepResultV1Schema.parse(invalid)).toThrow(/authoritative State ID/);
    }
  });

  it("validates requirement candidate operations and effects", () => {
    expect(() =>
      StepResultV1Schema.parse({
        ...validResult(),
        requirement_candidates: {
          ...validResult().requirement_candidates,
          acceptance_criteria: [{ operation: "replace", effect: "changing" }],
        },
      }),
    ).toThrow(/requirement_candidates\.acceptance_criteria\[0\]\.operation.*add, clarify/);

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
    ).toThrow(/authoritative State ID/);
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
