import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { RootWorkflowRegistry } from "../runtime/root-lifecycle.ts";
import type { RootWorkflowState } from "../core/index.ts";
import { RootCancellationController } from "../runtime/cancellation.ts";
import { registerImplementationCompletionObservation } from "../runtime/implementation-completion.ts";
import { registerPlanningCompletionObservation } from "../runtime/planning-completion.ts";
import { registerResultDeliveryObservation } from "../runtime/result-delivery.ts";
import {
  registerHumanDecisionRootBridge,
  type HumanDecisionRootBridge,
} from "../runtime/human-decision-bridge.ts";
import {
  registerPlanReviewRootBridge,
  type PlanReviewRootBridge,
} from "../runtime/plan-review.ts";
import {
  registerCodeReviewRootBridge,
  type CodeReviewRootBridge,
} from "../runtime/code-review-bridge.ts";
import {
  registerSubagentLifecycleObservation,
  type ImplementationCoordinatorLaunchResult,
  type PlanningCoordinatorLaunchResult,
} from "../runtime/subagents-rpc.ts";

const PLANNING_FAILURE_STATES = new Set([
  "failed",
  "partial",
  "paused",
  "stopped",
  "rejected",
]);

type SessionIdentitySource = {
  getSessionFile(): string | null | undefined;
  getSessionId(): string | null | undefined;
};

function currentSessionIdentity(
  sessionManager: SessionIdentitySource,
): string | undefined {
  const identity =
    sessionManager.getSessionFile() ?? sessionManager.getSessionId();
  return identity || undefined;
}

export function registerSubagentLifecycle(
  pi: Pick<ExtensionAPI, "events">,
  registry: RootWorkflowRegistry,
  sessionId: string,
  planReview?: PlanReviewRootBridge,
): () => void {
  const isPlanningRun = (runId: string): boolean => {
    const state = registry.getState();
    return (
      state !== undefined &&
      (state.phase === "PLANNING" || state.phase === "PLAN_REVIEW") &&
      state.planningStatus === "RUNNING" &&
      state.planningRunId === runId
    );
  };
  const isImplementationRun = (runId: string): boolean => {
    const state = registry.getState();
    return (
      state !== undefined &&
      (state.phase === "IMPLEMENTING" || state.phase === "CODE_REVIEW") &&
      state.implementationRunId === runId
    );
  };
  const isCoordinatorRun = (runId: string): boolean =>
    isPlanningRun(runId) || isImplementationRun(runId);
  const isKnownCoordinatorRun = (runId: string): boolean => {
    const state = registry.getState();
    return (
      state !== undefined &&
      (state.planningRunId === runId || state.implementationRunId === runId)
    );
  };
  const resultDelivery = registerResultDeliveryObservation(pi.events, {
    sessionId,
    isRelevantRun: isCoordinatorRun,
    onAckFailure: (runId, status) => {
      if (isCoordinatorRun(runId)) {
        registry.recordDiagnostic({
          kind: "conflict",
          code: `RESULT_DELIVERY_${status.toUpperCase()}`,
          runId,
        });
        registry.transition("FAILED");
      }
    },
    onUntrustedCompletion: (runId, status) => {
      if (isCoordinatorRun(runId)) {
        if (status === "conflict") {
          registry.recordDiagnostic({
            kind: "conflict",
            code: "RESULT_DELIVERY_CONFLICT",
            runId,
          });
        }
        registry.transition("FAILED");
      }
    },
  });
  const lifecycle = registerSubagentLifecycleObservation(pi.events, {
    sessionId,
    isRelevantRun: isCoordinatorRun,
    onComplete: (record) => {
      const state = registry.getState();
      if (state === undefined) return;
      const planningRun = state.planningRunId === record.runId;
      const implementationRun = state.implementationRunId === record.runId;
      if (!planningRun && !implementationRun) return;
      if (
        record.success === false ||
        PLANNING_FAILURE_STATES.has(record.state ?? "")
      ) {
        registry.transition("FAILED");
      }
    },
    onConflict: (runId) => {
      if (isKnownCoordinatorRun(runId)) {
        registry.recordDiagnostic({
          kind: "conflict",
          code: "COORDINATOR_COMPLETION_CONFLICT",
          runId,
        });
        registry.transition("FAILED");
      }
    },
  });
  const planningCompletion = registerPlanningCompletionObservation(
    pi.events,
    registry,
    sessionId,
    resultDelivery,
    planReview === undefined
      ? undefined
      : {
          onPlanningCompleted: (state) => {
            void planReview.start(state);
          },
        },
  );
  const implementationCompletion = registerImplementationCompletionObservation(
    pi.events,
    registry,
    sessionId,
    resultDelivery,
  );
  return () => {
    implementationCompletion.dispose();
    planningCompletion.dispose();
    lifecycle();
    resultDelivery.dispose();
  };
}

export function beforeTreeNavigation(
  registry: RootWorkflowRegistry,
): { cancel: true } | undefined {
  return registry.hasActiveWorkflow() ? { cancel: true } : undefined;
}

