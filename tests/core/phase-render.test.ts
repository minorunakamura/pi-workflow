import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { Compile } from "typebox/compile";
import { PlanningDecisionSchema } from "../../src/core/planning/planning-decision-schema";
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

  it("renders arbitrary task text as data, not JavaScript source", () => {
    const task = [
      "backtick: `",
      "Markdown fence:",
      "```bash",
      'printf "%s" "quoted"',
      "```",
      "template marker: ${value}",
      "single quote: '",
      'double quote: "',
      "line one",
      "line two",
      'JSON snippet: {"key":"value"}',
    ].join("\n");
    const outputSchema = {
      type: "object",
      properties: {
        value: {
          type: "string",
          description: 'shell block:\n```sh\nprintf "%s" "value"\n```',
        },
      },
      required: ["value"],
      additionalProperties: false,
    };

    const prepared = renderPhase("discovery", { task, outputSchema });

    expect(
      () => new Script(`(async () => {\n${prepared.workflowScript}\n})()`),
    ).not.toThrow();
    const firstLine = prepared.workflowScript.split("\n", 1)[0];
    const renderedInput = JSON.parse(
      firstLine.slice("const input = ".length, -1),
    ) as { task: string; outputSchema: unknown };
    expect(renderedInput.task).toBe(task);
    expect(renderedInput.outputSchema).toEqual(outputSchema);
  });

  it("transports the package-owned PlanningDecision schema", () => {
    const prepared = renderPhase("planning", {
      task: "Plan the requested change.",
      outputSchema: {
        type: "object",
        properties: { required: ["not-a-schema-key"] },
      },
    });

    const firstLine = prepared.workflowScript.split("\n", 1)[0];
    const renderedInput = JSON.parse(
      firstLine.slice("const input = ".length, -1),
    ) as { outputSchema: Record<string, unknown> };
    const schema = renderedInput.outputSchema;

    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties as object)).toEqual([
      "version",
      "requestSummary",
      "scope",
      "acceptanceCriteria",
      "constraints",
      "risks",
      "verification",
      "implementation",
      "unresolvedDecisions",
    ]);
    expect(schema.required).toEqual([
      "version",
      "requestSummary",
      "scope",
      "acceptanceCriteria",
      "constraints",
      "risks",
      "verification",
      "implementation",
      "unresolvedDecisions",
    ]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).not.toHaveProperty("required");
    expect(schema).toEqual(PlanningDecisionSchema);
    expect(() => Compile(schema)).not.toThrow();
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
