import type {
  AgentExecutionRequestV1,
  JsonObject,
  StepResultV1,
} from "../contracts/execution/agent-execution.js";
import type { AgentRuntime } from "../ports/agent-runtime.js";

export const FAKE_AGENT_RESULT_KINDS = ["completed", "blocked", "failed", "invalid"] as const;
export type FakeAgentResultKind = (typeof FAKE_AGENT_RESULT_KINDS)[number];

export type FakeAgentRuntimeFixture = Readonly<{
  stepId: string;
  agentId: string;
  result: FakeAgentResultKind;
  summary?: string;
}>;

function fixtureKey(stepId: string, agentId: string): string {
  return JSON.stringify([stepId, agentId]);
}

function resultFor(
  request: AgentExecutionRequestV1,
  outcome: Exclude<FakeAgentResultKind, "invalid">,
  summary: string,
): StepResultV1 {
  const blocked: JsonObject | null =
    outcome === "blocked" ? { reason: "Fake Agent Runtime fixture requested blocked" } : null;
  const failure: JsonObject | null =
    outcome === "failed" ? { reason: "Fake Agent Runtime fixture requested failed" } : null;

  return {
    identity: { ...request.identity },
    outcome,
    mode: request.execution.mode,
    summary,
    artifacts: [],
    uncertainty_candidates: [],
    decision_requests: [],
    requirement_candidates: {
      acceptance_criteria: [],
      constraints: [],
      assumptions: [],
    },
    finding_candidates: [],
    finding_rechecks: [],
    plan_deviations: [],
    skill_requests: [],
    execution_checks: [],
    observations: [],
    blocked,
    failure,
    runtime: {},
  };
}

export class FakeAgentRuntime implements AgentRuntime {
  private readonly fixtures: ReadonlyMap<string, FakeAgentRuntimeFixture>;

  constructor(fixtures: readonly FakeAgentRuntimeFixture[]) {
    const indexed = new Map<string, FakeAgentRuntimeFixture>();
    for (const fixture of fixtures) {
      const key = fixtureKey(fixture.stepId, fixture.agentId);
      if (indexed.has(key)) {
        throw new Error(
          `Duplicate FakeAgentRuntime fixture for Step ${fixture.stepId} and Agent ${fixture.agentId}`,
        );
      }
      indexed.set(key, fixture);
    }
    this.fixtures = indexed;
  }

  async run(request: AgentExecutionRequestV1): Promise<unknown> {
    const { stepId, agentId } = request.identity;
    const fixture = this.fixtures.get(fixtureKey(stepId, agentId));
    if (fixture === undefined) {
      throw new Error(`No FakeAgentRuntime fixture for Step ${stepId} and Agent ${agentId}`);
    }

    const summary =
      fixture.summary ?? `Fake Agent Runtime ${fixture.result} result for ${stepId}/${agentId}`;
    if (fixture.result === "invalid") {
      return { ...resultFor(request, "completed", summary), outcome: "invalid" };
    }

    return resultFor(request, fixture.result, summary);
  }
}
