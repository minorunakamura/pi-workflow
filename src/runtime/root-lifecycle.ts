import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  canStartWorkflow,
  createInitialWorkflowState,
  isActivePhase,
  isValidWorkflowId,
  isWorkflowType,
  transitionRootWorkflowState,
  validateRootWorkflowState,
  type RootWorkflowState,
  type WorkflowPhase,
} from "../core/index.ts";
import { isRecord } from "../core/validation.ts";

export const ROOT_LIFECYCLE_ENTRY_TYPE = "pi-workflow.lifecycle.v1" as const;

type AppendEntry = (customType: string, data?: unknown) => void;

export type StartWorkflowResult =
  | { started: true; state: RootWorkflowState }
  | {
      started: false;
      reason:
        | "ACTIVE_WORKFLOW_EXISTS"
        | "INVALID_WORKFLOW_IDENTITY"
        | "INVALID_STATE"
        | "PERSISTENCE_FAILED";
    };

export type RegistryTransitionResult =
  | { transitioned: true; state: RootWorkflowState }
  | { transitioned: false; reason: string };

function cloneState(state: RootWorkflowState): RootWorkflowState {
  return structuredClone(state);
}

function isLifecycleEntry(value: unknown): value is {
  type: "custom";
  customType: typeof ROOT_LIFECYCLE_ENTRY_TYPE;
  data?: unknown;
} {
  return (
    isRecord(value) &&
    value.type === "custom" &&
    value.customType === ROOT_LIFECYCLE_ENTRY_TYPE
  );
}

function readLatestRootWorkflowState(
  entries: readonly unknown[],
): RootWorkflowState | undefined {
  let latest: RootWorkflowState | undefined;
  for (const entry of entries) {
    if (!isLifecycleEntry(entry)) {
      continue;
    }
    const validation = validateRootWorkflowState(entry.data);
    if (validation.valid) {
      latest = cloneState(validation.value);
    }
  }
  return latest;
}

export function restoreRootWorkflowState(
  entries: readonly unknown[],
): RootWorkflowState | undefined {
  const latest = readLatestRootWorkflowState(entries);
  if (latest === undefined || !isActivePhase(latest.phase)) {
    return latest;
  }
  const stale = transitionRootWorkflowState(latest, "FAILED");
  return stale.valid ? stale.state : undefined;
}

export function persistRootWorkflowState(
  appendEntry: AppendEntry,
  state: RootWorkflowState,
): void {
  const validation = validateRootWorkflowState(state);
  if (!validation.valid) {
    throw new TypeError("Cannot persist an invalid Root workflow state");
  }
  appendEntry(ROOT_LIFECYCLE_ENTRY_TYPE, cloneState(validation.value));
}

export class RootWorkflowRegistry {
  private state: RootWorkflowState | undefined;

  public constructor(private readonly appendEntry: AppendEntry) {}

  public getState(): RootWorkflowState | undefined {
    return this.state === undefined ? undefined : cloneState(this.state);
  }

  public restore(entries: readonly unknown[]): RootWorkflowState | undefined {
    const restored = readLatestRootWorkflowState(entries);
    if (restored === undefined || !isActivePhase(restored.phase)) {
      this.state = restored;
      return this.getState();
    }

    const stale = transitionRootWorkflowState(restored, "FAILED");
    if (!stale.valid) {
      this.state = undefined;
      return undefined;
    }
    this.state = stale.state;
    persistRootWorkflowState(this.appendEntry, stale.state);
    return this.getState();
  }

  public shutdown(): void {
    const current = this.state;
    try {
      if (current !== undefined && isActivePhase(current.phase)) {
        const stale = transitionRootWorkflowState(current, "FAILED");
        if (!stale.valid) {
          throw new Error(stale.reason);
        }
        this.state = stale.state;
        persistRootWorkflowState(this.appendEntry, stale.state);
      }
    } finally {
      this.clear();
    }
  }

  public clear(): void {
    this.state = undefined;
  }

  public start(
    workflowId: unknown,
    workflowType: unknown,
  ): StartWorkflowResult {
    if (!isValidWorkflowId(workflowId) || !isWorkflowType(workflowType)) {
      return { started: false, reason: "INVALID_WORKFLOW_IDENTITY" };
    }
    if (!canStartWorkflow(this.state)) {
      return { started: false, reason: "ACTIVE_WORKFLOW_EXISTS" };
    }

    const initial = createInitialWorkflowState(workflowId, workflowType);
    const transition = transitionRootWorkflowState(initial, "PLANNING");
    if (!transition.valid) {
      return { started: false, reason: "INVALID_STATE" };
    }
    try {
      return { started: true, state: this.commit(transition.state) };
    } catch {
      return { started: false, reason: "PERSISTENCE_FAILED" };
    }
  }

  public transition(to: WorkflowPhase): RegistryTransitionResult {
    if (this.state === undefined) {
      return { transitioned: false, reason: "No Root workflow exists" };
    }
    const transition = transitionRootWorkflowState(this.state, to);
    if (!transition.valid) {
      return { transitioned: false, reason: transition.reason };
    }
    try {
      return { transitioned: true, state: this.commit(transition.state) };
    } catch {
      return { transitioned: false, reason: "Persistence failed" };
    }
  }

  private commit(state: RootWorkflowState): RootWorkflowState {
    const next = cloneState(state);
    persistRootWorkflowState(this.appendEntry, next);
    this.state = next;
    return cloneState(next);
  }
}

export function createRootWorkflowRegistry(
  pi: Pick<ExtensionAPI, "appendEntry">,
): RootWorkflowRegistry {
  return new RootWorkflowRegistry((customType, data) => {
    pi.appendEntry(customType, data);
  });
}
