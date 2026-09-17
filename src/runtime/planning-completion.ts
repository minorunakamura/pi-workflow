import {
  isValidRunId,
  type PlanningCoordinatorResult,
  validatePlanningCoordinatorResult,
} from "../core/index.ts";
import { isRecord, type ValidationResult } from "../core/validation.ts";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  type SubagentRpcEventBus,
} from "./subagents-rpc.ts";
import type { ResultDeliveryObservation } from "./result-delivery.ts";
import type { RootWorkflowRegistry } from "./root-lifecycle.ts";

export function planningCoordinatorResultFromCompletion(
  value: unknown,
): ValidationResult<PlanningCoordinatorResult> {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    return {
      valid: false,
      errors: ["Planning completion results are missing"],
    };
  }
  if (value.results.length !== 1) {
    return {
      valid: false,
      errors: ["Planning completion must contain exactly one result"],
    };
  }

  const result = value.results[0];
  if (!isRecord(result) || !Object.hasOwn(result, "structuredOutput")) {
    return {
      valid: false,
      errors: ["Planning completion structured output is missing"],
    };
  }
  return validatePlanningCoordinatorResult(result.structuredOutput);
}

export interface PlanningCompletionObservation {
  dispose(): void;
}

export function registerPlanningCompletionObservation(
  events: SubagentRpcEventBus,
  registry: RootWorkflowRegistry,
  sessionId: string,
  resultDelivery: Pick<ResultDeliveryObservation, "isCompletionTrusted">,
): PlanningCompletionObservation {
  let disposed = false;

  const onComplete = (value: unknown): void => {
    if (disposed || !isRecord(value) || value.sessionId !== sessionId) return;
    if (!isValidRunId(value.runId)) return;

    const state = registry.getState();
    if (
      state?.phase !== "PLANNING" ||
      state.planningStatus !== "RUNNING" ||
      state.planningRunId !== value.runId
    ) {
      return;
    }

    if (value.state !== "complete" || value.success !== true) {
      registry.transition("FAILED");
      return;
    }
    if (!resultDelivery.isCompletionTrusted(value.runId)) {
      registry.transition("FAILED");
      return;
    }

    const result = planningCoordinatorResultFromCompletion(value);
    if (!result.valid) {
      registry.transition("FAILED");
      return;
    }
    if (result.value.status === "CANCELLED") {
      registry.transition("CANCELLED");
      return;
    }
    if (result.value.status !== "COMPLETED") {
      registry.transition("FAILED");
      return;
    }

    const completed = registry.completePlanning(value.runId, result.value);
    if (!completed.transitioned) registry.transition("FAILED");
  };

  const remove = events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, onComplete);
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      remove();
    },
  };
}
