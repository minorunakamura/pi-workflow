import { describe, expect, it } from "vitest";
import {
  StepResultV1Schema,
  type AgentExecutionRequestV1,
} from "../../src/contracts/execution/agent-execution.js";
import { validateReviewerExecutionRequest } from "../../src/application/execution/reviewer-finalizer.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";

function request(overrides: Partial<AgentExecutionRequestV1> = {}): AgentExecutionRequestV1 {
  return {
    identity: {
      runId: "run-001" as RunId,
      stepId: "step-001" as StepId,
      executionId: "exec-001" as ExecutionId,
      agentId: "reviewer",
      agentVersion: "1.0.0",
    },
    objective: { objective: "review", type: "review", completionCriteria: [] },
    retry: { attempt: 1, context: null },
    execution: { mode: "read-only", timeoutMs: 1_000, cancellationPolicy: {} },
    authority: { maximumDLevel: "D0", escalationRules: [] },
    permissions: { filesystem: [], shell: [], git: [], network: [], repositoryTargets: [] },
    skills: { required: [], optional: [] },
    tools: { resolved: ["read"], policy: {} },
    model: { requested: "test", actual: "test", thinkingLevel: "low", allowedFallback: [] },
    context: { pack: {}, manifest: {}, artifactRefs: [] },
    outputs: { expectedArtifactTypes: [], outputContract: {} },
    ...overrides,
  };
}

function result() {
  return {
    identity: { runId: "run-001", stepId: "step-001", executionId: "exec-001" },
    outcome: "completed",
    summary: "reviewed",
    artifacts: [],
    uncertainty_candidates: [],
    decision_requests: [],
    requirement_candidates: { acceptance_criteria: [], constraints: [], assumptions: [] },
    finding_candidates: [],
    finding_rechecks: [{ finding_id: "F-001", action: "fix" }],
    plan_deviations: [],
    skill_requests: [],
    execution_checks: [],
    observations: [],
    blocked: null,
    failure: null,
    runtime: {},
  };
}

describe("Reviewer security contracts", () => {
  it("allows an F-ID only as the explicit Finding recheck reference", () => {
    expect(StepResultV1Schema.parse(result()).finding_rechecks).toEqual([
      { finding_id: "F-001", action: "fix" },
    ]);

    expect(() =>
      StepResultV1Schema.parse({
        ...result(),
        finding_rechecks: [{ finding_id: "F-001", evidence: "F-002" }],
      }),
    ).toThrow(/authoritative State ID outside the Finding reference/);
  });

  it("denies Reviewer requests that grant source-write capabilities", () => {
    expect(() =>
      validateReviewerExecutionRequest({
        ...request(),
        tools: { resolved: ["repository-write"], policy: {} },
      }),
    ).toThrow(/REVIEWER_REQUEST_INVALID/);
  });
});
