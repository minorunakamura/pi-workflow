import { describe, expect, it } from "vitest";
import type { DomainEvent, EventId } from "../../src/contracts/events/event.js";
import type { RunId } from "../../src/domain/primitives/ids.js";
import {
  aggregateRunMetrics,
  RunMetricsAggregator,
  type RunMetricsArtifact,
} from "../../src/evaluation/run-metrics-aggregator.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";

const RUN_ID = "run-001" as RunId;

function state(): WorkflowState {
  const step = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
    id,
    type,
    objective: id,
    status: "completed",
    result: null,
    ...extra,
  });

  return {
    run: {
      run_id: RUN_ID,
      counters: {},
      current_plan: { version: 2 },
      timestamps: {},
    },
    snapshot: {
      steps: {
        steps: [
          step("step-001", "implementation", { origin: "base" }),
          step("step-002", "verification", { origin: "base" }),
          step("step-003", "review", { origin: "base" }),
          step("step-004", "implementation", {
            origin: "dynamic",
            objective: "fix verification failure",
            trigger: "verification failure",
          }),
          step("step-005", "verification", {
            origin: "dynamic",
            objective: "reverify the fix",
            trigger: "verification failure",
          }),
          step("step-006", "review", {
            origin: "dynamic",
            objective: "rereview the fix",
            trigger: "review finding",
          }),
        ],
      },
      findings: {
        findings: [
          {
            id: "F-001",
            severity: "high",
            disposition: "fixed",
            state: "resolved",
          },
        ],
      },
    },
  } as unknown as WorkflowState;
}

function event(
  sequence: number,
  type: DomainEvent["type"],
  data: Record<string, unknown> = {},
): DomainEvent {
  return {
    schema_version: 1,
    event_id: `evt-${sequence}` as EventId,
    sequence,
    type,
    timestamp: "2026-01-01T00:00:00.000Z",
    run_id: RUN_ID,
    source: { component: "test" },
    state_revision: sequence,
    data,
  } as DomainEvent;
}

function artifact(
  type: "verification" | "review",
  executionId: string,
  createdAt: string,
  payload: Record<string, unknown> = {},
): RunMetricsArtifact {
  return {
    path: `${type}/${executionId}.md`,
    frontMatter: {
      artifact: { type, status: "complete" },
      execution_id: executionId,
      step_id: "step-002",
      created_at: createdAt,
      execution_state_revision: 1,
    },
    payload,
  };
}

describe("RunMetricsAggregator", () => {
  it("aggregates retry, replan, fix, blocked, VR, RR, and Finding metrics deterministically", () => {
    const input = {
      state: state(),
      events: [
        event(10, "finding.reopened", { finding_id: "F-001" }),
        event(9, "finding.created", { finding_id: "F-001" }),
        event(8, "review.completed", { execution_id: "exec-004", step_id: "step-006" }),
        event(7, "review.completed", { execution_id: "exec-003", step_id: "step-003" }),
        event(6, "verification.completed", { execution_id: "exec-004", step_id: "step-005" }),
        event(5, "verification.completed", { execution_id: "exec-003", step_id: "step-002" }),
        event(4, "run.blocked"),
        event(3, "plan.created", { version: 2, previous_version: 1 }),
        event(2, "plan.created", { version: 1 }),
        event(1, "execution.completed", { execution_id: "exec-002", step_id: "step-001" }),
        event(0, "execution.completed", { execution_id: "exec-001", step_id: "step-001" }),
      ],
      artifacts: [
        artifact("verification", "exec-003", "2026-01-01T00:00:01.000Z", {
          result: "failed",
          strength: "partial",
          freshness: "stale",
          checks: [{ status: "failed" }, { status: "skipped" }],
          limitations: ["first attempt"],
          accepted: true,
        }),
        artifact("verification", "exec-004", "2026-01-01T00:00:02.000Z", {
          result: "passed",
          strength: "strong",
          freshness: "fresh",
          checks: [{ status: "passed" }, { status: "unavailable" }],
        }),
        artifact("review", "exec-003", "2026-01-01T00:00:01.000Z"),
        artifact("review", "exec-004", "2026-01-01T00:00:02.000Z"),
      ],
    };

    const first = aggregateRunMetrics(input);
    const second = new RunMetricsAggregator().aggregate({
      ...input,
      events: [...input.events].reverse(),
    });

    expect(first).toEqual(second);
    expect(first.orchestration).toMatchObject({
      base_steps_count: 3,
      dynamic_steps_count: 3,
      executions_count: 2,
      retry_executions_count: 1,
      replans_count: 1,
      fix_cycles_count: 1,
      blocked_count: 1,
      reverification_count: 1,
      rereview_count: 1,
    });
    expect(first.verification).toMatchObject({
      runs_count: 2,
      reverifications_count: 1,
      checks: {
        passed_count: 1,
        failed_count: 1,
        skipped_count: 1,
        unavailable_count: 1,
      },
      accepted_limitations_count: 1,
      final: { result: "passed", freshness: "fresh", strength: "strong" },
    });
    expect(first.review).toMatchObject({
      runs_count: 2,
      rereviews_count: 1,
      findings_created_count: 1,
      findings_reopened_count: 1,
      findings_by_severity: { high: 1 },
      final_disposition_counts: { fixed: 1 },
    });
  });

  it("keeps missing telemetry unavailable and preserves an explicitly collected zero", () => {
    const base = { state: state(), events: [] };
    const missing = aggregateRunMetrics({
      ...base,
      state: {
        ...base.state,
        snapshot: {
          ...base.state.snapshot,
          steps: {
            ...base.state.snapshot.steps,
            steps: [
              {
                ...base.state.snapshot.steps.steps[0],
                result: {
                  identity: { executionId: "exec-001" },
                  runtime: { telemetry_level: "standard" },
                },
              },
            ],
          },
        },
      } as WorkflowState,
    });

    expect(missing.telemetry.tool_calls).toBeNull();
    expect(missing.telemetry.input_tokens).toBeNull();
    expect(missing.telemetry.blocked_ms).toBeNull();

    const collectedZero = aggregateRunMetrics({
      ...base,
      events: [
        event(1, "execution.completed", {
          execution_id: "exec-001",
          step_id: "step-001",
          telemetry: { telemetry_level: "standard", tool_calls: 0 },
        }),
      ],
    });
    expect(collectedZero.telemetry.tool_calls).toBe(0);
  });
});
