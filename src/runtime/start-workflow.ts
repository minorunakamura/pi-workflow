import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  createWorkflowId,
  type WorkflowRequest,
  type WorkflowType,
  type RootWorkflowState,
} from "../core/index.ts";
import type {
  RootWorkflowRegistry,
  StartWorkflowResult,
} from "./root-lifecycle.ts";

export type WorkflowStartContext = Pick<ExtensionCommandContext, "cwd" | "ui">;

export type WorkflowStartFailureReason =
  | "EMPTY_REQUEST"
  | Extract<StartWorkflowResult, { started: false }>["reason"];

export type WorkflowStartResult =
  | {
      started: true;
      request: WorkflowRequest;
      state: RootWorkflowState;
    }
  | {
      started: false;
      reason: WorkflowStartFailureReason;
    };

const FAILURE_MESSAGES: Record<WorkflowStartFailureReason, string> = {
  EMPTY_REQUEST: "Workflow request is required.",
  ACTIVE_WORKFLOW_EXISTS: "A workflow is already active in this Root session.",
  INVALID_WORKFLOW_IDENTITY: "Could not start the workflow.",
  INVALID_STATE: "Could not start the workflow.",
  PERSISTENCE_FAILED: "Could not start the workflow.",
};

function failureMessage(reason: WorkflowStartFailureReason): string {
  return FAILURE_MESSAGES[reason];
}

export function startWorkflow(
  registry: RootWorkflowRegistry,
  workflowType: WorkflowType,
  request: string,
  context: WorkflowStartContext,
): WorkflowStartResult {
  const normalizedRequest = request.trim();
  if (normalizedRequest.length === 0) {
    const reason = "EMPTY_REQUEST" as const;
    context.ui.notify(failureMessage(reason), "error");
    return { started: false, reason };
  }

  const workflowRequest: WorkflowRequest = {
    workflowId: createWorkflowId(),
    workflowType,
    request: normalizedRequest,
    cwd: context.cwd,
    createdAt: new Date().toISOString(),
  };
  const result = registry.start(
    workflowRequest.workflowId,
    workflowRequest.workflowType,
  );
  if (!result.started) {
    context.ui.notify(failureMessage(result.reason), "error");
    return { started: false, reason: result.reason };
  }

  context.ui.notify(`Started /wf-${workflowType} workflow.`, "info");
  return { started: true, request: workflowRequest, state: result.state };
}
