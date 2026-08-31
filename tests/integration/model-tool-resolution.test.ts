import { describe, expect, it } from "vitest";
import {
  ExecutionResolver,
  ModelResolver,
  ToolResolver,
} from "../../src/application/execution/model-tool-resolution.js";
import type { AgentExecutionRequestV1 } from "../../src/contracts/execution/agent-execution.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import type { ModelCatalog, ModelReference } from "../../src/ports/model-catalog.js";
import type { ToolCatalog } from "../../src/ports/tool-catalog.js";

function request(overrides: Partial<AgentExecutionRequestV1> = {}): AgentExecutionRequestV1 {
  return {
    identity: {
      runId: "run-001" as RunId,
      stepId: "step-001" as StepId,
      executionId: "exec-001" as ExecutionId,
      agentId: "worker",
      agentVersion: "1.0.0",
    },
    objective: { objective: "Resolve an execution", type: "test", completionCriteria: [] },
    retry: { attempt: 1, context: null },
    execution: { mode: "write", timeoutMs: 1_000, cancellationPolicy: {} },
    authority: { maximumDLevel: "D0", escalationRules: [] },
    permissions: {
      filesystem: ["repository"],
      shell: [],
      git: [],
      network: [],
      repositoryTargets: ["src"],
    },
    skills: { required: [], optional: [] },
    tools: { resolved: ["untrusted-tool"], policy: {} },
    model: {
      requested: "unavailable/model",
      actual: null,
      thinkingLevel: "medium",
      allowedFallback: ["configured/model"],
    },
    context: { pack: {}, manifest: {}, artifactRefs: [] },
    outputs: { expectedArtifactTypes: [], outputContract: {} },
    ...overrides,
  };
}

function modelCatalog(available: readonly string[]): ModelCatalog {
  const availableModels = new Set(available);
  return {
    isAvailable(model: ModelReference): boolean {
      const name = typeof model === "string" ? model : `${model.provider}/${model.model}`;
      return availableModels.has(name);
    },
  };
}

const toolCatalog: ToolCatalog = {
  resolve(capability) {
    if (capability === "repository-read") {
      return {
        name: "read",
        capabilities: ["repository-read"],
        requiredPermissions: [{ scope: "filesystem", value: "repository" }],
        minimumAuthority: "D0",
      };
    }
    if (capability === "repository-write") {
      return {
        name: "edit",
        capabilities: ["repository-write"],
        requiredPermissions: [{ scope: "filesystem", value: "repository" }],
        allowedModes: ["write"],
        minimumAuthority: "D1",
      };
    }
    return undefined;
  },
};

describe("model and tool resolution integration", () => {
  it("selects only configured fallback models and records requested/actual values", () => {
    const resolver = new ModelResolver(modelCatalog(["configured/model"]));

    expect(resolver.resolve(request().model)).toEqual({
      requested: "unavailable/model",
      actual: "configured/model",
      allowedFallback: ["configured/model"],
      fallbackUsed: true,
    });
  });

  it("rejects an available model that is not requested or configured as fallback", () => {
    const resolver = new ModelResolver(modelCatalog(["unconfigured/model"]));

    expect(() => resolver.resolve(request().model)).toThrow(
      "No requested or configured fallback model is available",
    );
    expect(() =>
      resolver.resolve({
        ...request().model,
        actual: "unconfigured/model",
      }),
    ).toThrow("requested model or a configured fallback");
  });

  it("maps capabilities to least-privilege concrete Tools", () => {
    const resolver = new ToolResolver(toolCatalog);
    const input = request();

    expect(resolver.resolve(input, ["repository-read"])).toEqual(["read"]);
  });

  it("rejects Tools that require denied permissions, authority, or unrequested capabilities", () => {
    const input = request();
    expect(() =>
      new ToolResolver(toolCatalog).resolve(
        {
          ...input,
          permissions: { ...input.permissions, filesystem: [] },
        },
        ["repository-read"],
      ),
    ).toThrow("requires denied permission");
    expect(() => new ToolResolver(toolCatalog).resolve(input, ["repository-write"])).toThrow(
      "requires D1 authority",
    );
    expect(() =>
      new ToolResolver(toolCatalog).resolve(
        {
          ...input,
          authority: { ...input.authority, maximumDLevel: "D1" },
          execution: { ...input.execution, mode: "read-only" },
        },
        ["repository-write"],
      ),
    ).toThrow("not allowed in read-only mode");
    expect(() =>
      new ToolResolver(toolCatalog).resolve(
        {
          ...input,
          authority: { ...input.authority, maximumDLevel: "D1" },
          tools: { resolved: [], policy: { allow: ["read"] } },
        },
        ["repository-write"],
      ),
    ).toThrow("not allowed by the request Tool policy");

    const broadCatalog: ToolCatalog = {
      resolve: () => ({
        name: "write-capable",
        capabilities: ["repository-read", "repository-write"],
      }),
    };
    expect(() => new ToolResolver(broadCatalog).resolve(input, ["repository-read"])).toThrow(
      "unrequested capabilities",
    );
  });

  it("preserves permission and authority ceilings while resolving the request", () => {
    const input = request();
    const resolved = new ExecutionResolver({
      modelCatalog: modelCatalog(["configured/model"]),
      toolCatalog,
    }).resolve(input, ["repository-read"]);

    expect(resolved.tools.resolved).toEqual(["read"]);
    expect(resolved.model).toEqual({
      requested: "unavailable/model",
      actual: "configured/model",
      thinkingLevel: "medium",
      allowedFallback: ["configured/model"],
    });
    expect(resolved.permissions).toEqual(input.permissions);
    expect(resolved.authority).toEqual(input.authority);
    expect(resolved.tools.policy).toEqual(input.tools.policy);
  });
});
