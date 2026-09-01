import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { WorkflowState } from "../../src/ports/run-reader.js";
import {
  createWorkflowRuntime,
  type WorkflowRuntimeDependencies,
} from "../../src/bootstrap/create-workflow-runtime.js";
import workflowExtension from "../../src/extensions/workflow.js";
import type { RunId } from "../../src/domain/primitives/ids.js";

const RUN_ID = "run-001" as RunId;

type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];
type CommandContext = Parameters<RegisteredCommand["handler"]>[1];

function state(
  status: WorkflowState["run"]["status"],
  finalized: boolean,
  revision: number,
): WorkflowState {
  return {
    run: {
      run_id: RUN_ID,
      status,
      finalized,
      state_revision: revision,
      current_step: { id: "step-001" },
    } as unknown as WorkflowState["run"],
    snapshot: {} as unknown as WorkflowState["snapshot"],
  };
}

function context(
  notifications: Array<readonly [string, "info" | "warning" | "error"]>,
): CommandContext {
  return {
    ui: {
      notify(message, type = "info") {
        notifications.push([message, type]);
      },
    },
  } as CommandContext;
}

describe("workflow runtime status/resume/cancel commands", () => {
  it("reads status and renders compact output without a write use case", async () => {
    const notifications: Array<readonly [string, "info" | "warning" | "error"]> = [];
    let statusCalls = 0;
    let writeCalls = 0;
    const dependencies: WorkflowRuntimeDependencies = {
      statusWorkflow: {
        async execute(runId) {
          statusCalls += 1;
          expect(runId).toBe(RUN_ID);
          return state("blocked", false, 4);
        },
      },
      resumeWorkflow: {
        async execute() {
          writeCalls += 1;
          return state("running", false, 5);
        },
      },
      cancelWorkflow: {
        async execute() {
          writeCalls += 1;
          return state("cancelled", true, 6);
        },
      },
    };
    const registrations = new Map<string, RegisteredCommand>();
    workflowExtension(
      {
        registerCommand(name, options) {
          registrations.set(name, options);
        },
      },
      dependencies,
    );

    await registrations.get("wf-status")!.handler("run-001", context(notifications));

    expect(statusCalls).toBe(1);
    expect(writeCalls).toBe(0);
    expect(notifications).toEqual([
      [
        "Run run-001: status=blocked; finalized=false; revision=4; milestone=step-001; progress=unknown; blocker=blocked",
        "info",
      ],
    ]);
  });

  it("dispatches resume and cancel with parsed Run ID and cancellation reason", async () => {
    const calls: Array<readonly [string, RunId, unknown?]> = [];
    const dependencies: WorkflowRuntimeDependencies = {
      resumeWorkflow: {
        async execute(runId) {
          calls.push(["resume", runId]);
          return state("running", false, 2);
        },
      },
      cancelWorkflow: {
        async execute(runId, options) {
          calls.push(["cancel", runId, options]);
          return state("cancelled", true, 3);
        },
      },
    };
    const runtime = createWorkflowRuntime(dependencies);

    await expect(runtime.execute("resume", "  run-001  ")).resolves.toBe(
      "Run run-001 resumed: status=running; finalized=false; revision=2; milestone=step-001; progress=unknown; blocker=-",
    );
    await expect(runtime.execute("cancel", "run-001 stop because requested")).resolves.toBe(
      "Run run-001 cancelled: status=cancelled; finalized=true; revision=3; outcome=cancelled; request_satisfied=-; summary=-; artifact=-",
    );

    expect(calls).toEqual([
      ["resume", RUN_ID],
      ["cancel", RUN_ID, { requestedBy: "user", reason: "stop because requested" }],
    ]);
  });

  it("renders compact milestones and blockers without echoing agent transcript content", async () => {
    const progressState = {
      run: {
        run_id: RUN_ID,
        status: "blocked",
        finalized: false,
        state_revision: 7,
        current_step: {
          id: "step-003",
          type: "verification",
          transcript: "full agent transcript must not be echoed",
        },
        blocked: { reason: "user-input-required" },
      },
      snapshot: {
        steps: {
          steps: [
            { id: "step-001", status: "completed" },
            { id: "step-002", status: "running" },
            { id: "step-003", status: "ready" },
          ],
        },
        decisions: { decisions: [{ id: "decision-001", status: "pending" }] },
      },
    } as unknown as WorkflowState;
    const finalState = {
      ...progressState,
      run: {
        ...progressState.run,
        status: "completed",
        finalized: true,
        outcome: {
          status: "completed",
          request_satisfied: true,
          summary: "All required checks passed",
          artifact_path: "outcome.md",
          transcript: "final agent transcript must not be echoed",
        },
      },
    } as unknown as WorkflowState;
    let current = progressState;
    const runtime = createWorkflowRuntime({
      statusWorkflow: {
        async execute() {
          return current;
        },
      },
    });

    await expect(runtime.execute("status", "run-001")).resolves.toBe(
      "Run run-001: status=blocked; finalized=false; revision=7; milestone=step-003(verification); progress=1/3; blocker=user-input-required",
    );
    current = finalState;
    await expect(runtime.execute("status", "run-001")).resolves.toBe(
      "Run run-001: status=completed; finalized=true; revision=7; outcome=completed; request_satisfied=true; summary=All required checks passed; artifact=outcome.md",
    );

    const progress = await runtime.execute("status", "run-001");
    expect(progress).not.toContain("transcript");
  });

  it("rejects missing or malformed command arguments before invoking a use case", async () => {
    let calls = 0;
    const runtime = createWorkflowRuntime({
      statusWorkflow: {
        async execute() {
          calls += 1;
          return state("running", false, 1);
        },
      },
      resumeWorkflow: {
        async execute() {
          calls += 1;
          return state("running", false, 1);
        },
      },
      cancelWorkflow: {
        async execute() {
          calls += 1;
          return state("cancelled", true, 1);
        },
      },
    });

    await expect(runtime.execute("status", "")).rejects.toThrow("requires a Run ID");
    await expect(runtime.execute("resume", "run-001 extra")).rejects.toThrow(
      "requires exactly one Run ID",
    );
    await expect(runtime.execute("cancel", "not-a-run")).rejects.toThrow("requires a Run ID");
    expect(calls).toBe(0);
  });
});
