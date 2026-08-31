import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
} from "pi-subagents/delegation";
import { describe, expect, it } from "vitest";
import {
  PiSubagentsAdapter,
  STEP_RESULT_SCHEMA,
} from "../../src/adapters/pi/pi-subagents-adapter.js";
import {
  StepResultV1Schema,
  type AgentExecutionRequestV1,
  type StepResultV1,
} from "../../src/contracts/execution/agent-execution.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";

const RUN_ID = "run-001" as RunId;
const STEP_ID = "step-001" as StepId;
const EXECUTION_ID = "exec-001" as ExecutionId;

function request(): AgentExecutionRequestV1 {
  return {
    identity: {
      runId: RUN_ID,
      stepId: STEP_ID,
      executionId: EXECUTION_ID,
      agentId: "worker",
      agentVersion: "1.0.0",
    },
    objective: { objective: "Inspect the requested change", type: "test", completionCriteria: [] },
    retry: { attempt: 1, context: null },
    execution: { mode: "write", timeoutMs: 1_000, cancellationPolicy: {} },
    authority: { maximumDLevel: "D1", escalationRules: [] },
    permissions: { filesystem: [], shell: [], git: [], network: [], repositoryTargets: [] },
    skills: { required: [], optional: [] },
    tools: { resolved: [], policy: {} },
    model: {
      requested: "test-model",
      actual: "test-model",
      thinkingLevel: "low",
      allowedFallback: [],
    },
    context: { pack: { requirement: "current" }, manifest: {}, artifactRefs: [] },
    outputs: { expectedArtifactTypes: [], outputContract: {} },
  };
}

function result(input: AgentExecutionRequestV1): StepResultV1 {
  return {
    identity: {
      runId: input.identity.runId,
      stepId: input.identity.stepId,
      executionId: input.identity.executionId,
    },
    outcome: "completed",
    mode: input.execution.mode,
    summary: "completed",
    artifacts: [],
    uncertainty_candidates: [],
    decision_requests: [],
    requirement_candidates: { acceptance_criteria: [], constraints: [], assumptions: [] },
    finding_candidates: [],
    finding_rechecks: [],
    plan_deviations: [],
    skill_requests: [],
    execution_checks: [],
    observations: [],
    blocked: null,
    failure: null,
    runtime: {},
  };
}

describe("PiSubagentsAdapter integration", () => {
  it("maps one request to one structured leaf execution and returns only StepResultV1", async () => {
    const events = createEventBus();
    const input = request();
    const expected = result(input);
    const requests: SubagentDelegationRequest[] = [];

    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
      const delegation = payload as SubagentDelegationRequest;
      requests.push(delegation);
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        requestId: delegation.requestId,
        ownerRunId: delegation.ownerRunId,
        nodeId: delegation.nodeId,
        status: "completed",
        result: { kind: "structured", value: expected },
      } satisfies SubagentDelegationResponse);
    });

    const adapter = new PiSubagentsAdapter({ events }, { cwd: "/tmp/workflow" });
    const actual = await adapter.run(input);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requestId: EXECUTION_ID,
      ownerRunId: RUN_ID,
      nodeId: STEP_ID,
      agent: "worker",
      context: "fresh",
      cwd: "/tmp/workflow",
      result: { kind: "structured", schema: STEP_RESULT_SCHEMA },
    });
    expect(requests[0]).not.toHaveProperty("workflowScript");
    expect(actual).toEqual(expected);
    expect(StepResultV1Schema.parse(actual)).toEqual(expected);
  });

  it("does not commit Workflow State and rejects failed leaf responses", async () => {
    const events = createEventBus();
    const input = request();
    const adapter = new PiSubagentsAdapter({ events }, { cwd: "/tmp/workflow" });
    const adapterSource = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../src/adapters/pi/pi-subagents-adapter.ts",
      ),
      "utf8",
    );
    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
      const delegation = payload as SubagentDelegationRequest;
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        requestId: delegation.requestId,
        ownerRunId: delegation.ownerRunId,
        nodeId: delegation.nodeId,
        status: "failed",
        error: "child failed",
      } satisfies SubagentDelegationResponse);
    });

    expect(adapterSource).not.toMatch(/StateStore|stateStore|\.commit\s*\(/);
    await expect(adapter.run(input)).rejects.toThrow(
      "PiSubagents Agent Execution failed: child failed",
    );
  });

  it("sends exact cancellation and does not wait for a response", async () => {
    const events = createEventBus();
    const input = request();
    const controller = new AbortController();
    const cancellations: unknown[] = [];
    events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (payload) => cancellations.push(payload));

    const promise = new PiSubagentsAdapter({ events }, { cwd: "/tmp/workflow" }).run(
      input,
      controller.signal,
    );
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(cancellations).toEqual([
      { requestId: EXECUTION_ID, ownerRunId: RUN_ID, nodeId: STEP_ID },
    ]);
  });
});
