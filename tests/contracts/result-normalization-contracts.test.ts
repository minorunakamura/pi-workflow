import { describe, expect, it } from "vitest";
import {
  StepResultV1Schema,
  type AgentExecutionMode,
  type AgentExecutionRequestV1,
  type StepResultV1,
} from "../../src/contracts/execution/agent-execution.js";
import {
  normalizeResultCandidates,
  validateStepResult,
} from "../../src/application/normalization/result-normalizer.js";
import { createStep } from "../../src/domain/graph/step-graph.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";

function stateWithExistingIds(): WorkflowState {
  return {
    run: { run_id: "run-001" },
    snapshot: {
      requirement: { acceptance_criteria: [{ id: "AC-001" }], constraints: [{ id: "C-001" }] },
      uncertainties: { uncertainties: [{ id: "U-001" }] },
      decisions: { decisions: [{ id: "D-001" }] },
      findings: { findings: [{ id: "F-001" }] },
    },
  } as unknown as WorkflowState;
}

function request(mode: AgentExecutionMode = "write"): AgentExecutionRequestV1 {
  return {
    identity: {
      runId: "run-001" as RunId,
      stepId: "step-001" as StepId,
      executionId: "exec-001" as ExecutionId,
      agentId: "worker",
      agentVersion: "1.0.0",
    },
    objective: { objective: "implement", type: "implementation", completionCriteria: [] },
    retry: { attempt: 1, context: null },
    execution: { mode, timeoutMs: 1_000, cancellationPolicy: {} },
    authority: { maximumDLevel: "D1", escalationRules: [] },
    permissions: { filesystem: [], shell: [], git: [], network: [], repositoryTargets: [] },
    skills: { required: [], optional: [] },
    tools: { resolved: [], policy: {} },
    model: { requested: "test", actual: "test", thinkingLevel: "low", allowedFallback: [] },
    context: { pack: {}, manifest: {}, artifactRefs: [] },
    outputs: { expectedArtifactTypes: [], outputContract: {} },
  };
}

function step(agent = "worker") {
  return createStep({
    id: "step-001" as StepId,
    type: "implementation",
    objective: "implement",
    agent,
    status: "ready",
  });
}

function result(): StepResultV1 {
  return StepResultV1Schema.parse({
    identity: { runId: "run-001", stepId: "step-001", executionId: "exec-001" },
    outcome: "completed",
    summary: "done",
    artifacts: [],
    uncertainty_candidates: [{ localId: "uncertainty-1" }],
    decision_requests: [{ localId: "decision-1" }],
    requirement_candidates: {
      acceptance_criteria: [{ operation: "add", effect: "preserving", description: "ac" }],
      constraints: [{ operation: "add", effect: "preserving", description: "constraint" }],
      assumptions: [],
    },
    finding_candidates: [{ localId: "finding-1" }],
    finding_rechecks: [],
    plan_deviations: [{ localId: "deviation-1" }],
    skill_requests: [],
    execution_checks: [],
    observations: [],
    blocked: null,
    failure: null,
    runtime: {},
  });
}

describe("Result normalization contract", () => {
  it("allocates authoritative IDs centrally and avoids existing identities", () => {
    const normalized = normalizeResultCandidates({
      result: result(),
      state: stateWithExistingIds(),
    });

    expect(normalized.uncertainty_candidates[0]?.id).toBe("U-002");
    expect(normalized.decision_requests[0]?.id).toBe("D-002");
    expect(normalized.requirement_candidates.acceptance_criteria[0]?.id).toBe("AC-002");
    expect(normalized.requirement_candidates.constraints[0]?.id).toBe("C-002");
    expect(normalized.finding_candidates[0]?.id).toBe("F-002");
    expect(normalized.plan_deviations[0]?.id).toBe("PD-001");
    expect(result().uncertainty_candidates[0]).not.toHaveProperty("id", "U-002");
  });

  it("preserves an existing Finding identity for a recheck", () => {
    const normalized = normalizeResultCandidates({
      result: StepResultV1Schema.parse({
        ...result(),
        finding_candidates: [],
        finding_rechecks: [{ findingId: "F-001", action: "fix" }],
      }),
      state: stateWithExistingIds(),
    });

    expect(normalized.finding_rechecks[0]).toMatchObject({
      id: "F-001",
      findingId: "F-001",
    });
  });

  it("rejects role, permission, and Artifact reference violations", async () => {
    const base = {
      result: result(),
      state: stateWithExistingIds(),
      request: request(),
      step: step(),
    };

    await expect(validateStepResult({ ...base, step: step("scout") })).rejects.toMatchObject({
      code: "ROLE_VIOLATION",
    });
    await expect(
      validateStepResult({ ...base, request: request("read-only") }),
    ).rejects.toMatchObject({ code: "PERMISSION_VIOLATION" });
    await expect(
      validateStepResult({
        ...base,
        result: StepResultV1Schema.parse({
          ...result(),
          artifacts: [{ runId: "run-001", path: "../escape.md", status: "complete" }],
        }),
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_INVALID" });
    await expect(
      validateStepResult({
        ...base,
        result: StepResultV1Schema.parse({
          ...result(),
          artifacts: [{ runId: "run-001", path: "C:escape.md", status: "complete" }],
        }),
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_INVALID" });
  });
});
