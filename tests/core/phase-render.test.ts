import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_PHASE_PAYLOAD_BYTES,
  renderPhase,
  validatePhaseInput,
} from "../../src/core/phases/render-phase";

describe("phase rendering", () => {
  it("renders an allowlisted template with a JSON literal", () => {
    const prepared = renderPhase("discovery", {
      task: "Inspect the repository.",
      outputSchema: { type: "object", additionalProperties: false },
    });

    expect(prepared.phase).toBe("discovery");
    expect(prepared.workflowScript).not.toContain("__PI_WORKFLOW_INPUT__");
    expect(prepared.workflowScript).toContain('"Inspect the repository."');
    expect(prepared.sha256).toBe(
      createHash("sha256").update(prepared.workflowScript).digest("hex"),
    );
  });

  it("returns the same script and hash for the same input", () => {
    const first = renderPhase("research", {
      task: "Check the primary source.",
    });
    const second = renderPhase("research", {
      task: "Check the primary source.",
    });

    expect(second).toEqual(first);
  });

  it("rejects arbitrary JavaScript in a payload", () => {
    expect(() =>
      renderPhase("discovery", {
        task: "Inspect the repository.",
        outputSchema: { transform: () => "not JSON" },
      }),
    ).toThrow("payload must contain JSON values only");
  });

  it("rejects an unknown phase", () => {
    expect(() => renderPhase("not-a-phase", {})).toThrow("unknown phase");
  });

  it("rejects payloads over the size limit", () => {
    const result = validatePhaseInput("research", {
      task: "x".repeat(MAX_PHASE_PAYLOAD_BYTES),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        path: "/",
        message: `payload exceeds ${MAX_PHASE_PAYLOAD_BYTES} bytes`,
      });
    }
  });
});
