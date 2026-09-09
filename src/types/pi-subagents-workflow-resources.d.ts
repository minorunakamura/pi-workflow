export interface RegisterWorkflowResourceInput {
  sessionId: string;
  definition: WorkflowResourceDefinition;
}

export interface WorkflowResourceDefinition {
  name: string;
  version: number;
  resolve: (args: Readonly<Record<string, unknown>>) =>
    | {
        script: string;
        hostCommands?: readonly { key: string; command: string }[];
      }
    | { error: string };
}

export interface WorkflowResourceRegistration {
  dispose(): void;
}

export function registerWorkflowResource(
  input: RegisterWorkflowResourceInput,
): WorkflowResourceRegistration;
