import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { RootWorkflowRegistry } from "../runtime/root-lifecycle.ts";
import type { RootWorkflowState } from "../core/index.ts";
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
  const resultDelivery = registerResultDeliveryObservation(pi.events, {
    sessionId,
    isRelevantRun: isPlanningRun,
    onAckFailure: (runId) => {
      if (isPlanningRun(runId)) {
        registry.transition("FAILED");
      }
    },
    onUntrustedCompletion: (runId) => {
      if (isPlanningRun(runId)) {
        registry.transition("FAILED");
      }
    },
  });
  const lifecycle = registerSubagentLifecycleObservation(pi.events, {
    sessionId,
    isRelevantRun: isPlanningRun,
    onComplete: (record) => {
      const state = registry.getState();
      if (state?.planningRunId !== record.runId) return;
      if (
        record.success === false ||
        PLANNING_FAILURE_STATES.has(record.state ?? "")
      ) {
        registry.transition("FAILED");
      }
    },
    onConflict: (runId) => {
      if (isPlanningRun(runId)) {
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
  return () => {
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
): void {
  let removeLifecycleObservation: (() => void) | undefined;
  let humanDecisionBridge: HumanDecisionRootBridge | undefined;
  let planReviewBridge: PlanReviewRootBridge | undefined;
  let codeReviewBridge: CodeReviewRootBridge | undefined;

  pi.on("session_start", (_event, ctx) => {
    removeLifecycleObservation?.();
    removeLifecycleObservation = undefined;
    humanDecisionBridge?.dispose();
    humanDecisionBridge = undefined;
    planReviewBridge?.dispose();
    planReviewBridge = undefined;
    codeReviewBridge?.dispose();
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
              stopImplementationCoordinator: stopPlanningCoordinator,
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

  pi.on("session_shutdown", async () => {
    const current = registry.getState();
    const planningRunId =
      registry.hasActiveWorkflow() && current?.planningStatus === "RUNNING"
        ? current.planningRunId
        : undefined;
    humanDecisionBridge?.dispose();
    humanDecisionBridge = undefined;
    planReviewBridge?.dispose();
    planReviewBridge = undefined;
    codeReviewBridge?.dispose();
    codeReviewBridge = undefined;
    if (planningRunId !== undefined && stopPlanningCoordinator !== undefined) {
      try {
        await stopPlanningCoordinator(planningRunId);
      } catch {
        // Shutdown remains fail-closed when the public stop request fails.
      }
    }

    try {
      registry.shutdown();
    } finally {
      try {
        removeLifecycleObservation?.();
      } finally {
        removeLifecycleObservation = undefined;
        cleanup?.();
      }
    }
  });
}
