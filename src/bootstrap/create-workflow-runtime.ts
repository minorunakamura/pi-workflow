import type {
  WorkflowCommand,
  WorkflowCommandHandler,
} from "../application/workflow-command-handler.js";

const NOT_IMPLEMENTED_MESSAGE = "Workflow runtime is not implemented yet.";

export type WorkflowRuntimeDependencies = {
  commandHandler?: WorkflowCommandHandler;
};

function createNotImplementedHandler(): WorkflowCommandHandler {
  return {
    async execute(_command: WorkflowCommand, _args: string): Promise<void> {
      throw new Error(NOT_IMPLEMENTED_MESSAGE);
    },
  };
}

export function createWorkflowRuntime(
  dependencies: WorkflowRuntimeDependencies = {},
): WorkflowCommandHandler {
  return dependencies.commandHandler ?? createNotImplementedHandler();
}
