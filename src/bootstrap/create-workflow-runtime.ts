import {
  START_WORKFLOW_COMMANDS,
  type CancelWorkflowUseCase,
  type ResumeWorkflowUseCase,
  type StartWorkflowUseCase,
  type StatusWorkflowUseCase,
  type WorkflowCommand,
  type WorkflowCommandHandler,
  type WorkflowCommandOutput,
} from "../application/workflow-command-handler.js";
import type { WorkflowState } from "../ports/run-reader.js";
import type { RunId } from "../domain/primitives/ids.js";

const NOT_IMPLEMENTED_MESSAGE = "Workflow runtime is not implemented yet.";
const RUN_ID_PATTERN = /^run-\d+$/;

type RuntimeUseCases = Readonly<{
  startWorkflow?: StartWorkflowUseCase;
  statusWorkflow?: StatusWorkflowUseCase;
  resumeWorkflow?: ResumeWorkflowUseCase;
  cancelWorkflow?: CancelWorkflowUseCase;
}>;

export type WorkflowRuntimeDependencies = RuntimeUseCases & {
  commandHandler?: WorkflowCommandHandler;
};

function isStartWorkflowCommand(
  command: WorkflowCommand,
): command is (typeof START_WORKFLOW_COMMANDS)[number] {
  return START_WORKFLOW_COMMANDS.some((candidate) => candidate === command);
}

function parseArguments(args: string, command: "wf-status" | "wf-resume" | "wf-cancel"): string[] {
  if (typeof args !== "string") {
    throw new TypeError(`/${command} arguments must be text`);
  }
  const values = args.trim().split(/\s+/).filter(Boolean);
  if (values.length === 0) {
    throw new Error(`/${command} requires a Run ID (run-<number>)`);
  }
  return values;
}

function parseRunId(args: string, command: "wf-status" | "wf-resume"): RunId {
  const values = parseArguments(args, command);
  if (values.length !== 1 || !RUN_ID_PATTERN.test(values[0] ?? "")) {
    throw new Error(`/${command} requires exactly one Run ID (run-<number>)`);
  }
  return values[0] as RunId;
}

function parseCancelArguments(args: string): Readonly<{ runId: RunId; reason?: string }> {
  const values = parseArguments(args, "wf-cancel");
  const rawRunId = values[0] ?? "";
  if (!RUN_ID_PATTERN.test(rawRunId)) {
    throw new Error("/wf-cancel requires a Run ID (run-<number>)");
  }
  const reason = values.slice(1).join(" ");
  return reason.length === 0 ? { runId: rawRunId as RunId } : { runId: rawRunId as RunId, reason };
}

function runSummary(state: WorkflowState): string {
  const step = typeof state.run.current_step.id === "string" ? state.run.current_step.id : "-";
  return `Run ${state.run.run_id}: status=${state.run.status}; finalized=${String(state.run.finalized)}; revision=${String(state.run.state_revision)}; step=${step}`;
}

function commandSummary(command: "resume" | "cancel", state: WorkflowState): string {
  const action = command === "resume" ? "resumed" : "cancelled";
  return `Run ${state.run.run_id} ${action}: status=${state.run.status}; finalized=${String(state.run.finalized)}; revision=${String(state.run.state_revision)}`;
}

function createRuntimeHandler(dependencies: RuntimeUseCases): WorkflowCommandHandler {
  return {
    async execute(command: WorkflowCommand, args: string): Promise<WorkflowCommandOutput | void> {
      if (isStartWorkflowCommand(command)) {
        if (dependencies.startWorkflow === undefined) throw new Error(NOT_IMPLEMENTED_MESSAGE);
        await dependencies.startWorkflow.execute(command, args);
        return;
      }

      if (command === "status") {
        if (dependencies.statusWorkflow === undefined) throw new Error(NOT_IMPLEMENTED_MESSAGE);
        return runSummary(await dependencies.statusWorkflow.execute(parseRunId(args, "wf-status")));
      }

      if (command === "resume") {
        if (dependencies.resumeWorkflow === undefined) throw new Error(NOT_IMPLEMENTED_MESSAGE);
        return commandSummary(
          command,
          await dependencies.resumeWorkflow.execute(parseRunId(args, "wf-resume")),
        );
      }

      if (dependencies.cancelWorkflow === undefined) throw new Error(NOT_IMPLEMENTED_MESSAGE);
      const { runId, reason } = parseCancelArguments(args);
      const state =
        reason === undefined
          ? await dependencies.cancelWorkflow.execute(runId)
          : await dependencies.cancelWorkflow.execute(runId, { requestedBy: "user", reason });
      return commandSummary(command, state);
    },
  };
}

export function createWorkflowRuntime(
  dependencies: WorkflowRuntimeDependencies = {},
): WorkflowCommandHandler {
  return dependencies.commandHandler ?? createRuntimeHandler(dependencies);
}
