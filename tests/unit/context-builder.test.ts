import { describe, expect, it } from "vitest";
import {
  buildContext,
  ContextBuilderError,
  type ContextBuilderInput,
} from "../../src/application/context/context-builder.js";

function input(overrides: Partial<ContextBuilderInput> = {}): ContextBuilderInput {
  return {
    budget: 100,
    candidates: [],
    ...overrides,
  };
}

describe("buildContext", () => {
  it("selects current authoritative context before lower-priority context", () => {
    const result = buildContext(
      input({
        budget: 5,
        requirementRevision: 3,
        decisionRefs: ["D-001"],
        uncertaintyRefs: ["U-001"],
        candidates: [
          { ref: "optional", content: "optional", priority: "optional", estimatedTokens: 1 },
          { ref: "plan", content: "plan", priority: "current-plan", estimatedTokens: 1 },
          {
            ref: "decision",
            content: { status: "resolved" },
            priority: "resolved-decisions",
            estimatedTokens: 1,
          },
          {
            ref: "requirement",
            content: { goal: "goal" },
            priority: "authoritative-state",
            estimatedTokens: 1,
          },
          {
            ref: "supporting",
            content: "supporting",
            priority: "supporting-evidence",
            estimatedTokens: 10,
          },
        ],
      }),
    );

    expect(Object.keys(result.pack)).toEqual(["requirement", "decision", "plan", "optional"]);
    expect(result.manifest).toMatchObject({
      requirementRevision: 3,
      artifactRefs: [],
      decisionRefs: ["D-001"],
      uncertaintyRefs: ["U-001"],
      trim_count: 1,
      estimatedTokenSize: 4,
    });
    expect(result.manifest.inclusionMode).toEqual({
      requirement: "authoritative-state",
      decision: "resolved-decisions",
      plan: "current-plan",
      optional: "optional",
    });
  });

  it("does not add conversation to the default context", () => {
    const result = buildContext(input());

    expect(result.pack).toEqual({});
    expect(result.artifactRefs).toEqual([]);
    expect(result.manifest).toMatchObject({
      requirementRevision: null,
      artifactRefs: [],
      decisionRefs: [],
      uncertaintyRefs: [],
      trim_count: 0,
      estimatedTokenSize: 0,
    });
    expect(JSON.stringify(result)).not.toContain("conversation");
  });

  it("excludes stale and superseded context", () => {
    const result = buildContext(
      input({
        candidates: [
          {
            ref: "requirement",
            content: { goal: "current" },
            priority: "authoritative-state",
            freshness: "fresh",
            estimatedTokens: 1,
          },
          {
            ref: "stale-evidence",
            content: "stale",
            priority: "supporting-evidence",
            freshness: "stale",
            estimatedTokens: 1,
          },
          {
            ref: "superseded-plan",
            content: "old plan",
            priority: "current-plan",
            superseded: true,
            estimatedTokens: 1,
          },
          {
            ref: "artifact",
            content: "finalized artifact",
            priority: "required-artifact",
            artifactRef: "analysis/exec-001.md",
            estimatedTokens: 1,
          },
        ],
      }),
    );

    expect(result.pack).toEqual({
      requirement: { goal: "current" },
      artifact: "finalized artifact",
    });
    expect(result.artifactRefs).toEqual(["analysis/exec-001.md"]);
  });

  it("fails structurally instead of dropping required Requirement or Decision content", () => {
    try {
      buildContext(
        input({
          budget: 3,
          candidates: [
            {
              ref: "requirement",
              content: { goal: "required" },
              priority: "authoritative-state",
              estimatedTokens: 2,
            },
            {
              ref: "decision",
              content: { status: "resolved" },
              priority: "resolved-decisions",
              estimatedTokens: 2,
            },
            {
              ref: "optional",
              content: "optional",
              priority: "optional",
              estimatedTokens: 1,
            },
          ],
        }),
      );
      expect.fail("buildContext should reject an over-budget required context");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextBuilderError);
      expect(error).toMatchObject({
        code: "CONTEXT_BUDGET_EXCEEDED",
        details: {
          budget: 3,
          requiredRefs: ["requirement", "decision"],
          requiredTokenSize: 4,
          excludedRefs: [],
        },
      });
    }
  });

  it("fails when required context is stale or superseded", () => {
    try {
      buildContext(
        input({
          candidates: [
            {
              ref: "requirement",
              content: { goal: "old" },
              priority: "authoritative-state",
              freshness: "stale",
              estimatedTokens: 1,
            },
          ],
        }),
      );
      expect.fail("buildContext should reject stale required context");
    } catch (error) {
      expect(error).toMatchObject({
        code: "REQUIRED_CONTEXT_MISSING",
        details: {
          requiredRefs: ["requirement"],
          excludedRefs: ["requirement"],
        },
      });
    }
  });
});
