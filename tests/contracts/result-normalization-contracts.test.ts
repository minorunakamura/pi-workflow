import { describe, expect, it } from "vitest";
import { FileArtifactStore } from "../../src/adapters/persistence/write/file-artifact-store.js";
import {
  StepResultV1Schema,
  type AgentExecutionMode,
  type AgentExecutionRequestV1,
  type StepResultV1,
} from "../../src/contracts/execution/agent-execution.js";
import {
  normalizePlanCandidate,
  normalizeResultCandidates,
  normalizeStepResult,
  validateStepResult,
} from "../../src/application/normalization/result-normalizer.js";
import { createStep } from "../../src/domain/graph/step-graph.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

function stateWithExistingIds(): WorkflowState {
  return {
    run: { run_id: "run-001", state_revision: 2 },
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
    uncertainty_candidates: [{ localId: "uncertainty-1", category: "behavior" }],
    decision_requests: [{ localId: "decision-1", class: "D1" }],
    requirement_candidates: {
      acceptance_criteria: [{ operation: "add", effect: "preserving", description: "ac" }],
      constraints: [{ operation: "add", effect: "preserving", description: "constraint" }],
      assumptions: [],
    },
    finding_candidates: [{ localId: "finding-1", severity: "medium", confidence: "high" }],
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

function scoutRequest(): AgentExecutionRequestV1 {
  const base = request("read-only");
  return {
    ...base,
    identity: { ...base.identity, agentId: "scout" },
    objective: { objective: "Scout", type: "analysis", completionCriteria: [] },
    authority: { maximumDLevel: "D0", escalationRules: [] },
  };
}

function realisticScoutResult(): Record<string, unknown> {
  return {
    identity: { runId: "run-001", stepId: "step-001", executionId: "exec-001" },
    outcome: "completed",
    mode: "read-only",
    summary: "Scout completed with a repository handoff.",
    artifacts: [
      {
        type: "analysis",
        purpose: "repository-scout",
        content: "## Handoff Summary\n\nThe repository was inspected.",
      },
    ],
    uncertainty_candidates: [
      {
        category: "behavior",
        question: "What existing behavior must be preserved?",
        basis: ["repository inventory"],
        impact: "The implementation boundary is not yet known.",
        confidence: "high",
      },
    ],
    decision_requests: [],
    requirement_candidates: {
      acceptance_criteria: [],
      constraints: [],
      assumptions: [
        {
          operation: "add",
          effect: "preserving",
          summary: "The current repository is the implementation baseline.",
          basis: "Repository inspection",
        },
      ],
    },
    finding_candidates: [],
    finding_rechecks: [],
    plan_deviations: [],
    skill_requests: [],
    execution_checks: [
      {
        type: "inspection",
        status: "passed",
        required: false,
        check: "repository inventory",
        evidence: ["read-only inspection"],
      },
    ],
    observations: [
      {
        kind: "Fact",
        statement: "The repository was inspected without source mutation.",
        evidence: ["repository inventory"],
      },
    ],
    blocked: null,
    failure: null,
    runtime: {},
  };
}

describe("Result normalization contract", () => {
  it("accepts and finalizes a realistic Scout StepResult through normalization", async () => {
    await withTempRepository({}, async (repositoryRoot) => {
      const artifactStore = new FileArtifactStore(repositoryRoot);
      const normalized = await normalizeStepResult(
        {
          result: realisticScoutResult(),
          request: scoutRequest(),
          state: stateWithExistingIds(),
          step: step("scout"),
        },
        {
          artifactStore,
          artifactReader: artifactStore,
          now: () => new Date("2026-09-03T10:52:00.000Z"),
        },
      );

      expect(normalized.result.artifacts).toEqual([
        {
          runId: "run-001",
          path: "analysis/repository-scout-exec-001.md",
          status: "complete",
        },
      ]);
      expect(normalized.artifacts.refs).toEqual(normalized.result.artifacts);
      expect(normalized.artifacts.contents[0]?.frontMatter).toMatchObject({
        run_id: "run-001",
        step_id: "step-001",
        execution_id: "exec-001",
        artifact: { type: "analysis", status: "complete" },
      });
      expect(normalized.candidates.uncertainty_candidates[0]).toMatchObject({
        id: "U-002",
        category: "behavior",
      });
      expect(normalized.candidates.requirement_candidates.assumptions[0]).toMatchObject({
        operation: "add",
        effect: "preserving",
      });
    });
  });

  it("keeps the captured invalid Scout payload invalid at the missing operation field", () => {
    const invalid = realisticScoutResult();
    const requirements = invalid.requirement_candidates;
    if (typeof requirements !== "object" || requirements === null || Array.isArray(requirements)) {
      throw new Error("Expected requirement candidates");
    }
    expect(() =>
      StepResultV1Schema.parse({
        ...invalid,
        requirement_candidates: {
          ...requirements,
          assumptions: [
            {
              summary: "The current repository is the implementation baseline.",
              basis: "Repository inspection",
            },
          ],
        },
      }),
    ).toThrow("requirement_candidates.assumptions[0].operation: expected a string");
  });

  it("passes an ID-free candidate through validation and allocates its authoritative ID centrally", async () => {
    const semanticResult = StepResultV1Schema.parse({
      ...result(),
      uncertainty_candidates: [{ category: "behavior", summary: "Current behavior is unclear" }],
    });

    expect(semanticResult.uncertainty_candidates[0]).toEqual({
      category: "behavior",
      summary: "Current behavior is unclear",
    });

    const normalized = await normalizeStepResult({
      result: semanticResult,
      request: request(),
      state: stateWithExistingIds(),
      step: step(),
    });

    expect(normalized.candidates.uncertainty_candidates[0]).toMatchObject({
      id: "U-002",
      category: "behavior",
      summary: "Current behavior is unclear",
    });
  });

  it("normalizes structured Planner Plan content without using observations", () => {
    const parsed = StepResultV1Schema.parse({
      ...result(),
      plan: {
        write_scope: ["scripts/greet.test.mjs", "scripts/greet.mjs"],
        implementation_units: [],
        verification_checks: [],
      },
    });

    expect(normalizePlanCandidate(parsed.plan)).toEqual({
      write_scope: ["scripts/greet.test.mjs", "scripts/greet.mjs"],
      implementation_units: [],
      verification_checks: [],
    });
  });

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

  it("preserves an existing Uncertainty identity for a recheck and rejects unknown references", () => {
    const normalized = normalizeResultCandidates({
      result: StepResultV1Schema.parse({
        ...result(),
        uncertainty_rechecks: [
          {
            uncertaintyId: "U-001",
            action: "resolve",
            evidence: { execution_id: "exec-001", check_index: 1 },
          },
        ],
      }),
      state: stateWithExistingIds(),
    });

    expect(normalized.uncertainty_rechecks[0]).toMatchObject({
      id: "U-001",
      uncertaintyId: "U-001",
    });
    expect(() =>
      normalizeResultCandidates({
        result: StepResultV1Schema.parse({
          ...result(),
          uncertainty_rechecks: [
            {
              uncertaintyId: "U-999",
              action: "resolve",
              evidence: { execution_id: "exec-001", check_index: 1 },
            },
          ],
        }),
        state: stateWithExistingIds(),
      }),
    ).toThrow(/Unknown Uncertainty reference: U-999/);
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
