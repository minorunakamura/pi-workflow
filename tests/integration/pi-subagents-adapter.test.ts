import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventBus, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
} from "pi-subagents/delegation";
import { describe, expect, it } from "vitest";
import {
  PiSubagentsAdapter,
  PiSubagentsContextUnavailableError,
  STEP_RESULT_SCHEMA,
} from "../../src/adapters/pi/pi-subagents-adapter.js";
import {
  STEP_RESULT_AGENT_OUTPUT_CONTRACT,
  StepResultV1Schema,
  type AgentExecutionRequestV1,
  type StepResultV1,
} from "../../src/contracts/execution/agent-execution.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import {
  persistedRuntimeTelemetry,
  TelemetryAgentRuntime,
} from "../../src/telemetry/runtime-metrics.js";

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
  it("passes the shared LLM contract unchanged to structured delegation", () => {
    expect(STEP_RESULT_SCHEMA).toBe(STEP_RESULT_AGENT_OUTPUT_CONTRACT);
  });

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
    expect(requests[0]?.task).toContain("Agent candidate identity boundary:");
    expect(requests[0]?.task).toContain("Do not include `id`, `authoritative_id`, or `state_id`");
    expect(actual).toMatchObject(expected);
    expect(actual.runtime).toMatchObject({
      telemetry: {
        telemetry_level: "standard",
        model_requested: "test-model",
        model_actual: "test-model",
        tools_selected: [],
        skills_selected: [],
      },
    });
    expect(StepResultV1Schema.parse(actual)).toEqual(actual);
  });

  it("does not resolve when the child is spawned until its completion response arrives", async () => {
    const events = createEventBus();
    const input = request();
    const expected = result(input);
    let childSpawnedResolve!: () => void;
    const childSpawned = new Promise<void>((resolve) => {
      childSpawnedResolve = resolve;
    });
    let releaseChild!: () => void;
    const childCompletion = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let responseSent = false;

    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
      const delegation = payload as SubagentDelegationRequest;
      childSpawnedResolve();
      void childCompletion.then(() => {
        responseSent = true;
        events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          requestId: delegation.requestId,
          ownerRunId: delegation.ownerRunId,
          nodeId: delegation.nodeId,
          status: "completed",
          result: { kind: "structured", value: expected },
        } satisfies SubagentDelegationResponse);
      });
    });

    const execution = new PiSubagentsAdapter({ events }, { cwd: "/tmp/workflow" }).run(input);
    await childSpawned;
    expect(responseSent).toBe(false);
    let resolved = false;
    void execution.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    releaseChild();
    await expect(execution).resolves.toMatchObject(expected);
    expect(responseSent).toBe(true);
  });

  it("uses the shared explicit candidate shapes and finite fields", () => {
    const candidateSchemas = [
      STEP_RESULT_SCHEMA.properties.uncertainty_candidates,
      STEP_RESULT_SCHEMA.properties.decision_requests,
      STEP_RESULT_SCHEMA.properties.requirement_candidates.properties.acceptance_criteria,
      STEP_RESULT_SCHEMA.properties.requirement_candidates.properties.constraints,
      STEP_RESULT_SCHEMA.properties.requirement_candidates.properties.assumptions,
      STEP_RESULT_SCHEMA.properties.finding_candidates,
      STEP_RESULT_SCHEMA.properties.finding_rechecks,
      STEP_RESULT_SCHEMA.properties.plan_deviations,
      STEP_RESULT_SCHEMA.properties.skill_requests,
      STEP_RESULT_SCHEMA.properties.execution_checks,
      STEP_RESULT_SCHEMA.properties.observations,
    ];

    for (const schema of candidateSchemas) {
      const item = schema.items as Record<string, unknown>;
      const variants = Array.isArray(item.oneOf) ? item.oneOf : [item];
      for (const variant of variants) {
        const candidate = variant as Record<string, unknown>;
        expect(candidate.additionalProperties).toBe(false);
        const properties = candidate.properties;
        if (properties !== undefined) {
          expect(properties).not.toHaveProperty("id");
          expect(properties).not.toHaveProperty("authoritative_id");
          expect(properties).not.toHaveProperty("state_id");
        }
      }
    }

    const requirementItem = STEP_RESULT_SCHEMA.properties.requirement_candidates.properties
      .acceptance_criteria.items as Record<string, unknown>;
    const requirementVariants = requirementItem.oneOf as readonly Record<string, unknown>[];
    expect(requirementVariants[0]?.required).toEqual(["operation", "effect"]);
    expect(requirementVariants[1]?.required).toEqual(["operation", "effect", "targetId"]);
    expect(requirementVariants[0]?.properties).toHaveProperty("operation");
    expect(requirementVariants[1]?.properties).toHaveProperty("targetId");
    expect(
      (
        (STEP_RESULT_SCHEMA.properties.execution_checks.items as Record<string, unknown>)
          .properties as Record<string, unknown>
      ).status,
    ).toMatchObject({ enum: ["passed", "failed", "skipped", "unavailable"] });
  });

  it("fails closed when the invocation context is unavailable or stale", async () => {
    const events = createEventBus();
    let context: ExtensionContext | undefined;
    const adapter = new PiSubagentsAdapter(
      { events },
      { cwd: "/tmp/workflow", getContext: () => context },
    );

    await expect(adapter.run(request())).rejects.toMatchObject({
      name: "PiSubagentsContextUnavailableError",
      code: "PI_EXTENSION_CONTEXT_UNAVAILABLE",
    } satisfies Partial<PiSubagentsContextUnavailableError>);

    context = new Proxy({} as ExtensionContext, {
      get() {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
    });
    await expect(adapter.run(request())).rejects.toMatchObject({
      code: "PI_EXTENSION_CONTEXT_UNAVAILABLE",
    });
  });

  it("normalizes an unavailable structured bridge response", async () => {
    const events = createEventBus();
    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
      const delegation = payload as SubagentDelegationRequest;
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        requestId: delegation.requestId,
        ownerRunId: delegation.ownerRunId,
        nodeId: delegation.nodeId,
        status: "unavailable_context",
        error: "No active extension context for delegated subagent execution.",
      } satisfies SubagentDelegationResponse);
    });

    await expect(
      new PiSubagentsAdapter({ events }, { cwd: "/tmp/workflow" }).run(request()),
    ).rejects.toMatchObject({
      name: "PiSubagentsContextUnavailableError",
      code: "PI_EXTENSION_CONTEXT_UNAVAILABLE",
    });
  });

  it("passes the assembled selected Skill prompt into the delegated Agent Execution", async () => {
    const events = createEventBus();
    const input = {
      ...request(),
      skills: { required: [{ id: "tdd", version: "1.0.0" }], optional: [] },
    } satisfies AgentExecutionRequestV1;
    const assembled = "selected Skill procedure marker";
    const requests: SubagentDelegationRequest[] = [];

    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
      const delegation = payload as SubagentDelegationRequest;
      requests.push(delegation);
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        requestId: delegation.requestId,
        ownerRunId: delegation.ownerRunId,
        nodeId: delegation.nodeId,
        status: "completed",
        result: { kind: "structured", value: result(input) },
      } satisfies SubagentDelegationResponse);
    });

    await new PiSubagentsAdapter(
      { events },
      { cwd: "/tmp/workflow", buildPrompt: () => assembled },
    ).run(input);

    expect(requests[0]?.task).toContain(assembled);
    expect(requests[0]?.task).toContain("Execution request (JSON):");
    expect(requests[0]?.skill).toEqual(["tdd"]);
  });

  it("rejects an authoritative candidate ID at the adapter result boundary", async () => {
    const events = createEventBus();
    const input = request();
    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
      const delegation = payload as SubagentDelegationRequest;
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        requestId: delegation.requestId,
        ownerRunId: delegation.ownerRunId,
        nodeId: delegation.nodeId,
        status: "completed",
        result: {
          kind: "structured",
          value: {
            ...result(input),
            uncertainty_candidates: [{ id: "U-001", category: "behavior" }],
          },
        },
      } satisfies SubagentDelegationResponse);
    });

    await expect(
      new PiSubagentsAdapter({ events }, { cwd: "/tmp/workflow" }).run(input),
    ).rejects.toThrow(/uncertainty_candidates\[0\]\.id.*authoritative State ID/);
  });

  it("rejects a write-capable read-only request before delegation", async () => {
    const events = createEventBus();
    const input = {
      ...request(),
      identity: { ...request().identity, agentId: "scout" },
      execution: { ...request().execution, mode: "read-only" as const },
      authority: { ...request().authority, maximumDLevel: "D0" },
      permissions: {
        ...request().permissions,
        filesystem: ["repository-write"],
      },
    } satisfies AgentExecutionRequestV1;
    let delegated = false;
    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
      delegated = true;
    });

    await expect(
      new PiSubagentsAdapter({ events }, { cwd: "/tmp/workflow" }).run(input),
    ).rejects.toMatchObject({
      code: "WRITE_DENIED",
    });
    expect(delegated).toBe(false);
  });

  it("enforces the resolved Tool allowlist at the Pi adapter boundary", async () => {
    const events = createEventBus();
    const input = {
      ...request(),
      tools: { resolved: ["read", "edit"], policy: { allow: ["read"] } },
    } satisfies AgentExecutionRequestV1;
    let delegated = false;
    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
      delegated = true;
    });

    await expect(
      new PiSubagentsAdapter({ events }, { cwd: "/tmp/workflow" }).run(input),
    ).rejects.toMatchObject({
      code: "TOOL_CAPABILITY_DENIED",
      tool: "edit",
    });
    expect(delegated).toBe(false);
  });

  it("rejects a resolved Tool denied by the request policy before delegation", async () => {
    const events = createEventBus();
    const input = {
      ...request(),
      tools: { resolved: ["read"], policy: { deny: ["read"] } },
    } satisfies AgentExecutionRequestV1;
    let delegated = false;
    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
      delegated = true;
    });

    await expect(
      new PiSubagentsAdapter({ events }, { cwd: "/tmp/workflow" }).run(input),
    ).rejects.toMatchObject({
      code: "TOOL_CAPABILITY_DENIED",
      tool: "read",
    });
    expect(delegated).toBe(false);
  });

  it("captures provider usage and actual Tool observations without payloads", async () => {
    const events = createEventBus();
    const input = {
      ...request(),
      skills: { required: [{ id: "tdd", version: "1" }], optional: [] },
      tools: { resolved: ["read"], policy: {} },
      context: {
        pack: { requirement: "selected context" },
        manifest: { estimatedTokenSize: 17, trim_count: 2 },
        artifactRefs: [],
      },
    } satisfies AgentExecutionRequestV1;

    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
      const delegation = payload as SubagentDelegationRequest;
      events.emit(SUBAGENT_DELEGATION_UPDATE_EVENT, {
        requestId: delegation.requestId,
        ownerRunId: delegation.ownerRunId,
        nodeId: delegation.nodeId,
        currentTool: "read",
        currentToolArgs: "password=do-not-persist",
        recentOutput: "full tool result must not be persisted",
        recentTools: [{ tool: "read", args: "token=do-not-persist" }],
        toolCount: 1,
        durationMs: 42,
        tokens: 15,
      });
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        requestId: delegation.requestId,
        ownerRunId: delegation.ownerRunId,
        nodeId: delegation.nodeId,
        status: "completed",
        model: "provider/api_key=very-secret",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 2,
          cacheWrite: 0,
          cost: 0.12,
          turns: 1,
          toolCalls: 1,
          durationMs: 42,
        },
        result: { kind: "structured", value: result(input) },
      } satisfies SubagentDelegationResponse);
    });

    const actual = await new PiSubagentsAdapter({ events }, { cwd: "/tmp/workflow" }).run(input);
    const telemetry = actual.runtime.telemetry;

    expect(telemetry).toMatchObject({
      telemetry_level: "standard",
      wall_clock_ms: expect.any(Number),
      active_wall_ms: expect.any(Number),
      input_tokens: 10,
      output_tokens: 5,
      tokens: 15,
      cached_input_tokens: 2,
      cost: 0.12,
      execution_sum_ms: 42,
      tool_calls: 1,
      pack_tokens_estimated_total: 17,
      pack_tokens_estimated_peak: 17,
      trim_count: 2,
      model_requested: "test-model",
      model_actual: "provider/api_key=[REDACTED_SECRET]",
      tools_selected: ["read"],
      tools_used: ["read"],
      skills_selected: [{ id: "tdd", version: "1" }],
    });
    expect(telemetry).not.toHaveProperty("prompt");
    expect(telemetry).not.toHaveProperty("tool_result");
    expect(JSON.stringify(telemetry)).not.toContain("do-not-persist");
    expect(JSON.stringify(telemetry)).not.toContain("very-secret");
    expect(JSON.stringify(telemetry)).not.toContain("full tool result");
  });

  it("keeps minimal telemetry aggregate-only", async () => {
    const input = {
      ...request(),
      skills: { required: [{ id: "tdd", version: "1" }], optional: [] },
      tools: { resolved: ["read"], policy: {} },
      context: {
        pack: { prompt: "must not be copied" },
        manifest: { estimatedTokenSize: 99 },
        artifactRefs: [],
      },
    } satisfies AgentExecutionRequestV1;
    const ticks = [100, 140];
    const runtime = new TelemetryAgentRuntime(
      { run: async () => result(input) },
      { level: "minimal", now: () => ticks.shift() ?? 140 },
    );

    const actual = (await runtime.run(input)) as StepResultV1;
    expect(actual.runtime.telemetry).toEqual({
      telemetry_level: "minimal",
      wall_clock_ms: 40,
      active_wall_ms: 40,
      execution_sum_ms: 40,
    });
  });

  it("stores additional diagnostics only for debug telemetry", async () => {
    const events = createEventBus();
    const input = request();
    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
      const delegation = payload as SubagentDelegationRequest;
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        requestId: delegation.requestId,
        ownerRunId: delegation.ownerRunId,
        nodeId: delegation.nodeId,
        status: "completed",
        model: "provider/api_key=very-secret",
        thinking: "high",
        exitCode: 0,
        launchContractDigest: "digest-001",
        result: { kind: "structured", value: result(input) },
      } satisfies SubagentDelegationResponse);
    });

    const actual = await new PiSubagentsAdapter(
      { events },
      { cwd: "/tmp/workflow", telemetryLevel: "debug" },
    ).run(input);

    expect(actual.runtime).toMatchObject({
      telemetry: { telemetry_level: "debug" },
      debug: {
        status: "completed",
        model: "provider/api_key=[REDACTED_SECRET]",
        thinking: "high",
        exit_code: 0,
        launch_contract_digest: "digest-001",
      },
    });
    expect(actual.runtime.debug).toHaveProperty("observation.tools_used", []);
    expect(persistedRuntimeTelemetry(actual.runtime)).not.toHaveProperty("debug");
    expect(JSON.stringify(actual.runtime.debug)).not.toContain("very-secret");
  });

  it("normalizes structured model references and rejects unconfigured actual models", async () => {
    const events = createEventBus();
    const input = {
      ...request(),
      model: {
        requested: { provider: "test-provider", model: "test-model" },
        actual: { provider: "test-provider", model: "fallback-model" },
        thinkingLevel: "low",
        allowedFallback: [{ provider: "test-provider", model: "fallback-model" }],
      },
    } satisfies AgentExecutionRequestV1;
    const requests: SubagentDelegationRequest[] = [];

    events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
      const delegation = payload as SubagentDelegationRequest;
      requests.push(delegation);
      events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        requestId: delegation.requestId,
        ownerRunId: delegation.ownerRunId,
        nodeId: delegation.nodeId,
        status: "completed",
        result: { kind: "structured", value: result(input) },
      } satisfies SubagentDelegationResponse);
    });

    await new PiSubagentsAdapter({ events }, { cwd: "/tmp/workflow" }).run(input);
    expect(requests[0]?.model).toBe("test-provider/fallback-model");

    await expect(
      new PiSubagentsAdapter({ events }, { cwd: "/tmp/workflow" }).run({
        ...input,
        model: { ...input.model, actual: "unconfigured/model" },
      }),
    ).rejects.toThrow("requested model or a configured fallback");
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
