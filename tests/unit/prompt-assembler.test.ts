import { describe, expect, it } from "vitest";
import { AGENT_DEFINITIONS } from "../../src/agents/definitions.js";
import {
  buildContext,
  type ContextBuildResult,
} from "../../src/application/context/context-builder.js";
import {
  assemblePrompt,
  PROMPT_SECTION_ORDER,
  type PromptAssemblerInput,
} from "../../src/application/prompt/prompt-assembler.js";
import type { AgentExecutionRequestV1 } from "../../src/contracts/execution/agent-execution.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";

const worker = AGENT_DEFINITIONS.find(({ id }) => id === "worker");
if (worker === undefined) {
  throw new Error("worker Agent Definition is required for prompt assembler tests");
}
const workerDefinition = worker;

function request(
  skills: AgentExecutionRequestV1["skills"] = { required: [], optional: [] },
): AgentExecutionRequestV1 {
  return {
    identity: {
      runId: "run-001" as RunId,
      stepId: "step-001" as StepId,
      executionId: "exec-001" as ExecutionId,
      agentId: "worker",
      agentVersion: "1.0.0",
    },
    objective: {
      objective: "objective-marker",
      type: "implementation",
      completionCriteria: ["completion-marker"],
    },
    retry: { attempt: 1, context: null },
    execution: {
      mode: "write",
      timeoutMs: 1_000,
      cancellationPolicy: { onCancel: "stop" },
    },
    authority: { maximumDLevel: "D1", escalationRules: [] },
    permissions: {
      filesystem: ["repository"],
      shell: [],
      git: [],
      network: [],
      repositoryTargets: ["src/application/prompt"],
    },
    skills,
    tools: { resolved: ["read"], policy: { allow: ["read"] } },
    model: {
      requested: "test-model",
      actual: "test-model",
      thinkingLevel: "low",
      allowedFallback: [],
    },
    context: { pack: {}, manifest: {}, artifactRefs: [] },
    outputs: {
      expectedArtifactTypes: ["source"],
      outputContract: { marker: "output-marker" },
    },
  };
}

function contextPack(): ContextBuildResult {
  return buildContext({
    budget: 4,
    candidates: [
      {
        ref: "artifact",
        content: "artifact-marker",
        priority: "required-artifact",
        artifactRef: "analysis/exec-001.md",
        estimatedTokens: 1,
      },
      {
        ref: "plan",
        content: "plan-marker",
        priority: "current-plan",
        estimatedTokens: 1,
      },
      {
        ref: "decision",
        content: "decision-marker",
        priority: "resolved-decisions",
        estimatedTokens: 1,
      },
      {
        ref: "requirement",
        content: "requirement-marker",
        priority: "authoritative-state",
        estimatedTokens: 1,
      },
      {
        ref: "excluded",
        content: "excluded-marker",
        priority: "optional",
        estimatedTokens: 1,
      },
    ],
  });
}

function input(overrides: Partial<PromptAssemblerInput> = {}): PromptAssemblerInput {
  return {
    agentDefinition: workerDefinition,
    executionRequest: request({
      required: [{ id: "tdd", version: "1.0.0" }],
      optional: [],
    }),
    contextPack: contextPack(),
    skillContent: [
      { id: "reflect", version: "1.0.0", content: "unselected-skill-marker" },
      { id: "tdd", version: "1.0.0", content: "selected-skill-marker" },
    ],
    ...overrides,
  };
}

describe("assemblePrompt", () => {
  it("keeps the seven specification sections in stable precedence order", () => {
    const content = assemblePrompt(input()).content;
    const positions = PROMPT_SECTION_ORDER.map((title) => content.indexOf(`## ${title}`));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(content.indexOf("requirement-marker")).toBeLessThan(content.indexOf("plan-marker"));
    expect(content.indexOf("selected-skill-marker")).toBeLessThan(
      content.indexOf("completion-marker"),
    );
  });

  it("includes only selected context and resolved selected Skill content", () => {
    const result = assemblePrompt(input());

    expect(result.content).toContain("requirement-marker");
    expect(result.content).toContain("decision-marker");
    expect(result.content).toContain("plan-marker");
    expect(result.content).toContain("artifact-marker");
    expect(result.content).toContain("selected-skill-marker");
    expect(result.content).not.toContain("excluded-marker");
    expect(result.content).not.toContain("unselected-skill-marker");
  });

  it("returns deterministic fingerprint/size telemetry without prompt content", () => {
    const first = assemblePrompt(input());
    const second = assemblePrompt(input());

    expect(second).toEqual(first);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.size).toBe(Buffer.byteLength(first.content, "utf8"));
    expect(first.telemetry).toEqual({ fingerprint: first.fingerprint, size: first.size });
    expect(first.telemetry).not.toHaveProperty("content");
  });

  it("states that every Agent candidate group is semantic-only", () => {
    const content = assemblePrompt(input()).content;

    expect(content).toContain("Agent candidate identity boundary:");
    expect(content).toContain("Do not include `id`, `authoritative_id`, or `state_id` fields.");
    for (const group of [
      "uncertainty_candidates",
      "decision_requests",
      "requirement_candidates.acceptance_criteria",
      "requirement_candidates.constraints",
      "requirement_candidates.assumptions",
      "finding_candidates",
      "finding_rechecks",
      "plan_deviations",
      "skill_requests",
      "execution_checks",
      "observations",
    ]) {
      expect(content).toContain(group);
    }
    expect(content).toContain("Orchestrator normalization allocates authoritative identity");
    expect(content).toContain("Domain-model IDs shown in context are references/evidence");
    expect(content).toContain(
      "Requirement Candidate operation must be exactly one of: add, clarify.",
    );
    expect(content).toContain(
      "Requirement Candidate effect must be exactly one of: preserving, narrowing, broadening, changing.",
    );
    expect(content).toContain(
      "Uncertainty candidate category must be one of: requirement, behavior, design, external, impact, verification.",
    );
    expect(content).toContain(
      "Artifacts supplied by an Agent are analysis/research drafts with type, purpose, and content",
    );
  });

  it("does not silently omit a selected Skill without resolved content", () => {
    expect(() =>
      assemblePrompt(
        input({
          skillContent: [],
        }),
      ),
    ).toThrow("missing resolved Skill content: tdd@1.0.0");
  });
});
