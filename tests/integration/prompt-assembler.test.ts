import { describe, expect, it } from "vitest";
import { AGENT_DEFINITIONS } from "../../src/agents/definitions.js";
import { buildContext } from "../../src/application/context/context-builder.js";
import { assemblePrompt } from "../../src/application/prompt/prompt-assembler.js";
import {
  AgentExecutionRequestV1Schema,
  type AgentExecutionRequestV1,
} from "../../src/contracts/execution/agent-execution.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";

function executionRequest(): AgentExecutionRequestV1 {
  return AgentExecutionRequestV1Schema.parse({
    identity: {
      runId: "run-001" as RunId,
      stepId: "step-001" as StepId,
      executionId: "exec-001" as ExecutionId,
      agentId: "planner",
      agentVersion: "1.0.0",
    },
    objective: {
      objective: "create a verifiable plan",
      type: "planning",
      completionCriteria: ["the plan has checks"],
    },
    retry: { attempt: 1, context: null },
    execution: { mode: "read-only", timeoutMs: 10_000, cancellationPolicy: {} },
    authority: { maximumDLevel: "D1", escalationRules: [] },
    permissions: {
      filesystem: ["repository"],
      shell: [],
      git: [],
      network: [],
      repositoryTargets: [],
    },
    skills: { required: [{ id: "architect", version: "1.0.0" }], optional: [] },
    tools: { resolved: ["read"], policy: { allow: ["read"] } },
    model: {
      requested: "test-model",
      actual: "test-model",
      thinkingLevel: "low",
      allowedFallback: [],
    },
    context: { pack: {}, manifest: {}, artifactRefs: [] },
    outputs: { expectedArtifactTypes: ["plan"], outputContract: { format: "json" } },
  });
}

describe("Prompt Assembler integration", () => {
  it("composes Context Builder output and a validated Execution Request without discovery", () => {
    const request = executionRequest();
    const contextPack = buildContext({
      budget: 2,
      candidates: [
        {
          ref: "requirement",
          content: { goal: "integration requirement" },
          priority: "authoritative-state",
          estimatedTokens: 1,
        },
        {
          ref: "artifact",
          content: "integration artifact",
          priority: "required-artifact",
          artifactRef: "analysis/exec-001.md",
          estimatedTokens: 1,
        },
      ],
    });
    const planner = AGENT_DEFINITIONS.find(({ id }) => id === "planner");

    if (planner === undefined) {
      throw new Error("planner Agent Definition is required for prompt assembler tests");
    }

    const result = assemblePrompt({
      agentDefinition: planner,
      executionRequest: request,
      contextPack,
      skillContent: [{ id: "architect", version: "1.0.0", content: "architect guidance" }],
    });

    expect(result.content).toContain('"goal":"integration requirement"');
    expect(result.content).toContain("integration artifact");
    expect(result.content).toContain("architect guidance");
    expect(result.telemetry).toEqual({ fingerprint: result.fingerprint, size: result.size });
  });
});
