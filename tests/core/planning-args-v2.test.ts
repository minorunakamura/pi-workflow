import { describe, expect, it } from "vitest";
import {
  MAX_RESOURCE_ARGS_BYTES,
  validateResourceArgs,
} from "../../src/core/phases/args";
import { MAX_REFERENCE_BYTES } from "../../src/core/state/references";

describe("PlanningArgsV2", () => {
  it("keeps omitted operation equivalent to plan", () => {
    expect(validateResourceArgs("planning", { round: 1 })).toMatchObject({
      ok: true,
    });
    expect(
      validateResourceArgs("planning", { operation: "plan", round: 1 }),
    ).toMatchObject({ ok: true });
  });

  it.each([
    {
      operation: "prepare-review",
      round: 1,
      planRef: "plan-1",
    },
    {
      operation: "record-review",
      round: 1,
      planRef: "plan-1",
      reviewId: "review-1",
      status: "pending",
    },
    {
      operation: "review-status",
      round: 1,
      planRef: "plan-1",
    },
  ])("accepts control operation %j", (args) => {
    expect(validateResourceArgs("planning", args)).toMatchObject({
      ok: true,
    });
  });

  it.each([
    { operation: "unknown", round: 1 },
    { operation: "prepare-review", round: 1 },
    { operation: "record-review", round: 1, planRef: "plan", reviewId: "id" },
    { operation: "review-status", round: 1, planRef: "plan", extra: true },
    { round: 1, planningDecision: {} },
  ])("rejects invalid operation shapes %j", (args) => {
    expect(validateResourceArgs("planning", args).ok).toBe(false);
  });

  it("rejects oversized references and resource args", () => {
    expect(
      validateResourceArgs("planning", {
        operation: "prepare-review",
        round: 1,
        planRef: "あ".repeat(683),
      }).ok,
    ).toBe(false);
    expect(
      validateResourceArgs("planning", {
        round: 1,
        humanInputs: [
          { id: "answer", value: "x".repeat(MAX_RESOURCE_ARGS_BYTES) },
        ],
      }).ok,
    ).toBe(false);
    expect(MAX_REFERENCE_BYTES).toBe(2_048);
  });
});
