import { describe, expect, it } from "vitest";
import {
  AgentPermissionError,
  validateAgentExecutionRequest,
} from "../../src/agents/permission-policy.js";
import type {
  AgentExecutionMode,
  AgentExecutionRequestV1,
  JsonValue,
} from "../../src/contracts/execution/agent-execution.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";

const RUN_ID = "run-001" as RunId;
const STEP_ID = "step-001" as StepId;
const EXECUTION_ID = "exec-001" as ExecutionId;

type AgentId = AgentExecutionRequestV1["identity"]["agentId"];

type RequestOverrides = Readonly<{
  mode?: AgentExecutionMode;
  authority?: string;
  filesystem?: readonly JsonValue[];
  shell?: readonly JsonValue[];
  git?: readonly JsonValue[];
  network?: readonly JsonValue[];
  repositoryTargets?: readonly JsonValue[];
  tools?: AgentExecutionRequestV1["tools"];
  skills?: AgentExecutionRequestV1["skills"];
}>;

function request(agentId: AgentId, overrides: RequestOverrides = {}): AgentExecutionRequestV1 {
  const mode = overrides.mode ?? (agentId === "worker" ? "write" : "read-only");
  const authority =
    overrides.authority ??
    (agentId === "worker" || agentId === "planner"
      ? "D1"
      : agentId === "oracle"
        ? "recommendation-only"
        : "D0");

  return {
    identity: {
      runId: RUN_ID,
      stepId: STEP_ID,
      executionId: EXECUTION_ID,
      agentId,
      agentVersion: "1.0.0",
    },
    objective: { objective: "test permissions", type: "test", completionCriteria: [] },
    retry: { attempt: 1, context: null },
    execution: { mode, timeoutMs: 1_000, cancellationPolicy: {} },
    authority: { maximumDLevel: authority, escalationRules: [] },
    permissions: {
      filesystem: overrides.filesystem ?? [],
      shell: overrides.shell ?? [],
      git: overrides.git ?? [],
      network: overrides.network ?? [],
      repositoryTargets: overrides.repositoryTargets ?? [],
    },
    skills: overrides.skills ?? { required: [], optional: [] },
    tools: overrides.tools ?? { resolved: [], policy: {} },
    model: { requested: "test", actual: "test", thinkingLevel: "low", allowedFallback: [] },
    context: { pack: {}, manifest: {}, artifactRefs: [] },
    outputs: { expectedArtifactTypes: [], outputContract: {} },
  };
}

function expectDenied(input: AgentExecutionRequestV1, code: string): void {
  expect(() => validateAgentExecutionRequest(input)).toThrowError(
    expect.objectContaining({ code }),
  );
}

describe("Agent permission policy", () => {
  it.each(["scout", "planner", "reviewer"] as const)(
    "denies source writes for %s before dispatch",
    (agentId) => {
      expectDenied(request(agentId, { filesystem: ["repository-write"] }), "WRITE_DENIED");
      expectDenied(request(agentId, { tools: { resolved: ["edit"], policy: {} } }), "WRITE_DENIED");
      expectDenied(request(agentId, { tools: { resolved: ["bash"], policy: {} } }), "WRITE_DENIED");
      expectDenied(request(agentId, { shell: ["bash"] }), "WRITE_DENIED");
    },
  );

  it("keeps the Worker write scope relative and denies Git writes", () => {
    expect(
      validateAgentExecutionRequest(
        request("worker", {
          repositoryTargets: ["./src/"],
          git: ["status"],
          tools: { resolved: ["write"], policy: { allow: ["write"] } },
        }),
      ).identity.agentId,
    ).toBe("worker");
    expect(
      validateAgentExecutionRequest(
        request("worker", { repositoryTargets: ["./src/"], git: ["status"] }),
      ).identity.agentId,
    ).toBe("worker");
    expectDenied(request("worker", { git: ["commit"] }), "GIT_WRITE_DENIED");
    expectDenied(request("worker", { repositoryTargets: ["../outside"] }), "PATH_TRAVERSAL");
    expectDenied(
      request("scout", { repositoryTargets: ["artifacts/../secret"] }),
      "PATH_TRAVERSAL",
    );
  });

  it("allows selected Researcher network access and denies it for other Agents", () => {
    expect(
      validateAgentExecutionRequest(
        request("researcher", {
          network: ["internet"],
          tools: { resolved: ["fetch"], policy: {} },
        }),
      ).identity.agentId,
    ).toBe("researcher");
    expectDenied(request("scout", { network: ["internet"] }), "NETWORK_DENIED");
    expectDenied(
      request("planner", { tools: { resolved: ["network"], policy: {} } }),
      "NETWORK_DENIED",
    );
  });

  it("does not allow a Skill outside the Agent allowlist", () => {
    expectDenied(
      request("scout", { skills: { required: [{ id: "tdd", version: "1.0.0" }], optional: [] } }),
      "SKILL_DENIED",
    );
  });

  it("enforces mode and authority ceilings", () => {
    expectDenied(request("planner", { mode: "write" }), "MODE_DENIED");
    expectDenied(request("scout", { authority: "D1" }), "AUTHORITY_DENIED");
  });

  it("exposes a stable permission error", () => {
    const action = () => validateAgentExecutionRequest(request("scout", { network: ["internet"] }));
    expect(action).toThrowError(AgentPermissionError);
    expect(action).toThrowError(expect.objectContaining({ code: "NETWORK_DENIED" }));
  });
});
