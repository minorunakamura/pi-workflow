import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  recoverPlanReview,
  runPlanReview,
} from "../../src/runtime/plannotator/plan-review";
import {
  PLANNOTATOR_REQUEST_CHANNEL,
  PLANNOTATOR_REVIEW_RESULT_CHANNEL,
  type PiEventBus,
} from "../../src/runtime/plannotator/request";

class FakeEventBus implements PiEventBus {
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();
  status: "pending" | "completed" | "missing" = "pending";
  result: {
    reviewId: string;
    approved: boolean;
    feedback?: string;
  } = { reviewId: "review-1", approved: true };
  requestCount = 0;
  startPayload?: Record<string, unknown>;

  emit(channel: string, data: unknown): void {
    if (channel === PLANNOTATOR_REQUEST_CHANNEL) {
      const request = data as {
        action: string;
        payload: Record<string, unknown>;
        respond: (response: unknown) => void;
      };
      this.requestCount += 1;
      if (request.action === "plan-review") {
        this.startPayload = request.payload;
        request.respond({
          status: "handled",
          result: { status: "pending", reviewId: this.result.reviewId },
        });
        setTimeout(() => this.emitReviewResult(), 0);
        return;
      }
      if (request.action === "review-status") {
        request.respond({
          status: "handled",
          result:
            this.status === "completed"
              ? { status: "completed", ...this.result }
              : { status: this.status },
        });
        if (this.status === "pending")
          setTimeout(() => this.emitReviewResult(), 0);
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

async function planFile(
  content = "# Canonical Plan\n\nunit-marker\n",
): Promise<string> {
  const directory = await tempProject();
  const path = join(directory, "canonical-plan.md");
  await writeFile(path, content, "utf8");
  return path;
}

describe("runPlanReview", () => {
  it("reads the explicitly supplied canonical Plan Artifact", async () => {
    const planRef = await planFile();
    const events = new FakeEventBus();

    const result = await runPlanReview(
      { events },
      { missionId: "mission-1", round: 1, planRef },
    );

    expect(result).toEqual({
      approved: true,
      reviewId: "review-1",
      planRef,
    });
    expect(events.startPayload).toMatchObject({
      planFilePath: planRef,
      planContent: "# Canonical Plan\n\nunit-marker\n",
      origin: "pi-workflow",
    });
    expect(JSON.stringify(result)).not.toContain("unit-marker");
    expect(events.requestCount).toBe(1);
  });

  it("writes rejected feedback to a package-owned Artifact and returns only feedbackRef", async () => {
    const planRef = await planFile();
    const events = new FakeEventBus();
    events.result = {
      reviewId: "review-rejected",
      approved: false,
      feedback: "Clarify the verification command.",
    };

    const result = await runPlanReview(
      { events },
      { missionId: "mission-2", round: 2, planRef },
    );

    expect(result).toMatchObject({
      approved: false,
      reviewId: "review-rejected",
      planRef,
      feedbackRef: expect.stringContaining("pi-workflow"),
    });
    expect(result).not.toHaveProperty("feedback");
    if (!result.feedbackRef) throw new Error("missing feedbackRef");
    expect(await readFile(result.feedbackRef, "utf8")).toBe(
      "Clarify the verification command.",
    );
    expect(result.feedbackRef).not.toBe(planRef);
  });

  it("accepts a terminal approval event without a status lookup", async () => {
    const planRef = await planFile();
    const events = new FakeEventBus();
    events.status = "completed";
    events.result = { reviewId: "review-recovered", approved: true };

    const result = await runPlanReview(
      { events },
      { missionId: "mission-3", round: 1, planRef },
    );

    expect(result).toEqual({
      approved: true,
      reviewId: "review-recovered",
      planRef,
    });
  });

  it("recovers an existing review without starting another Plannotator review", async () => {
    const planRef = await planFile();
    const events = new FakeEventBus();
    events.status = "completed";
    events.result = { reviewId: "review-existing", approved: true };

    const result = await recoverPlanReview(
      { events },
      { missionId: "mission-recovery", round: 1, planRef },
      "review-existing",
    );

    expect(result).toEqual({
      approved: true,
      reviewId: "review-existing",
      planRef,
    });
    expect(events.requestCount).toBe(1);
    expect(events.startPayload).toBeUndefined();
  });

  it("fails closed when recovery returns the wrong reviewId", async () => {
    const planRef = await planFile();
    const events = new FakeEventBus();
    events.status = "completed";
    events.result = { reviewId: "review-other", approved: true };

    await expect(
      recoverPlanReview(
        { events },
        { missionId: "mission-wrong-id", round: 1, planRef },
        "review-requested",
      ),
    ).rejects.toThrow("wrong reviewId");
    expect(events.requestCount).toBe(1);
  });

  it("fails closed when recovery cannot find the requested review", async () => {
    const planRef = await planFile();
    const events = new FakeEventBus();
    events.status = "missing";

    await expect(
      recoverPlanReview(
        { events },
        { missionId: "mission-missing-review", round: 1, planRef },
        "review-missing",
      ),
    ).rejects.toThrow("is missing");
    expect(events.requestCount).toBe(1);
    expect(events.startPayload).toBeUndefined();
  });

  it("fails before Plannotator when the Plan Artifact cannot be read", async () => {
    const events = new FakeEventBus();

    await expect(
      runPlanReview(
        { events },
        {
          missionId: "mission-4",
          round: 1,
          planRef: join(await tempProject(), "missing.md"),
        },
      ),
    ).rejects.toThrow("Plan Artifact cannot be read");
    expect(events.requestCount).toBe(0);
  });

  it("does not turn a rejection without feedback into a re-plan signal", async () => {
    const planRef = await planFile();
    const events = new FakeEventBus();
    events.result = { reviewId: "review-malformed", approved: false };

    await expect(
      runPlanReview({ events }, { missionId: "mission-5", round: 1, planRef }),
    ).rejects.toThrow("did not include feedback");
  });

  it("fails closed when Plannotator is unavailable", async () => {
    const planRef = await planFile();
    const events: PiEventBus = {
      emit: (_channel, data) => {
        const request = data as { respond: (response: unknown) => void };
        request.respond({ status: "unavailable", error: "not installed" });
      },
      on: () => () => undefined,
    };

    await expect(
      runPlanReview({ events }, { missionId: "mission-6", round: 1, planRef }),
    ).rejects.toThrow("not installed");
  });
});
