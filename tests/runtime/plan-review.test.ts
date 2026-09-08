import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runPlanReview } from "../../src/runtime/plannotator/plan-review";
import {
  PLANNOTATOR_REQUEST_CHANNEL,
  PLANNOTATOR_REVIEW_RESULT_CHANNEL,
  type PiEventBus,
} from "../../src/runtime/plannotator/request";
import type { PlanningDecisionV1 } from "../../src/core/planning/planning-decision";

const decision: PlanningDecisionV1 = {
  version: 1,
  requestSummary: "Add a search endpoint.",
  scope: { inScope: ["Search endpoint"], outOfScope: ["UI changes"] },
  acceptanceCriteria: [{ id: "ac-search", text: "Searches records." }],
  constraints: ["Keep the API compatible."],
  risks: ["Large result sets may be slow."],
  verification: [
    {
      id: "verify-search",
      description: "Search tests pass.",
      command: "pnpm test",
    },
  ],
  implementation: {
    mode: "single",
    workUnits: [
      {
        id: "search-api",
        title: "Implement search",
        objective: "Add the endpoint.",
        dependsOn: [],
        writeScope: ["src/api/search.ts"],
        acceptanceCriteriaIds: ["ac-search"],
        focusedVerificationIds: ["verify-search"],
      },
    ],
    finalVerificationIds: ["verify-search"],
  },
  unresolvedDecisions: [],
};

type Request = {
  action: string;
  payload: Record<string, unknown>;
  respond: (response: unknown) => void;
};

class FakeEventBus implements PiEventBus {
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();
  status: "pending" | "completed" = "pending";
  result: {
    reviewId: string;
    approved: boolean;
    feedback?: string;
  } = { reviewId: "review-1", approved: true };
  requestCount = 0;

  emit(channel: string, data: unknown): void {
    if (channel === PLANNOTATOR_REQUEST_CHANNEL) {
      const request = data as Request;
      this.requestCount += 1;
      if (request.action === "plan-review") {
        request.respond({
          status: "handled",
          result: { status: "pending", reviewId: this.result.reviewId },
        });
        return;
      }
      if (request.action === "review-status") {
        request.respond({
          status: "handled",
          result:
            this.status === "completed"
              ? { status: "completed", ...this.result }
              : { status: "pending" },
        });
        if (this.status === "pending") {
          setTimeout(() => this.emitReviewResult(), 0);
        }
        return;
      }
    }

    for (const listener of this.listeners.get(channel) ?? []) listener(data);
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    const handlers = this.listeners.get(channel) ?? new Set();
    handlers.add(handler);
    this.listeners.set(channel, handlers);
    return () => handlers.delete(handler);
  }

  emitReviewResult(): void {
    this.status = "completed";
    this.emit(PLANNOTATOR_REVIEW_RESULT_CHANNEL, this.result);
  }
}

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-workflow-plan-review-"));
}

describe("runPlanReview", () => {
  it("writes the canonical plan and accepts an explicit approval", async () => {
    const cwd = await tempProject();
    const events = new FakeEventBus();

    const result = await runPlanReview({ events }, cwd, {
      missionId: "mission-1",
      planningDecision: decision,
      round: 1,
    });

    expect(result).toMatchObject({
      approved: true,
      reviewId: "review-1",
      planPath: join(cwd, ".pi", "pi-workflow", "mission-1", "plan-r1.md"),
    });
    expect(await readFile(result.planPath, "utf8")).toContain("# Plan");
    expect(events.requestCount).toBe(2);
  });

  it("returns a rejection without treating it as approval", async () => {
    const cwd = await tempProject();
    const events = new FakeEventBus();
    events.result = {
      reviewId: "review-rejected",
      approved: false,
      feedback: "Clarify the verification command.",
    };

    const result = await runPlanReview({ events }, cwd, {
      missionId: "mission-2",
      planningDecision: decision,
      round: 2,
    });

    expect(result).toMatchObject({
      approved: false,
      feedback: "Clarify the verification command.",
    });
  });

  it("recovers a completed review through review-status", async () => {
    const cwd = await tempProject();
    const events = new FakeEventBus();
    events.status = "completed";
    events.result = { reviewId: "review-recovered", approved: true };

    const result = await runPlanReview({ events }, cwd, {
      missionId: "mission-3",
      planningDecision: decision,
      round: 1,
    });

    expect(result).toMatchObject({
      approved: true,
      reviewId: "review-recovered",
    });
  });

  it("blocks unresolved decisions before writing or requesting review", async () => {
    const cwd = await tempProject();
    const events = new FakeEventBus();
    const unresolved = structuredClone(decision);
    unresolved.unresolvedDecisions = [
      {
        id: "decision-1",
        question: "Which index should be used?",
        reason: "Evidence is incomplete.",
      },
    ];

    await expect(
      runPlanReview({ events }, cwd, {
        missionId: "mission-4",
        planningDecision: unresolved,
        round: 1,
      }),
    ).rejects.toThrow("unresolved decisions must be resolved");
    expect(events.requestCount).toBe(0);
  });

  it("fails closed when Plannotator is unavailable", async () => {
    const cwd = await tempProject();
    const events: PiEventBus = {
      emit: (_channel, data) => {
        const request = data as Request;
        request.respond({ status: "unavailable", error: "not installed" });
      },
      on: () => () => undefined,
    };

    await expect(
      runPlanReview({ events }, cwd, {
        missionId: "mission-5",
        planningDecision: decision,
        round: 1,
      }),
    ).rejects.toThrow("not installed");
  });
});
