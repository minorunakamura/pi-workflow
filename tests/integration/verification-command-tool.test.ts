import { execFile as nodeExecFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  applyVerificationEvidence,
  createVerificationCommandPolicy,
  decodeVerificationPolicy,
  encodeVerificationPolicy,
  parseApprovedVerificationCommand,
  verificationPolicyValue,
  registerVerificationCommandTool,
  verificationPolicyForRequest,
} from "../../src/adapters/pi/verification-command-tool.js";
import { runVerificationCommand } from "../../src/adapters/repository/verification-command-runner.js";
import { FileArtifactStore } from "../../src/adapters/persistence/write/file-artifact-store.js";
import { VerifierFinalizer } from "../../src/application/execution/verifier-finalizer.js";
import type {
  AgentExecutionRequestV1,
  StepResultV1,
} from "../../src/contracts/execution/agent-execution.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import { GitRepositoryAdapter } from "../../src/adapters/repository/git-repository-adapter.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const execFile = promisify(nodeExecFile);

type RegisteredTool = {
  execute(
    toolCallId: string,
    params: { command: string; timeout?: number },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: ExtensionContext,
  ): Promise<{ content: readonly unknown[]; details: unknown; isError?: boolean }>;
};

function request(
  policy: ReturnType<typeof createVerificationCommandPolicy>,
): AgentExecutionRequestV1 {
  return {
    identity: {
      runId: policy.runId as RunId,
      stepId: "step-001" as StepId,
      executionId: policy.executionId as ExecutionId,
      agentId: "verifier",
      agentVersion: "1.0.0",
    },
    objective: { objective: "verify", type: "verification", completionCriteria: [] },
    retry: { attempt: 1, context: null },
    execution: { mode: "verify-only", timeoutMs: policy.timeoutMs, cancellationPolicy: {} },
    authority: { maximumDLevel: "D0", escalationRules: [] },
    permissions: {
      filesystem: ["repository"],
      shell: [],
      git: [],
      network: [],
      repositoryTargets: [],
    },
    skills: { required: [], optional: [] },
    tools: {
      resolved: ["read", "verification"],
      policy: { allow: ["read", "verification"], verification: verificationPolicyValue(policy) },
    },
    model: { requested: "test", actual: "test", thinkingLevel: "low", allowedFallback: [] },
    context: { pack: {}, manifest: {}, artifactRefs: [] },
    outputs: { expectedArtifactTypes: [], outputContract: {} },
  };
}

function result(input: AgentExecutionRequestV1): StepResultV1 {
  return {
    identity: input.identity,
    outcome: "completed",
    mode: "verify-only",
    summary: "verification completed",
    artifacts: [],
    uncertainty_candidates: [],
    decision_requests: [],
    requirement_candidates: { acceptance_criteria: [], constraints: [], assumptions: [] },
    finding_candidates: [],
    finding_rechecks: [],
    plan_deviations: [],
    skill_requests: [],
    execution_checks: [
      { type: "test", status: "passed", required: true, evidence: { exit_code: 0 } },
    ],
    observations: [],
    blocked: null,
    failure: null,
    runtime: {},
  };
}

function policy(root: string, checks: readonly unknown[], timeoutMs = 1_000) {
  return createVerificationCommandPolicy({
    runId: "run-901",
    executionId: "exec-001",
    repositoryRoot: root,
    timeoutMs,
    evidencePath: join(
      root,
      ".pi",
      "runs",
      "run-901",
      "runtime",
      "executions",
      "exec-001-verification.json",
    ),
    checks,
  });
}

