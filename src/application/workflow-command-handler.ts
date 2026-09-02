import type { RunId } from "../domain/primitives/ids.js";
import type { WorkflowState } from "../ports/run-reader.js";
import type { CancellationRequestOptions } from "./recovery/cancellation-lifecycle.js";
import type { UserInteraction } from "../ports/user-interaction.js";

export const START_WORKFLOW_COMMANDS = [
  "feature",
  "bug",
  "hotfix",
  "chore",
  "refactor",
  "investigation",
] as const;

export type StartWorkflowCommand = (typeof START_WORKFLOW_COMMANDS)[number];

export type WorkflowCommand = StartWorkflowCommand | "status" | "resume" | "cancel";
export type WorkflowCommandOutput = string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function text(value: unknown, limit = 96): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const compact = value.trim().replace(/\s+/g, " ");
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

function field(
  source: Record<string, unknown> | undefined,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = text(source?.[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function stepEntries(state: WorkflowState): {
  available: boolean;
  steps: readonly Record<string, unknown>[];
} {
  const value = state.snapshot?.steps?.steps;
  if (!Array.isArray(value)) return { available: false, steps: [] };
  return {
    available: true,
    steps: value.flatMap((entry) => {
      const step = record(entry);
      return step === undefined ? [] : [step];
    }),
  };
}

function currentStep(state: WorkflowState): Record<string, unknown> | undefined {
  const current = record(state.run.current_step);
  if (current !== undefined && field(current, "id", "step_id") !== undefined) return current;

  const { steps } = stepEntries(state);
  return (
    steps.find((step) =>
      ["running", "blocked", "ready", "pending"].includes(field(step, "status") ?? ""),
    ) ?? current
  );
}

function milestone(state: WorkflowState): string {
  const step = currentStep(state);
  const id = field(step, "id", "step_id") ?? "-";
  const type = field(step, "type");
  return type === undefined || id === "-" ? id : `${id}(${type})`;
}

function progress(state: WorkflowState): string {
  const { available, steps } = stepEntries(state);
  if (!available) return "unknown";
  const completed = steps.filter((step) =>
    ["completed", "skipped"].includes(field(step, "status") ?? ""),
  ).length;
  return `${completed}/${steps.length}`;
}

function blocker(state: WorkflowState): string {
  const blocked = record(state.run.blocked);
  const blockedReason = field(blocked, "reason", "code", "kind");
  if (blockedReason !== undefined) return blockedReason;
  if (blocked !== undefined) {
    const decisionId = field(blocked, "decision_id", "decisionId");
    if (decisionId !== undefined) return `decision:${decisionId}`;
    return "blocked";
  }

  const step = currentStep(state);
  const blockedBy = step?.blocked_by;
  if (Array.isArray(blockedBy)) {
    const dependency = blockedBy.find((value): value is string => typeof value === "string");
    if (dependency !== undefined) return `step:${text(dependency) ?? dependency}`;
    if (blockedBy.length > 0) return "step";
  }

  const decisions = state.snapshot?.decisions?.decisions;
  if (Array.isArray(decisions)) {
    const pending = decisions.find((decision) => {
      const value = record(decision);
      return field(value, "status") === "pending";
    });
    if (pending !== undefined) return `decision:${field(record(pending), "id") ?? "pending"}`;
  }

  const failure = record(state.run.failure);
  const failureReason = field(failure, "reason", "code");
  if (failureReason !== undefined) return `failure:${failureReason}`;
  if (failure !== undefined || state.run.status === "failed") return "failure";
  return state.run.status === "blocked" ? "blocked" : "-";
}

function outcome(state: WorkflowState): Record<string, unknown> | undefined {
  return record(state.run.outcome);
}

function outcomeArtifact(value: Record<string, unknown> | undefined): string {
  const path = field(value, "artifact_path");
  if (path !== undefined) return path;
  const paths = value?.artifact_paths;
  if (Array.isArray(paths)) {
    const count = paths.filter((artifactPath) => typeof artifactPath === "string").length;
    if (count > 0) return `${count} artifact${count === 1 ? "" : "s"}`;
  }
  return "-";
}

export function renderWorkflowProgress(state: WorkflowState): WorkflowCommandOutput {
  return `Run ${state.run.run_id}: status=${state.run.status}; finalized=${String(state.run.finalized)}; revision=${String(state.run.state_revision)}; milestone=${milestone(state)}; progress=${progress(state)}; blocker=${blocker(state)}`;
}

export function renderWorkflowFinalResponse(state: WorkflowState): WorkflowCommandOutput {
  const finalOutcome = outcome(state);
  const status = field(finalOutcome, "status") ?? state.run.status;
  const requestSatisfied =
    typeof finalOutcome?.request_satisfied === "boolean"
      ? String(finalOutcome.request_satisfied)
      : "-";
  const summary = field(finalOutcome, "summary") ?? "-";
  return `Run ${state.run.run_id}: status=${state.run.status}; finalized=${String(state.run.finalized)}; revision=${String(state.run.state_revision)}; outcome=${status}; request_satisfied=${requestSatisfied}; summary=${summary}; artifact=${outcomeArtifact(finalOutcome)}`;
}

export function renderWorkflowResponse(state: WorkflowState): WorkflowCommandOutput {
  return state.run.finalized ? renderWorkflowFinalResponse(state) : renderWorkflowProgress(state);
}

export interface StartWorkflowUseCase {
  execute(
    command: StartWorkflowCommand,
    args: string,
    userInteraction?: UserInteraction,
  ): Promise<WorkflowState | void>;
}

export interface StatusWorkflowUseCase {
  execute(runId: RunId): Promise<WorkflowState>;
}

export interface ResumeWorkflowUseCase {
  execute(runId: RunId, userInteraction?: UserInteraction): Promise<WorkflowState>;
}

export interface CancelWorkflowUseCase {
  execute(runId: RunId, options?: CancellationRequestOptions): Promise<WorkflowState>;
}

export interface WorkflowCommandHandler {
  execute(
    command: WorkflowCommand,
    args: string,
    userInteraction?: UserInteraction,
    context?: unknown,
  ): Promise<WorkflowCommandOutput | void>;
}
