import {
  START_WORKFLOW_COMMANDS,
  type StartWorkflowUseCase,
  type WorkflowCommand,
  type WorkflowCommandHandler,
} from "../application/workflow-command-handler.js";

const NOT_IMPLEMENTED_MESSAGE = "Workflow runtime is not implemented yet.";

export type WorkflowRuntimeDependencies = {
  commandHandler?: WorkflowCommandHandler;
  startWorkflow?: StartWorkflowUseCase;
};

function isStartWorkflowCommand(
  command: WorkflowCommand,
): command is (typeof START_WORKFLOW_COMMANDS)[number] {
  return START_WORKFLOW_COMMANDS.some((candidate) => candidate === command);
}

function createRuntimeHandler(startWorkflow?: StartWorkflowUseCase): WorkflowCommandHandler {
  return {
    async execute(command: WorkflowCommand, args: string): Promise<void> {
      if (!isStartWorkflowCommand(command) || startWorkflow === undefined) {
        throw new Error(NOT_IMPLEMENTED_MESSAGE);
      }

      await startWorkflow.execute(command, args);
    },
  };
}

export function createWorkflowRuntime(
  dependencies: WorkflowRuntimeDependencies = {},
): WorkflowCommandHandler {
  return dependencies.commandHandler ?? createRuntimeHandler(dependencies.startWorkflow);
}
