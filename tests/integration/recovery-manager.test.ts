import { describe, expect, it } from "vitest";
import {
  RecoveryManager,
  type RecoveryStatePhase,
} from "../../src/application/recovery/recovery-manager.js";
import type { RunId } from "../../src/domain/primitives/ids.js";
import type { RunLock, RunLockHandle } from "../../src/ports/run-lock.js";
import type { RunReader, WorkflowState } from "../../src/ports/run-reader.js";
import type { WorkspaceLock, WorkspaceLockHandle } from "../../src/ports/workspace-lock.js";

const RUN_ID = "run-001" as RunId;

function workflowState(stateRevision: number): WorkflowState {
  const header = { schema_version: 1, run_id: RUN_ID, state_revision: stateRevision } as const;
  return {
    run: {
      schema_version: 1,
      run_id: RUN_ID,
      request: { id: "request-001", type: "feature" },
      status: "running",
      finalized: false,
      state_revision: stateRevision,
      graph_revision: 1,
      playbook: { initial: {}, current: {} },
      current_step: {},
      current_plan: null,
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
    },
    snapshot: {
      requirement: {
        ...header,
        revision: 1,
        goal: "goal",
        scope: { in: [], out: [] },
        constraints: [],
        acceptance_criteria: [],
        non_goals: [],
        supplied_evidence: [],
        assumptions: [],
        open_questions: [],
      },
      steps: { ...header, graph_revision: 1, steps: [] },
      uncertainties: { ...header, uncertainties: [] },
      decisions: { ...header, decisions: [] },
      gates: { ...header, gates: [] },
      findings: { ...header, findings: [] },
      manifest: {
        ...header,
        previous_state_revision: Math.max(0, stateRevision - 1),
        created_at: "2026-08-30T03:02:10.123+09:00",
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

function runLockHandle(trace: string[]): RunLockHandle {
  return {
    metadata: {
      owner: "test",
      process: 1,
      host: "test-host",
      acquired: "2026-08-30T03:02:10.123Z",
      heartbeat: "2026-08-30T03:02:10.123Z",
    },
    heartbeat: async () => undefined,
    release: async () => {
      trace.push("run-release");
    },
  };
}

function workspaceLockHandle(trace: string[]): WorkspaceLockHandle {
  return {
    metadata: {
      owner: "test",
      process: 1,
      host: "test-host",
      acquired: "2026-08-30T03:02:10.123Z",
      heartbeat: "2026-08-30T03:02:10.123Z",
    },
    heartbeat: async () => undefined,
    release: async () => {
      trace.push("workspace-release");
    },
  };
}

function recoveryManager(
  trace: string[],
  interrupted: RecoveryStatePhase,
  initialState = workflowState(1),
  lockedState = workflowState(2),
) {
  let loads = 0;
  const runReader: RunReader = {
    load: async () => {
      trace.push("load");
      loads += 1;
      return loads === 1 ? initialState : lockedState;
    },
  };
  const runLock: RunLock = {
    acquire: async (_runId, options) => {
      trace.push(`run-lock:${String(options?.recoverStale)}`);
      return runLockHandle(trace);
    },
  };
  const workspaceLock: WorkspaceLock = {
    acquire: async (options) => {
      trace.push(`workspace-lock:${String(options?.recoverStale)}`);
      return workspaceLockHandle(trace);
    },
  };
  const phase =
    (name: string) =>
    async (state: WorkflowState): Promise<WorkflowState> => {
      trace.push(name);
      return state;
    };

  return new RecoveryManager({
    runReader,
    runLock,
    workspaceLock,
    validateEffectiveConfig: async () => {
      trace.push("config");
    },
    checkRepositoryDrift: phase("drift"),
    recoverInterruptedExecution: interrupted,
    processCancellation: phase("cancellation"),
    reconcile: phase("reconcile"),
    processTriggers: phase("triggers"),
  });
}

describe("RecoveryManager", () => {
  it("runs startup recovery in order and schedules only while both locks are held", async () => {
    const trace: string[] = [];
    const manager = recoveryManager(trace, async (state) => {
      trace.push(`interrupted:${state.run.state_revision}`);
      return state;
    });

    const result = await manager.run(RUN_ID, async (session) => {
      expect(session.state.run.state_revision).toBe(2);
      trace.push("schedule");
      return "scheduled";
    });

    expect(result).toBe("scheduled");
    expect(trace).toEqual([
      "load",
      "config",
      "run-lock:true",
      "load",
      "config",
      "workspace-lock:true",
      "drift",
      "interrupted:2",
      "cancellation",
      "reconcile",
      "triggers",
      "schedule",
      "workspace-release",
      "run-release",
    ]);
  });

  it("releases acquired locks when interrupted execution recovery fails", async () => {
    const trace: string[] = [];
    const manager = recoveryManager(trace, async () => {
      trace.push("interrupted");
      throw new Error("execution interrupted");
    });

    await expect(manager.recover(RUN_ID)).rejects.toThrow("execution interrupted");
    expect(trace).toEqual([
      "load",
      "config",
      "run-lock:true",
      "load",
      "config",
      "workspace-lock:true",
      "drift",
      "interrupted",
      "workspace-release",
      "run-release",
    ]);
  });

  it("rejects a terminal state before scheduling, including after the lock reload", async () => {
    const trace: string[] = [];
    const lockedState = workflowState(2);
    const terminalState: WorkflowState = {
      ...lockedState,
      run: { ...lockedState.run, status: "completed", finalized: true },
    };
    const manager = recoveryManager(trace, async (state) => state, workflowState(1), terminalState);

    await expect(manager.recover(RUN_ID)).rejects.toThrow("not resumable");
    expect(trace).toEqual(["load", "config", "run-lock:true", "load", "run-release"]);
  });
});
