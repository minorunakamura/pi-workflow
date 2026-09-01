import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  START_WORKFLOW_COMMANDS,
  type CancelWorkflowUseCase,
  type ResumeWorkflowUseCase,
  type StartWorkflowUseCase,
  type StatusWorkflowUseCase,
  type WorkflowCommand,
  type WorkflowCommandHandler,
  type WorkflowCommandOutput,
  renderWorkflowResponse,
} from "../application/workflow-command-handler.js";
import { PiUserInteractionAdapter } from "../adapters/pi/pi-user-interaction-adapter.js";
import type { RunId } from "../domain/primitives/ids.js";
import type { WorkflowState } from "../ports/run-reader.js";
import type { UserInteraction } from "../ports/user-interaction.js";

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

export function createPiUserInteraction(
  ui: Pick<ExtensionUIContext, "select" | "confirm" | "input">,
): UserInteraction {
  return new PiUserInteractionAdapter(ui);
}

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

function commandSummary(command: "resume" | "cancel", state: WorkflowState): string {
  const action = command === "resume" ? "resumed" : "cancelled";
  return renderWorkflowResponse(state).replace(
    `Run ${state.run.run_id}:`,
    `Run ${state.run.run_id} ${action}:`,
  );
}

function createRuntimeHandler(dependencies: RuntimeUseCases): WorkflowCommandHandler {
  return {
    async execute(
      command: WorkflowCommand,
      args: string,
      userInteraction?: UserInteraction,
    ): Promise<WorkflowCommandOutput | void> {
      if (isStartWorkflowCommand(command)) {
        if (dependencies.startWorkflow === undefined) throw new Error(NOT_IMPLEMENTED_MESSAGE);
        const state =
          userInteraction === undefined
            ? await dependencies.startWorkflow.execute(command, args)
            : await dependencies.startWorkflow.execute(command, args, userInteraction);
        return state === undefined ? undefined : renderWorkflowResponse(state);
      }

      if (command === "status") {
        if (dependencies.statusWorkflow === undefined) throw new Error(NOT_IMPLEMENTED_MESSAGE);
        return renderWorkflowResponse(
          await dependencies.statusWorkflow.execute(parseRunId(args, "wf-status")),
        );
      }

      if (command === "resume") {
        if (dependencies.resumeWorkflow === undefined) throw new Error(NOT_IMPLEMENTED_MESSAGE);
        const runId = parseRunId(args, "wf-resume");
        const state =
          userInteraction === undefined
            ? await dependencies.resumeWorkflow.execute(runId)
            : await dependencies.resumeWorkflow.execute(runId, userInteraction);
        return commandSummary(command, state);
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
