import { describe, expect, it } from "vitest";
import {
  StepResultV1Schema,
  type AgentExecutionRequestV1,
} from "../../src/contracts/execution/agent-execution.js";
import {
  FakeAgentRuntime,
  type FakeAgentRuntimeFixture,
} from "../../src/adapters/fake-agent-runtime.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import type { AgentRuntime } from "../../src/ports/agent-runtime.js";

const RUN_ID = "run-001" as RunId;

function request(stepId: string, agentId: string, executionId: string): AgentExecutionRequestV1 {
  return {
    identity: {
      runId: RUN_ID,
      stepId: stepId as StepId,
      executionId: executionId as ExecutionId,
      agentId,
      agentVersion: "1.0.0",
    },
    objective: { objective: "test", type: "test", completionCriteria: [] },
    retry: { attempt: 1, context: null },
    execution: { mode: "write", timeoutMs: 1_000, cancellationPolicy: {} },
    authority: { maximumDLevel: "D1", escalationRules: [] },
    permissions: { filesystem: [], shell: [], git: [], network: [], repositoryTargets: [] },
    skills: { required: [], optional: [] },
    tools: { resolved: [], policy: {} },
    model: { requested: "test", actual: "test", thinkingLevel: "low", allowedFallback: [] },
    context: { pack: {}, manifest: {}, artifactRefs: [] },
    outputs: { expectedArtifactTypes: [], outputContract: {} },
  };
}

const fixtures = [
  { stepId: "step-001", agentId: "scout", result: "completed" },
  { stepId: "step-001", agentId: "worker", result: "blocked" },
  { stepId: "step-002", agentId: "worker", result: "failed" },
  { stepId: "step-002", agentId: "verifier", result: "invalid", summary: "invalid fixture" },
] as const satisfies readonly FakeAgentRuntimeFixture[];

describe("FakeAgentRuntime integration", () => {
  it("returns deterministic results by Step/Agent and remains reusable", async () => {
    const runtime: AgentRuntime = new FakeAgentRuntime(fixtures);

    for (const [index, fixture] of fixtures.entries()) {
      const input = request(fixture.stepId, fixture.agentId, `exec-00${index + 1}`);
      const first = await runtime.run(input);
      const second = await runtime.run(input);

      expect(second).toEqual(first);
      const parsed = StepResultV1Schema.safeParse(first);
      if (fixture.result === "invalid") {
        expect(parsed.success).toBe(false);
        continue;
      }

      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw parsed.error;
      }
      expect(parsed.data).toMatchObject({
        identity: input.identity,
        outcome: fixture.result,
      });
      expect(parsed.data.blocked !== null).toBe(fixture.result === "blocked");
      expect(parsed.data.failure !== null).toBe(fixture.result === "failed");
    }
  });

  it("fails instead of silently falling back for an unconfigured Step/Agent", async () => {
    const runtime = new FakeAgentRuntime(fixtures);

    await expect(runtime.run(request("step-999", "worker", "exec-999"))).rejects.toThrow(
      "No FakeAgentRuntime fixture for Step step-999 and Agent worker",
    );
  });

  it("rejects duplicate Step/Agent fixtures", () => {
    expect(
      () =>
        new FakeAgentRuntime([
          { stepId: "step-001", agentId: "worker", result: "completed" },
          { stepId: "step-001", agentId: "worker", result: "failed" },
        ]),
    ).toThrow("Duplicate FakeAgentRuntime fixture for Step step-001 and Agent worker");
  });
});
