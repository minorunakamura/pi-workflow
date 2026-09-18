import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  REQUIRED_PLAN_HEADINGS,
  createPlanningHandoff,
  createRunId,
  createWorkflowId,
  hashPlan,
} from "../../src/core/index.ts";
import {
  PLANNOTATOR_REQUEST_EVENT,
  PLANNOTATOR_REVIEW_RESULT_EVENT,
  PlanReviewRootBridge,
  isPlanReviewRequest,
} from "../../src/runtime/plan-review.ts";
import { RootWorkflowRegistry } from "../../src/runtime/root-lifecycle.ts";

const WORKFLOW_ID = createWorkflowId("00000000-0000-4000-8000-000000000011");
const PLAN = `${REQUIRED_PLAN_HEADINGS.join("\n")}\n\nBounded plan.\n`;
const roots: string[] = [];

class FakeEventBus {
  private readonly handlers = new Map<string, Set<(value: unknown) => void>>();

  public on(event: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(event);
    };
  }

  public emit(event: string, value: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) {
      handler(value);
    }
  }
}

function writeArtifacts(
  root: string,
  content: string,
): {
  planPath: string;
  handoffPath: string;
  hash: string;
} {
  const planPath = join(root, "implementation-plan.md");
  const handoffPath = join(root, "planning-handoff.json");
  writeFileSync(planPath, content);
  const handoff = createPlanningHandoff({
    workflowId: WORKFLOW_ID,
    planContent: content,
    tddMode: "required",
    testStrategy: {
      kind: "unit",
      required: true,
      summary: "Run focused tests.",
    },
    testSeams: ["Plan Review bridge"],
    constraints: ["Keep approval Root-owned."],
    nonGoals: ["Do not implement the next phase."],
    planningRunId: createRunId("planning-run"),
  });
  if (!handoff.valid) throw new Error(handoff.errors.join("; "));
  writeFileSync(handoffPath, `${JSON.stringify(handoff.value)}\n`);
  return { planPath, handoffPath, hash: hashPlan(content).value };
}

function planningResult(handoffPath: string, planPath: string) {
  return {
    contractVersion: 1 as const,
    workflowId: WORKFLOW_ID,
    status: "COMPLETED" as const,
    planArtifactRef: {
      kind: "managed" as const,
      path: planPath,
      mediaType: "text/markdown" as const,
    },
    planningHandoffRef: {
      kind: "managed" as const,
      path: handoffPath,
      mediaType: "application/json" as const,
    },
    selectedCapabilities: [
      { capability: "scout" as const, reason: "Repository evidence." },
      {
        capability: "plan-composition" as const,
        reason: "A Plan Artifact is required.",
      },
    ],
    skippedCapabilities: [
      { capability: "researcher" as const, reason: "No external fact." },
      { capability: "grilling" as const, reason: "No ambiguity remains." },
      {
        capability: "human-decision" as const,
        reason: "No product choice remains.",
      },
      {
        capability: "targeted-rescout" as const,
        reason: "Scout assumptions remain current.",
      },
      { capability: "oracle" as const, reason: "No strategy challenge." },
    ],
    remainingBlockers: [],
  };
}

function readyRegistry(artifacts: { planPath: string; handoffPath: string }) {
  const registry = new RootWorkflowRegistry(() => undefined);
  expect(registry.start(WORKFLOW_ID, "feature").started).toBe(true);
  expect(
    registry.setPlanningRunId(createRunId("planning-run")).transitioned,
  ).toBe(true);
  expect(
    registry.completePlanning(
      "planning-run",
      planningResult(artifacts.handoffPath, artifacts.planPath),
    ).transitioned,
  ).toBe(true);
  return registry;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  await Promise.resolve();
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it("opens direct plan-review, records Root approval, and never uses plan mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-plan-review-"));
  roots.push(root);
  const artifacts = writeArtifacts(root, PLAN);
  const registry = readyRegistry(artifacts);
  const events = new FakeEventBus();
  const actions: string[] = [];
  events.on(PLANNOTATOR_REQUEST_EVENT, (value) => {
    if (!isPlanReviewRequest(value)) return;
    actions.push(value.action);
    if (value.action === "plan-review") {
      value.respond({
        status: "handled",
        result: { status: "pending", reviewId: "review-1" },
      });
    }
  });

  const bridge = new PlanReviewRootBridge({
    events,
    registry,
    timeoutMs: 1_000,
  });
  const started = await bridge.start();
  expect(started).toMatchObject({ started: true, reviewId: "review-1" });
  events.emit(PLANNOTATOR_REVIEW_RESULT_EVENT, {
    reviewId: "review-1",
    approved: true,
    feedback: "Approved as written.",
  });
  await settle();

  expect(registry.getState()).toMatchObject({
    phase: "PLAN_REVIEW",
    approval: true,
    reviewId: "review-1",
    approvedPlanHash: hashPlan(PLAN).value,
  });
  expect(registry.getState()).not.toHaveProperty("pendingInteraction");
  expect(actions).toEqual(["plan-review"]);
  expect(readFileSync(artifacts.handoffPath, "utf8")).not.toContain("review-1");

  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  expect(registry.getState()).toMatchObject({ approval: true });
  bridge.dispose();
});

