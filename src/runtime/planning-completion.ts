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

function resultCandidates(value: Record<string, unknown>): unknown[] {
  const candidates: unknown[] = [];
  const add = (candidate: unknown): void => {
    if (candidate !== undefined) candidates.push(candidate);
  };

  add(value.planningResult);
  add(value.structuredOutput);
  if (isRecord(value.result)) {
    add(value.result.planningResult);
    add(value.result.structuredOutput);
    add(value.result);
  }
  if (isRecord(value.details)) {
    add(value.details.planningResult);
    add(value.details.structuredOutput);
  }
  if (Array.isArray(value.results)) {
    for (const result of value.results) {
      if (!isRecord(result)) continue;
      add(result.planningResult);
      add(result.structuredOutput);
      add(result.structured);
    }
  }
  return candidates;
}

export function planningCoordinatorResultFromCompletion(
  value: unknown,
): ValidationResult<PlanningCoordinatorResult> {
  if (!isRecord(value)) {
    return { valid: false, errors: ["Planning completion payload is invalid"] };
  }
  const candidates = resultCandidates(value);
  if (candidates.length === 0) {
    return {
      valid: false,
      errors: ["Planning completion has no structured Coordinator result"],
    };
  }
  for (const candidate of candidates) {
    const validation = validatePlanningCoordinatorResult(candidate);
    if (validation.valid) return validation;
  }
  return {
    valid: false,
    errors: ["Planning completion Coordinator result is invalid"],
  };
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