async function initializeGit(root: string): Promise<void> {
  const run = (args: readonly string[]) => execFile("git", [...args], { cwd: root });
  await run(["init", "--quiet"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Pi Workflow Test"]);
  await run(["config", "commit.gpgSign", "false"]);
  await run(["add", "--", "."]);
  await run(["commit", "--quiet", "-m", "initial"]);
}

function restoreEnvironment(previous: string | undefined): void {
  if (previous === undefined) delete process.env.PI_WORKFLOW_VERIFICATION_POLICY_V1;
  else process.env.PI_WORKFLOW_VERIFICATION_POLICY_V1 = previous;
}

describe("verification command policy and Tool", () => {
  it("keeps an inspection intent out of the command policy even when type is omitted", async () => {
    await withTempRepository({}, async (root) => {
      const approved = policy(root, [
        {
          check: "依存と変更範囲の inspection",
          command: "変更 diff とファイル内容を inspection",
        },
      ]);
      expect(approved.checks).toMatchObject([
        { key: "check-1", type: "inspection", required: true },
      ]);
      expect(approved.checks[0]).not.toHaveProperty("command");
      expect(approved.checks[0]).not.toHaveProperty("executable");
    });
  });

  it("exposes only the approved verification Tool and records an actual passing command", async () => {
    await withTempRepository(
      {
        "pass.test.mjs": "import { test } from 'node:test'; test('pass', () => {});\n",
      },
      async (root) => {
        const approved = policy(root, [
          { type: "test", command: "node --test pass.test.mjs", required: true },
        ]);
        let tool: RegisteredTool | undefined;
        registerVerificationCommandTool({
          registerTool: (value) => (tool = value as unknown as RegisteredTool),
        });
        const input = request(approved);
        const previous = process.env.PI_WORKFLOW_VERIFICATION_POLICY_V1;
        process.env.PI_WORKFLOW_VERIFICATION_POLICY_V1 = encodeVerificationPolicy(approved);
        try {
          const response = await tool!.execute(
            "tool-001",
            { command: "node --test pass.test.mjs" },
            undefined,
            undefined,
            { cwd: root } as unknown as ExtensionContext,
          );
          expect(response.isError).not.toBe(true);
          expect(JSON.stringify(response.details)).toContain('"status":"passed"');
          const records = JSON.parse(await readFile(approved.evidencePath, "utf8")) as Array<{
            status: string;
            exit_code: number;
            command: string;
          }>;
          expect(records).toMatchObject([
            { status: "passed", exit_code: 0, command: "node --test pass.test.mjs" },
          ]);

          const actual = applyVerificationEvidence(result(input), input);
          expect(actual.execution_checks).toMatchObject([
            { type: "test", status: "passed", required: true },
          ]);
          expect(actual.runtime.commands_executed).toEqual(["node --test pass.test.mjs"]);
        } finally {
          restoreEnvironment(previous);
        }
      },
    );
  });

  it("does not execute a command outside the approved fixed-argv policy", async () => {
    await withTempRepository({}, async (root) => {
      const approved = policy(root, [{ type: "test", command: "node --test", required: true }]);
      const previous = process.env.PI_WORKFLOW_VERIFICATION_POLICY_V1;
      process.env.PI_WORKFLOW_VERIFICATION_POLICY_V1 = encodeVerificationPolicy(approved);
      let tool: RegisteredTool | undefined;
      registerVerificationCommandTool({
        registerTool: (value) => (tool = value as unknown as RegisteredTool),
      });
      try {
        const response = await tool!.execute(
          "tool-002",
          { command: "node --test && touch escaped.txt" },
          undefined,
          undefined,
          { cwd: root } as unknown as ExtensionContext,
        );
        expect(response.isError).toBe(true);
        await expect(readFile(join(root, "escaped.txt"), "utf8")).rejects.toThrow();
        expect(
          parseApprovedVerificationCommand("node --test && touch escaped.txt"),
        ).toBeUndefined();
      } finally {
        restoreEnvironment(previous);
      }
    });
  });

  it("maps missing executables to unavailable and delayed processes to unavailable timeout", async () => {
    await withTempRepository(
      {
        "hang.test.mjs":
          "import { test } from 'node:test'; test('hang', async () => await new Promise(() => {}));\n",
      },
      async (root) => {
        const missing = await runVerificationCommand({
          executable: "pi-workflow-missing-node",
          args: [],
          cwd: root,
          timeoutMs: 100,
          env: { PATH: "" },
        });
        expect(missing).toMatchObject({
          status: "unavailable",
          reason: "executable-unavailable",
          timedOut: false,
        });

        const parsed = parseApprovedVerificationCommand("node --test hang.test.mjs");
        expect(parsed).toBeDefined();
        const timeout = await runVerificationCommand({
          executable: parsed!.executable,
          args: parsed!.args,
          cwd: root,
          timeoutMs: 100,
          env: { PATH: process.env.PATH ?? "" },
        });
        expect(timeout).toMatchObject({ status: "unavailable", reason: "timeout", timedOut: true });
      },
    );
  });

  it("detects an unexpected test-created file through repository post-state", async () => {
    await withTempRepository(
      {
        ".gitignore": ".pi/\n",
        "mutate.test.mjs":
          "import { writeFileSync } from 'node:fs'; writeFileSync('unexpected.txt', 'x');\n",
      },
      async (root) => {
        await initializeGit(root);
        const repository = new GitRepositoryAdapter(root);
        const before = await repository.captureSnapshot();
        const approved = policy(root, [
          { type: "test", command: "node --test mutate.test.mjs", required: true },
        ]);
        const input = request(approved);
        const previous = process.env.PI_WORKFLOW_VERIFICATION_POLICY_V1;
        process.env.PI_WORKFLOW_VERIFICATION_POLICY_V1 = encodeVerificationPolicy(approved);
        let tool: RegisteredTool | undefined;
        registerVerificationCommandTool({
          registerTool: (value) => (tool = value as unknown as RegisteredTool),
        });
        try {
          await tool!.execute(
            "tool-003",
            { command: "node --test mutate.test.mjs" },
            undefined,
            undefined,
            { cwd: root } as unknown as ExtensionContext,
          );
        } finally {
          restoreEnvironment(previous);
        }
        const after = await repository.captureSnapshot();
        const diff = await repository.diff(before, after);
        expect(diff.changedFiles).toContain("unexpected.txt");
        const finalized = await new VerifierFinalizer({
          artifactStore: new FileArtifactStore(root),
          repository,
        }).finalize({
          request: input,
          result: applyVerificationEvidence(result(input), input),
          before,
          after,
          diff,
          executionStateRevision: 1,
        });
        expect(finalized.verificationRun).toMatchObject({
          status: "partial",
          result: "incomplete",
          accepted: false,
          repository: { mutated: true, changedFiles: ["unexpected.txt"] },
        });
      },
    );
  });

  it("round-trips the policy and forces missing execution evidence to unavailable", async () => {
    await withTempRepository({}, async (root) => {
      const approved = policy(root, [{ type: "test", command: "node --test", required: true }]);
      const decoded = decodeVerificationPolicy(encodeVerificationPolicy(approved));
      expect(decoded).toMatchObject({ runId: "run-901", executionId: "exec-001" });
      const input = request(approved);
      expect(verificationPolicyForRequest(input)).toMatchObject({ checks: [{ key: "check-1" }] });
      expect(applyVerificationEvidence(result(input), input).execution_checks).toMatchObject([
        { status: "unavailable", required: true },
      ]);
    });
  });

  it("does not promote a model-passed inspection without an actual inspection record", async () => {
    await withTempRepository({}, async (root) => {
      const approved = policy(root, [
        { type: "inspection", command: "inspect repository", required: true },
      ]);
      const input = request(approved);
      const actual = applyVerificationEvidence(
        {
          ...result(input),
          execution_checks: [
            {
              type: "inspection",
              status: "passed",
              required: true,
              evidence: {
                inspection_performed: true,
                evidence_refs: ["repository"],
                observed: { changed_files: [] },
              },
            },
          ],
        },
        input,
      );
      expect(actual.execution_checks).toMatchObject([
        {
          type: "inspection",
          status: "unavailable",
          evidence: { source: "verification-tool", status: "unavailable" },
        },
      ]);
    });
  });
});