it("supports review-status recovery and keeps rejection in PLAN_REVIEW", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-plan-status-"));
  roots.push(root);
  const artifacts = writeArtifacts(root, PLAN);
  const registry = readyRegistry(artifacts);
  const events = new FakeEventBus();
  const actions: string[] = [];
  events.on(PLANNOTATOR_REQUEST_EVENT, (value) => {
    if (!isPlanReviewRequest(value)) return;
    actions.push(value.action);
    if (value.action === "plan-review") {
      value.respond({
        status: "handled",
        result: { status: "pending", reviewId: "review-status" },
      });
      return;
    }
    value.respond({
      status: "handled",
      result: {
        status: "completed",
        reviewId: "review-status",
        approved: false,
        feedback: "Please clarify the constraints.",
      },
    });
  });

  const bridge = new PlanReviewRootBridge({
    events,
    registry,
    timeoutMs: 5,
  });
  expect((await bridge.start()).started).toBe(true);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  expect(actions).toEqual(["plan-review", "review-status"]);
  expect(registry.getState()).toMatchObject({
    phase: "PLAN_REVIEW",
    approval: false,
    reviewId: "review-status",
    approvalFeedback: "Please clarify the constraints.",
  });
  bridge.dispose();
});

it("rejects changed Plan content and permits one fresh resubmission only", async () => {
  const firstRoot = mkdtempSync(join(tmpdir(), "pi-workflow-plan-first-"));
  const secondInitialRoot = mkdtempSync(
    join(tmpdir(), "pi-workflow-plan-second-initial-"),
  );
  const secondRoot = mkdtempSync(join(tmpdir(), "pi-workflow-plan-second-"));
  roots.push(firstRoot, secondInitialRoot, secondRoot);
  const first = writeArtifacts(firstRoot, PLAN);
  const registry = readyRegistry(first);
  const events = new FakeEventBus();
  const reviewIds = ["review-first", "review-second"];
  events.on(PLANNOTATOR_REQUEST_EVENT, (value) => {
    if (!isPlanReviewRequest(value) || value.action !== "plan-review") return;
    const reviewId = reviewIds.shift();
    if (reviewId === undefined) return;
    value.respond({
      status: "handled",
      result: { status: "pending", reviewId },
    });
  });
  const bridge = new PlanReviewRootBridge({
    events,
    registry,
    timeoutMs: 1_000,
  });

  expect((await bridge.start()).started).toBe(true);
  writeFileSync(first.planPath, `${PLAN}changed after review\n`);
  events.emit(PLANNOTATOR_REVIEW_RESULT_EVENT, {
    reviewId: "review-first",
    approved: true,
  });
  await settle();
  expect(registry.getState()).toMatchObject({
    phase: "FAILED",
    finalStatus: "FAILED",
  });
  bridge.dispose();

  const secondInitial = writeArtifacts(secondInitialRoot, PLAN);
  const secondRegistry = readyRegistry(secondInitial);
  const secondEvents = new FakeEventBus();
  const secondIds = ["review-rejected", "review-resubmitted"];
  secondEvents.on(PLANNOTATOR_REQUEST_EVENT, (value) => {
    if (!isPlanReviewRequest(value) || value.action !== "plan-review") return;
    const reviewId = secondIds.shift();
    if (reviewId === undefined) return;
    value.respond({
      status: "handled",
      result: { status: "pending", reviewId },
    });
  });
  const secondBridge = new PlanReviewRootBridge({
    events: secondEvents,
    registry: secondRegistry,
    timeoutMs: 1_000,
  });
  expect((await secondBridge.start()).started).toBe(true);
  secondEvents.emit(PLANNOTATOR_REVIEW_RESULT_EVENT, {
    reviewId: "review-rejected",
    approved: false,
    feedback: "Revise the plan.",
  });
  await settle();
  expect(secondRegistry.preparePlanResubmission().transitioned).toBe(true);
  const newRun = createRunId("planning-run-2");
  expect(secondRegistry.setPlanningRunId(newRun).transitioned).toBe(true);
  const replacement = writeArtifacts(
    secondRoot,
    PLAN.replace("Bounded plan.", "Fresh bounded plan."),
  );
  const completion = secondRegistry.completePlanning(
    newRun,
    planningResult(replacement.handoffPath, replacement.planPath),
  );
  expect(completion.transitioned).toBe(true);

  expect((await secondBridge.start()).started).toBe(true);
  secondEvents.emit(PLANNOTATOR_REVIEW_RESULT_EVENT, {
    reviewId: "review-resubmitted",
    approved: false,
    feedback: "The revised plan is still incomplete.",
  });
  await settle();
  expect(secondRegistry.getState()).toMatchObject({
    phase: "PLAN_REVIEW",
    planResubmissionCount: 1,
    planningRunId: newRun,
    approval: false,
    reviewId: "review-resubmitted",
    planningHandoffRef: { path: replacement.handoffPath },
    approvalFeedback: "The revised plan is still incomplete.",
  });
  expect(secondRegistry.preparePlanResubmission().transitioned).toBe(false);
  secondBridge.dispose();
});
