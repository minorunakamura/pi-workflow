import {
  isRecord,
  isValidRunId,
  isValidWorkflowId,
  type CancellationStopStatus,
  type RootWorkflowState,
  type RunId,
} from "../core/index.ts";
import type { RootWorkflowRegistry } from "./root-lifecycle.ts";

export interface RootCancellationBridge {
  dispose(options?: { preserveRootState?: boolean }): void;
}

export interface RootCancellationControllerOptions {
  registry: RootWorkflowRegistry;
  getBridges: () => readonly (RootCancellationBridge | undefined)[];
  stopCoordinator?: (runId: string) => Promise<unknown>;
  stopPlanningCoordinator?: (runId: string) => Promise<unknown>;
  stopImplementationCoordinator?: (runId: string) => Promise<unknown>;
}

export type RootCancellationResult =
  | {
      accepted: true;
      duplicate: boolean;
      state: RootWorkflowState;
      stopStatus: CancellationStopStatus;
    }
  | {
      accepted: false;
      reason: string;
      state?: RootWorkflowState;
    };

function activeCoordinatorRunId(state: RootWorkflowState): RunId | undefined {
  if (
    (state.phase === "PLANNING" ||
      (state.phase === "PLAN_REVIEW" && state.planningStatus === "RUNNING")) &&
    isValidRunId(state.planningRunId)
  ) {
    return state.planningRunId;
  }
  if (
    (state.phase === "IMPLEMENTING" || state.phase === "CODE_REVIEW") &&
    isValidRunId(state.implementationRunId)
  ) {
    return state.implementationRunId;
  }
  return undefined;
}

function stopStatusFromReply(value: unknown): CancellationStopStatus {
  if (!isRecord(value) || typeof value.success !== "boolean") return "unknown";
  return value.success ? "requested" : "failed";
}

export class RootCancellationController {
  private readonly inFlight = new Map<
    string,
    Promise<RootCancellationResult>
  >();

  public constructor(
    private readonly options: RootCancellationControllerOptions,
  ) {}

  public requestWorkflowCancellation(
    workflowId: unknown,
  ): Promise<RootCancellationResult> {
    if (!isValidWorkflowId(workflowId)) {
      return Promise.resolve({
        accepted: false,
        reason: "Workflow identity is invalid",
      });
    }
    const existing = this.inFlight.get(workflowId);
    if (existing !== undefined) return existing;

    const operation = this.perform(workflowId).finally(() => {
      this.inFlight.delete(workflowId);
    });
    this.inFlight.set(workflowId, operation);
    return operation;
  }

  private async perform(workflowId: string): Promise<RootCancellationResult> {
    const current = this.options.registry.getState();
    const transition = this.options.registry.requestCancellation(workflowId);
    if (!transition.cancelled) {
      return {
        accepted: false,
        reason: transition.reason,
        ...(current === undefined ? {} : { state: current }),
      };
    }

    if (transition.duplicate) {
      return {
        accepted: true,
        duplicate: true,
        state: transition.state,
        stopStatus: transition.state.cancellationOutcome?.stop ?? "unknown",
      };
    }

    const runId =
      current === undefined ? undefined : activeCoordinatorRunId(current);
    for (const bridge of this.options.getBridges()) {
      if (bridge === undefined) continue;
      try {
        bridge.dispose({ preserveRootState: true });
      } catch {
        this.options.registry.recordDiagnostic({
          kind: "cancellation",
          code: "BRIDGE_TERMINALIZATION_FAILED",
          ...(isValidRunId(runId) ? { runId } : {}),
        });
      }
    }

    let stopStatus: CancellationStopStatus = "not-requested";
    if (runId !== undefined) {
      stopStatus = "unknown";
      const stopCoordinator =
        current !== undefined &&
        (current.phase === "IMPLEMENTING" || current.phase === "CODE_REVIEW")
          ? (this.options.stopImplementationCoordinator ??
            this.options.stopCoordinator ??
            this.options.stopPlanningCoordinator)
          : (this.options.stopPlanningCoordinator ??
            this.options.stopCoordinator ??
            this.options.stopImplementationCoordinator);
      if (stopCoordinator === undefined) {
        this.options.registry.recordDiagnostic({
          kind: "cancellation",
          code: "COORDINATOR_STOP_UNAVAILABLE",
          runId,
        });
      } else {
        try {
          stopStatus = stopStatusFromReply(await stopCoordinator(runId));
        } catch {
          stopStatus = "failed";
        }
        if (stopStatus === "failed" || stopStatus === "unknown") {
          this.options.registry.recordDiagnostic({
            kind: "cancellation",
            code:
              stopStatus === "failed"
                ? "COORDINATOR_STOP_FAILED"
                : "COORDINATOR_STOP_UNKNOWN",
            runId,
          });
        }
      }
    }

    this.options.registry.recordCancellationOutcome({
      ...(runId === undefined ? {} : { coordinatorRunId: runId }),
      stop: stopStatus,
    });
    const state = this.options.registry.getState() ?? transition.state;
    return {
      accepted: true,
      duplicate: false,
      state,
      stopStatus,
    };
  }
}
