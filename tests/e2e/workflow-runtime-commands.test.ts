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
      ["Run run-001: status=blocked; finalized=false; revision=4; step=step-001", "info"],
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
      "Run run-001 resumed: status=running; finalized=false; revision=2",
    );
    await expect(runtime.execute("cancel", "run-001 stop because requested")).resolves.toBe(
      "Run run-001 cancelled: status=cancelled; finalized=true; revision=3",
    );

    expect(calls).toEqual([
      ["resume", RUN_ID],
      ["cancel", RUN_ID, { requestedBy: "user", reason: "stop because requested" }],
    ]);
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
