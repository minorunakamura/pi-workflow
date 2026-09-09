import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  registerWorkflowResource,
  type RegisterWorkflowResourceInput,
  type WorkflowResourceDefinition,
  type WorkflowResourceRegistration,
} from "pi-subagents/workflow-resources";

export const WORKFLOW_RESOURCE_NAMES = [
  "pi-workflow.discovery",
  "pi-workflow.research",
  "pi-workflow.planning",
  "pi-workflow.implementation",
  "pi-workflow.verification",
  "pi-workflow.verification-fix",
  "pi-workflow.review",
] as const;

export type WorkflowResourceName = (typeof WORKFLOW_RESOURCE_NAMES)[number];
export type WorkflowResourceRegistrar = (
  input: RegisterWorkflowResourceInput,
) => WorkflowResourceRegistration;

const RESOURCE_VERSION = 1;

function notMigrated(
  name: WorkflowResourceName,
): WorkflowResourceDefinition["resolve"] {
  return () => ({
    error: `Named workflow resource '${name}' is not yet migrated to the v0.66.0 resource execution path.`,
  });
}

export const WORKFLOW_RESOURCE_DEFINITIONS: readonly WorkflowResourceDefinition[] =
  WORKFLOW_RESOURCE_NAMES.map((name) => ({
    name,
    version: RESOURCE_VERSION,
    resolve: notMigrated(name),
  }));

function disposeAll(
  registrations: readonly WorkflowResourceRegistration[],
): unknown[] {
  const errors: unknown[] = [];
  for (const registration of registrations.toReversed()) {
    try {
      registration.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export interface WorkflowResourceLifecycle {
  register(sessionId: string): void;
  dispose(sessionId: string): void;
}

export function createWorkflowResourceLifecycle(
  registrar: WorkflowResourceRegistrar = registerWorkflowResource,
): WorkflowResourceLifecycle {
  const activeBySession = new Map<
    string,
    readonly WorkflowResourceRegistration[]
  >();

  return {
    register(sessionId) {
      if (activeBySession.has(sessionId)) {
        throw new Error(
          `Session '${sessionId}' already has active workflow resources.`,
        );
      }

      const registrations: WorkflowResourceRegistration[] = [];
      try {
        for (const definition of WORKFLOW_RESOURCE_DEFINITIONS) {
          registrations.push(registrar({ sessionId, definition }));
        }
      } catch (error) {
        const rollbackErrors = disposeAll(registrations);
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            "Failed to register pi-workflow resources.",
            { cause: error },
          );
        }
        throw error;
      }

      activeBySession.set(sessionId, registrations);
    },

    dispose(sessionId) {
      const registrations = activeBySession.get(sessionId);
      if (!registrations) return;
      activeBySession.delete(sessionId);

      const cleanupErrors = disposeAll(registrations);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          `Failed to dispose pi-workflow resources for session '${sessionId}'.`,
        );
      }
    },
  };
}

export function registerWorkflowResourceLifecycle(
  pi: Pick<ExtensionAPI, "on">,
  registrar?: WorkflowResourceRegistrar,
): void {
  const lifecycle = createWorkflowResourceLifecycle(registrar);

  pi.on("session_start", (_event, ctx) => {
    lifecycle.register(ctx.sessionManager.getSessionId());
  });
  pi.on("session_shutdown", (_event, ctx) => {
    lifecycle.dispose(ctx.sessionManager.getSessionId());
  });
}
