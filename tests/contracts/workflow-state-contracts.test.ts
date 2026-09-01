import { describe, expect, it } from "vitest";
import {
  DecisionsSnapshotV1Schema,
  FindingsSnapshotV1Schema,
  GatesSnapshotV1Schema,
  RequirementSnapshotV1Schema,
  RunYamlV1Schema,
  SnapshotManifestV1Schema,
  StepsSnapshotV1Schema,
  UncertaintiesSnapshotV1Schema,
  STATE_SNAPSHOT_FILES,
} from "../../src/contracts/state/workflow-state.js";

function validRunYaml() {
  return {
    schema_version: 1,
    run_id: "run-001",
    request: { id: "request-001", type: "feature" },
    status: "running",
    finalized: false,
    state_revision: 1,
    graph_revision: 1,
    playbook: { initial: {}, current: {} },
    current_step: {},
    current_plan: { applicability: { status: "current" } },
    current_changes: { relevant_change_sets: [], external_reconciliation: null },
    repository: {},
    blocked: null,
    failure: null,
    cancellation: null,
    limits: {},
    counters: {},
    telemetry: { degraded: false },
    outcome: null,
    timestamps: {},
  };
}

function snapshotHeader() {
  return { schema_version: 1, run_id: "run-001", state_revision: 1 };
}

function validRequirementSnapshot() {
  return {
    ...snapshotHeader(),
    revision: 1,
    goal: "Implement the workflow runtime",
    scope: { in: [], out: [] },
    constraints: [],
    acceptance_criteria: [],
    non_goals: [],
    supplied_evidence: [],
    assumptions: [],
    open_questions: [],
  };
}

function validStepsSnapshot() {
  return {
    ...snapshotHeader(),
    graph_revision: 1,
    steps: [
      {
        id: "step-001",
        type: "implementation",
        objective: "Implement state schemas",
        agent: "worker",
        skills: [],
        inputs: [],
        outputs: [],
        depends_on: [],
        completion_criteria: [],
        status: "running",
        blocked_by: [],
        result: null,
      },
    ],
  };
}

function validUncertaintiesSnapshot() {
  return {
    ...snapshotHeader(),
    uncertainties: [{ id: "U-001", status: "open", category: "design" }],
  };
}

function validDecisionsSnapshot() {
  return {
    ...snapshotHeader(),
    decisions: [{ id: "D-001", class: "D2", status: "pending" }],
  };
}

function validGatesSnapshot() {
  return {
    ...snapshotHeader(),
    gates: [{ id: "G-001", type: "verification", status: "waiting" }],
  };
}

function validFindingsSnapshot() {
  return {
    ...snapshotHeader(),
    findings: [
      {
        id: "F-001",
        state: "open",
        disposition: "fix-required",
        severity: "high",
        confidence: "high",
      },
    ],
  };
}

function validManifest() {
  return {
    ...snapshotHeader(),
    previous_state_revision: 0,
    created_at: "2026-08-30T03:02:10.123+09:00",
    files: [...STATE_SNAPSHOT_FILES],
  };
}

describe("workflow state contracts", () => {
  it("accepts run.yaml and all six state snapshot files", () => {
    expect(RunYamlV1Schema.parse(validRunYaml())).toEqual(validRunYaml());
    expect(RequirementSnapshotV1Schema.parse(validRequirementSnapshot())).toEqual(
      validRequirementSnapshot(),
    );
    expect(StepsSnapshotV1Schema.parse(validStepsSnapshot())).toEqual(validStepsSnapshot());
    expect(UncertaintiesSnapshotV1Schema.parse(validUncertaintiesSnapshot())).toEqual(
      validUncertaintiesSnapshot(),
    );
    expect(DecisionsSnapshotV1Schema.parse(validDecisionsSnapshot())).toEqual(
      validDecisionsSnapshot(),
    );
    expect(GatesSnapshotV1Schema.parse(validGatesSnapshot())).toEqual(validGatesSnapshot());
    expect(FindingsSnapshotV1Schema.parse(validFindingsSnapshot())).toEqual(
      validFindingsSnapshot(),
    );
    expect(SnapshotManifestV1Schema.parse(validManifest())).toEqual(validManifest());
  });

  it("keeps finalized separate from the Run status", () => {
    expect(RunYamlV1Schema.parse(validRunYaml()).finalized).toBe(false);
    expect(
      RunYamlV1Schema.parse({ ...validRunYaml(), status: "completed", finalized: true }).status,
    ).toBe("completed");
    expect(
      RunYamlV1Schema.parse({
        ...validRunYaml(),
        status: "failed",
        finalized: true,
        failure: { resumable: false, artifact_path: "failures/failure-001.md" },
        outcome: { status: "failed", artifact_path: "outcome.md" },
      }).finalized,
    ).toBe(true);
    expect(() => RunYamlV1Schema.parse({ ...validRunYaml(), status: "finalized" })).toThrow(
      /status.*created, running, blocked, completed, failed, cancelled/,
    );
  });

  it("rejects failed Runs without the required lifecycle records", () => {
    expect(() =>
      RunYamlV1Schema.parse({ ...validRunYaml(), status: "failed", finalized: false }),
    ).toThrow(/failure.*Failure Record pointer/);
    expect(() =>
      RunYamlV1Schema.parse({
        ...validRunYaml(),
        status: "failed",
        finalized: true,
        failure: { resumable: false, artifact_path: "failures/failure-001.md" },
      }),
    ).toThrow(/outcome.*Outcome/);
    expect(() =>
      RunYamlV1Schema.parse({
        ...validRunYaml(),
        status: "failed",
        finalized: false,
        failure: { resumable: true, artifact_path: "failures/failure-001.md" },
        outcome: { status: "failed" },
      }),
    ).toThrow(/outcome.*resumable failed Run/);
  });

  it("rejects a superseded current Plan", () => {
    expect(() =>
      RunYamlV1Schema.parse({
        ...validRunYaml(),
        current_plan: { applicability: { status: "superseded" } },
      }),
    ).toThrow(/current_plan\.applicability\.status.*current, compatible, replan-required, unknown/);
  });

  it("requires stable arrays and nullable fields", () => {
    expect(() =>
      RunYamlV1Schema.parse({
        ...validRunYaml(),
        current_changes: { relevant_change_sets: "CS-001", external_reconciliation: null },
      }),
    ).toThrow(/current_changes\.relevant_change_sets.*array/);
    expect(() => StepsSnapshotV1Schema.parse({ ...validStepsSnapshot(), steps: null })).toThrow(
      /steps.*array/,
    );
    expect(() =>
      RequirementSnapshotV1Schema.parse({
        ...validRequirementSnapshot(),
        scope: { in: [], out: null },
      }),
    ).toThrow(/scope\.out.*array/);
    expect(
      RunYamlV1Schema.parse({ ...validRunYaml(), blocked: { reason: "waiting" } }).blocked,
    ).toEqual({ reason: "waiting" });
  });
});
