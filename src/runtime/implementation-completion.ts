import {
  isActivePhase,
  isValidRunId,
  validateImplementationCoordinatorResult,
  type ImplementationCoordinatorResult,
  type RootWorkflowState,
} from "../core/index.ts";
import { isRecord, type ValidationResult } from "../core/validation.ts";
import {
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  type SubagentRpcEventBus,
} from "./subagents-rpc.ts";
import type { ResultDeliveryObservation } from "./result-delivery.ts";

export interface ImplementationCompletionRegistry {
  getState(): RootWorkflowState | undefined;
  completeImplementation(
    runId: unknown,
    result: unknown,
  ): { transitioned: boolean; reason?: string };
  transition(to: "FAILED" | "CANCELLED"): {
    transitioned: boolean;
    reason?: string;
  };
}

export function implementationCoordinatorResultFromCompletion(
  value: unknown,
): ValidationResult<ImplementationCoordinatorResult> {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    return {
      valid: false,
      errors: ["Implementation completion results are missing"],
    };
  }
  if (value.results.length !== 1) {
    return {
      valid: false,
      errors: ["Implementation completion must contain exactly one result"],
    };
  }
  const result = value.results[0];
  if (!isRecord(result) || !Object.hasOwn(result, "structuredOutput")) {
    return {
      valid: false,
      errors: ["Implementation completion structured output is missing"],
    };
  }
  return validateImplementationCoordinatorResult(result.structuredOutput);
}

function relevantImplementationRun(
  state: RootWorkflowState | undefined,
  runId: string,
): boolean {
  return (
    state !== undefined &&
    isActivePhase(state.phase) &&
    (state.phase === "IMPLEMENTING" || state.phase === "CODE_REVIEW") &&
    state.implementationRunId === runId
  );
}

export function registerImplementationCompletionObservation(
  events: SubagentRpcEventBus,
  registry: ImplementationCompletionRegistry,
  sessionId: string,
  resultDelivery: Pick<ResultDeliveryObservation, "isCompletionTrusted">,
): { dispose(): void } {
  let disposed = false;

  const onComplete = (value: unknown): void => {
    if (
      disposed ||
      !isRecord(value) ||
      value.sessionId !== sessionId ||
      !isValidRunId(value.runId) ||
      !relevantImplementationRun(registry.getState(), value.runId)
    ) {
      return;
    }
    if (
      value.state !== "complete" ||
      value.success !== true ||
      !resultDelivery.isCompletionTrusted(value.runId)
    ) {
      registry.transition("FAILED");
      return;
    }

    const result = implementationCoordinatorResultFromCompletion(value);
    if (!result.valid) {
      registry.transition("FAILED");
      return;
    }
    if (result.value.status === "FAILED") {
      registry.transition("FAILED");
      return;
    }
    if (result.value.status === "CANCELLED") {
      registry.transition("CANCELLED");
      return;
    }

    const completed = registry.completeImplementation(
      value.runId,
      result.value,
    );
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