export function registerSessionLifecycle(
  pi: Pick<ExtensionAPI, "on"> & Partial<Pick<ExtensionAPI, "events">>,
  registry: RootWorkflowRegistry,
  cleanup?: () => void,
  stopPlanningCoordinator?: (runId: string) => Promise<unknown>,
  launchFreshPlanningCoordinator?: () => Promise<PlanningCoordinatorLaunchResult>,
  launchFreshImplementationCoordinator?: (
    state: RootWorkflowState,
  ) => Promise<ImplementationCoordinatorLaunchResult>,
  stopImplementationCoordinator?: (runId: string) => Promise<unknown>,
): RootCancellationController {
  let removeLifecycleObservation: (() => void) | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let humanDecisionBridge: HumanDecisionRootBridge | undefined;
  let planReviewBridge: PlanReviewRootBridge | undefined;
  let codeReviewBridge: CodeReviewRootBridge | undefined;
  const cancellation = new RootCancellationController({
    registry,
    getBridges: () => [humanDecisionBridge, planReviewBridge, codeReviewBridge],
    ...(stopPlanningCoordinator === undefined
      ? {}
      : { stopPlanningCoordinator }),
    ...(stopImplementationCoordinator === undefined
      ? {}
      : { stopImplementationCoordinator }),
  });

  pi.on("session_start", (_event, ctx) => {
    shutdownPromise = undefined;
    removeLifecycleObservation?.();
    removeLifecycleObservation = undefined;
    humanDecisionBridge?.dispose({ preserveRootState: true });
    humanDecisionBridge = undefined;
    planReviewBridge?.dispose({ preserveRootState: true });
    planReviewBridge = undefined;
    codeReviewBridge?.dispose({ preserveRootState: true });
    codeReviewBridge = undefined;
    registry.restore(ctx.sessionManager.getBranch());
    const events = pi.events;
    const sessionId = currentSessionIdentity(ctx.sessionManager);
    if (events !== undefined && sessionId !== undefined) {
      humanDecisionBridge = registerHumanDecisionRootBridge({
        events,
        registry,
        sessionId,
        mode: ctx.mode,
      });
      planReviewBridge = registerPlanReviewRootBridge({
        events,
        registry,
        ...(launchFreshPlanningCoordinator === undefined
          ? {}
          : { launchFreshPlanningCoordinator }),
        ...(launchFreshImplementationCoordinator === undefined
          ? {}
          : { launchFreshImplementationCoordinator }),
        ...(stopPlanningCoordinator === undefined
          ? {}
          : {
              stopPlanningCoordinator,
              stopImplementationCoordinator:
                stopImplementationCoordinator ?? stopPlanningCoordinator,
            }),
      });
      codeReviewBridge = registerCodeReviewRootBridge({
        events,
        registry,
        sessionId,
        intercom: humanDecisionBridge,
      });
      removeLifecycleObservation = registerSubagentLifecycle(
        { events },
        registry,
        sessionId,
        planReviewBridge,
      );
    }
  });

  pi.on("session_before_tree", () => beforeTreeNavigation(registry));

  pi.on("session_tree", (_event, ctx) => {
    registry.restore(ctx.sessionManager.getBranch());
  });

  pi.on("session_shutdown", (event) => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownPromise = (async () => {
      const current = registry.getState();
      if (
        event?.reason === "quit" &&
        current !== undefined &&
        registry.hasActiveWorkflow()
      ) {
        removeLifecycleObservation?.();
        removeLifecycleObservation = undefined;
        try {
          await cancellation.requestWorkflowCancellation(current.workflowId);
        } catch {
          // Cancellation remains fail-closed if the Root request cannot complete.
        }
        humanDecisionBridge = undefined;
        planReviewBridge = undefined;
        codeReviewBridge = undefined;
        try {
          registry.shutdown();
        } finally {
          cleanup?.();
        }
        return;
      }

      const planningRunId =
        registry.hasActiveWorkflow() &&
        (current?.phase === "PLANNING" ||
          (current?.phase === "PLAN_REVIEW" &&
            current.planningStatus === "RUNNING"))
          ? current.planningRunId
          : undefined;
      const implementationRunId =
        registry.hasActiveWorkflow() &&
        (current?.phase === "IMPLEMENTING" || current?.phase === "CODE_REVIEW")
          ? current.implementationRunId
          : undefined;

      removeLifecycleObservation?.();
      removeLifecycleObservation = undefined;
      humanDecisionBridge?.dispose({ preserveRootState: true });
      humanDecisionBridge = undefined;
      planReviewBridge?.dispose({ preserveRootState: true });
      planReviewBridge = undefined;
      codeReviewBridge?.dispose({ preserveRootState: true });
      codeReviewBridge = undefined;

      const shutdownStopCoordinator =
        implementationRunId === undefined
          ? stopPlanningCoordinator
          : (stopImplementationCoordinator ?? stopPlanningCoordinator);
      const runId = implementationRunId ?? planningRunId;
      if (runId !== undefined && shutdownStopCoordinator !== undefined) {
        try {
          await shutdownStopCoordinator(runId);
        } catch {
          // Shutdown remains fail-closed when the public stop request fails.
        }
      }

      try {
        registry.shutdown();
      } finally {
        try {
          removeLifecycleObservation = undefined;
        } finally {
          cleanup?.();
        }
      }
    })();
    return shutdownPromise;
  });

  return cancellation;
}
