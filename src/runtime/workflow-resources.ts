import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  FOREGROUND_POLICY,
  WORKFLOW_RESOURCE_OUTPUT_POLICIES,
} from "../core/phases/definitions";
import {
  ResourceArgsSchemas,
  type ResourceArgsPhase,
  validateResourceArgs,
} from "../core/phases/args";
import { formatValidationIssues } from "../core/validation";
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

export const WORKFLOW_RESOURCE_CONTRACTS = {
  "pi-workflow.discovery": {
    argsPhase: "discovery",
    argsSchema: ResourceArgsSchemas.discovery,
    outputPolicy: WORKFLOW_RESOURCE_OUTPUT_POLICIES.discovery,
    foreground: FOREGROUND_POLICY,
  },
  "pi-workflow.research": {
    argsPhase: "research",
    argsSchema: ResourceArgsSchemas.research,
    outputPolicy: WORKFLOW_RESOURCE_OUTPUT_POLICIES.research,
    foreground: FOREGROUND_POLICY,
  },
  "pi-workflow.planning": {
    argsPhase: "planning",
    argsSchema: ResourceArgsSchemas.planning,
    outputPolicy: WORKFLOW_RESOURCE_OUTPUT_POLICIES.planning,
    foreground: FOREGROUND_POLICY,
  },
  "pi-workflow.implementation": {
    argsPhase: "implementation",
    argsSchema: ResourceArgsSchemas.implementation,
    outputPolicy: WORKFLOW_RESOURCE_OUTPUT_POLICIES.implementation,
    foreground: FOREGROUND_POLICY,
  },
  "pi-workflow.verification": {
    argsPhase: "verification",
    argsSchema: ResourceArgsSchemas.verification,
    outputPolicy: WORKFLOW_RESOURCE_OUTPUT_POLICIES.verification,
    foreground: FOREGROUND_POLICY,
  },
  "pi-workflow.verification-fix": {
    argsPhase: "verification-fix",
    argsSchema: ResourceArgsSchemas["verification-fix"],
    outputPolicy: WORKFLOW_RESOURCE_OUTPUT_POLICIES["verification-fix"],
    foreground: FOREGROUND_POLICY,
  },
  "pi-workflow.review": {
    argsPhase: "review",
    argsSchema: ResourceArgsSchemas.review,
    outputPolicy: WORKFLOW_RESOURCE_OUTPUT_POLICIES.review,
    foreground: FOREGROUND_POLICY,
  },
} as const satisfies Record<
  WorkflowResourceName,
  {
    argsPhase: ResourceArgsPhase;
    argsSchema: TSchema;
    outputPolicy: unknown;
    foreground: typeof FOREGROUND_POLICY;
  }
>;

function notMigrated(
  name: WorkflowResourceName,
): WorkflowResourceDefinition["resolve"] {
  const phase = WORKFLOW_RESOURCE_CONTRACTS[name].argsPhase;
  return (args) => {
    const validation = validateResourceArgs(phase, args);
    if (!validation.ok) {
      return {
        error: `Invalid args for '${name}': ${formatValidationIssues(validation.errors)}`,
      };
    }
    return {
      error: `Named workflow resource '${name}' is not yet migrated to the v0.66.0 resource execution path.`,
    };
  };
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
