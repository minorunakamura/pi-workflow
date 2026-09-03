import { describe, expect, it } from "vitest";
import type { DomainEvent, EventId } from "../../src/contracts/events/event.js";
import type { RunId } from "../../src/domain/primitives/ids.js";
import {
  buildRunEvaluationRecord,
  type RunEvaluationRecordInput,
} from "../../src/evaluation/run-evaluation-record.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";

const RUN_ID = "run-001" as RunId;

function state(finalized = false, degraded = false): WorkflowState {
  return {
    run: {
      schema_version: 1,
      run_id: RUN_ID,
      request: { id: "request-001", type: "feature" },
      status: finalized ? "completed" : "running",
      finalized,
      state_revision: 12,
      graph_revision: 1,
      playbook: {
        initial: { id: "feature", version: "1.0.0" },
        current: { id: "feature", version: "2.0.0" },
      },
      current_step: {},
      current_plan: null,
      current_changes: { relevant_change_sets: [], external_reconciliation: null },
      repository: { baseline: "commit-001", classification: "clean", resolution: "clear" },
      blocked: null,
      failure: null,
      cancellation: null,
      limits: {},
      counters: {},
      telemetry: { degraded },
      outcome: null,
      timestamps: {},
    },
    snapshot: {
      requirement: {
        schema_version: 1,
        run_id: RUN_ID,
        state_revision: 12,
        revision: 3,
        goal: "Implement evaluation",
        scope: { in: [], out: [] },
        constraints: [],
        acceptance_criteria: [],
        non_goals: [],
        supplied_evidence: [],
        assumptions: [],
        open_questions: [],
      },
      steps: {
        schema_version: 1,
        run_id: RUN_ID,
        state_revision: 12,
        graph_revision: 1,
        steps: [],
      },
      uncertainties: { schema_version: 1, run_id: RUN_ID, state_revision: 12, uncertainties: [] },
      decisions: { schema_version: 1, run_id: RUN_ID, state_revision: 12, decisions: [] },
      gates: { schema_version: 1, run_id: RUN_ID, state_revision: 12, gates: [] },
      findings: { schema_version: 1, run_id: RUN_ID, state_revision: 12, findings: [] },
      manifest: {
        schema_version: 1,
        run_id: RUN_ID,
        state_revision: 12,
        previous_state_revision: 11,
        created_at: "2026-01-01T00:00:00.000Z",
        files: [
          "requirement.yaml",
          "steps.yaml",
          "uncertainties.yaml",
          "decisions.yaml",
          "gates.yaml",
          "findings.yaml",
        ],
      },
    },
  };
}

function event(
  sequence: number,
  telemetryLevel: "minimal" | "standard" | "debug" = "standard",
): DomainEvent {
  return {
    schema_version: 1,
    event_id: `evt-${sequence}` as EventId,
    sequence,
    type: "execution.completed",
    timestamp: "2026-01-01T00:00:00.000Z",
    run_id: RUN_ID,
    source: { component: "test" },
    state_revision: 12,
    data: {
      execution_id: `exec-${sequence}`,
      step_id: "step-001",
      telemetry: { telemetry_level: telemetryLevel, tool_calls: 1 },
    },
  };
}

function input(overrides: Partial<RunEvaluationRecordInput> = {}): RunEvaluationRecordInput {
  return {
    state: state(),
    events: [event(9), event(3, "minimal")],
    evaluatorVersion: 4,
    comparison: {
      effectiveConfig: { z: 1, api_key: "secret-value", a: [2, 1] },
      modelProviderUsage: [{ provider: "provider-a", model: "model-a" }],
      agentVersions: ["worker@1"],
      skillVersions: ["tdd@1"],
      comparisonGroup: "baseline",
      variant: "v1",
    },
    ...overrides,
  };
}

describe("Run evaluation record", () => {
  it("creates provisional and final records from the source finalization state", () => {
    const provisional = buildRunEvaluationRecord(input());
    const final = buildRunEvaluationRecord(input({ state: state(true) }));

    expect(provisional).toMatchObject({
      evaluation_schema_version: 1,
      evaluator_version: 4,
      run_id: RUN_ID,
      evaluation_status: "provisional",
      source: { state_revision: 12, last_event_sequence: 9, finalized: false },
    });
    expect(final).toMatchObject({
      evaluation_status: "final",
      source: { state_revision: 12, last_event_sequence: 9, finalized: true },
    });
  });

  it("records telemetry quality, source sequence, and fair-comparison metadata", () => {
    const record = buildRunEvaluationRecord(input({ state: state(false, true) }));

    expect(record.telemetry_quality).toEqual({ status: "degraded", telemetry_level: "minimal" });
    expect(record.comparison).toMatchObject({
      request_id: "request-001",
      request_type: "feature",
      repository_baseline: "commit-001",
      initial_playbook_version: "1.0.0",
      final_playbook_version: "2.0.0",
      final_requirement_revision: 3,
      telemetry_level: "minimal",
      telemetry_quality: "degraded",
      comparison_group: "baseline",
      variant: "v1",
    });
    expect(record.comparison.effective_config_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("classifies healthy, degraded, and insufficient telemetry without inventing metrics", () => {
    const healthy = buildRunEvaluationRecord(input({ events: [event(1)] }));
    const degraded = buildRunEvaluationRecord(
      input({ state: state(false, true), events: [event(1)] }),
    );
    const insufficient = buildRunEvaluationRecord(input({ events: [] }));
    const executionWithoutTelemetry = buildRunEvaluationRecord(
      input({
        events: [
          {
            ...event(1),
            data: { execution_id: "exec-1", step_id: "step-001" },
          },
        ],
      }),
    );
    const partiallyObserved = buildRunEvaluationRecord(
      input({
        events: [
          event(1),
          {
            ...event(2),
            data: { execution_id: "exec-2", step_id: "step-001" },
          },
        ],
      }),
    );

    expect(healthy.telemetry_quality.status).toBe("healthy");
    expect(degraded.telemetry_quality.status).toBe("degraded");
    expect(insufficient.telemetry_quality.status).toBe("insufficient");
    expect(executionWithoutTelemetry.telemetry_quality.status).toBe("insufficient");
    expect(partiallyObserved.telemetry_quality.status).toBe("degraded");
    expect(insufficient.metrics.telemetry.input_tokens).toBeNull();
    expect(insufficient.metrics.telemetry.tool_calls).toBeNull();
  });

  it("is deterministic for the same source and evaluator version", () => {
    const first = buildRunEvaluationRecord(input());
    const second = buildRunEvaluationRecord(
      input({
        events: [event(3, "minimal"), event(9)],
        comparison: {
          effectiveConfig: { a: [2, 1], api_key: "another-secret", z: 1 },
          modelProviderUsage: [{ model: "model-a", provider: "provider-a" }],
          agentVersions: ["worker@1"],
          skillVersions: ["tdd@1"],
          comparisonGroup: "baseline",
          variant: "v1",
        },
      }),
    );

    expect(second).toEqual(first);
  });

  it("exposes evidence lenses without a scalar score or grade", () => {
    const record = buildRunEvaluationRecord(input());

    expect(record.dimensions).toHaveProperty("correctness");
    expect(record.dimensions).toHaveProperty("efficiency");
    expect(record.dimensions).toHaveProperty("context-efficiency");
    expect(record.dimensions).toHaveProperty("decision-quality");
    expect(record.dimensions).toHaveProperty("review-quality");
    expect(record.dimensions).toHaveProperty("orchestration-quality");
    expect(record).not.toHaveProperty("score");
    expect(record).not.toHaveProperty("grade");
  });
});
