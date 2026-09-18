import { expect, it } from "vitest";

import { TIMEOUTS, type TrustedGate } from "../../src/core/index.ts";
import {
  executeTrustedGate,
  createManagedGateRun,
} from "../../src/runtime/gate-execution.ts";

function gate(overrides: Partial<TrustedGate> = {}): TrustedGate {
  return {
    name: "package-check",
    command: "pnpm check",
    requirement: "required",
    status: "UNKNOWN",
    source: "package-script",
    reason: "Awaiting managed execution.",
    ...overrides,
  };
}

function passedRun(command = "pnpm check") {
  return {
    ok: true,
    runId: "gate-run-1",
    results: [
      {
        acceptance: {
          evidenceStatus: "verified",
          verifyRuns: [
            {
              id: "gate",
              command,
              exitCode: 0,
              status: "passed",
              durationMs: 12,
              artifactPath: "/managed/gates/package-check.log",
            },
          ],
        },
      },
    ],
  };
}

it("builds one fresh managed acceptance-gate run with the exact command", () => {
  const result = createManagedGateRun(gate(), "package-check");

  expect(result.valid).toBe(true);
  if (!result.valid) return;

  expect(result.value).toMatchObject({
    agent: "scout",
    context: "fresh",
    gate: "pnpm check",
    timeoutMs: TIMEOUTS.gateTimeoutMs,
    output: "trusted-gate-package-check.md",
    outputMode: "file-only",
    artifacts: true,
    worktree: false,
  });
  expect(result.value.task).toContain("exact");
  expect(result.value).not.toHaveProperty("acceptance");
});

it("uses the managed host result and saved evidence, not model prose", async () => {
  const calls: Array<{ key: string; params: unknown }> = [];
  const result = await executeTrustedGate(
    gate(),
    async (key, params) => {
      calls.push({ key, params });
      return passedRun();
    },
    "package-check",
  );

  expect(result.valid).toBe(true);
  if (!result.valid) return;

  expect(calls).toHaveLength(1);
  expect(calls[0]?.key).toBe("package-check");
  expect(result.value).toMatchObject({
    status: "PASS",
    evidence: {
      kind: "managed",
      path: "/managed/gates/package-check.log",
      mediaType: "text/plain",
    },
  });
});

it("keeps an aggregate command as one exact gate without expansion", async () => {
  const commands: string[] = [];
  const result = await executeTrustedGate(
    gate(),
    async (_key, params) => {
      commands.push(params.gate);
      return passedRun(params.gate);
    },
    "package-check",
  );

  expect(result.valid).toBe(true);
  expect(commands).toEqual(["pnpm check"]);
});

it("maps failed commands to FAIL and timeout or missing evidence to UNKNOWN", async () => {
  const failed = await executeTrustedGate(
    gate(),
    async () => ({
      ok: false,
      results: [
        {
          acceptance: {
            evidenceStatus: "rejected",
            verifyRuns: [
              {
                id: "gate",
                command: "pnpm check",
                exitCode: 1,
                status: "failed",
                durationMs: 4,
                artifactPath: "/managed/gates/package-check.log",
              },
            ],
          },
        },
      ],
    }),
    "package-check",
  );
  expect(failed.valid && failed.value.status).toBe("FAIL");

  const timedOut = await executeTrustedGate(
    gate(),
    async () => ({
      ok: false,
      results: [
        {
          acceptance: {
            evidenceStatus: "rejected",
            verifyRuns: [
              {
                id: "gate",
                command: "pnpm check",
                exitCode: null,
                status: "timed-out",
                durationMs: TIMEOUTS.gateTimeoutMs,
                artifactPath: "/managed/gates/package-check.log",
              },
            ],
          },
        },
      ],
    }),
    "package-check",
  );
  expect(timedOut.valid && timedOut.value.status).toBe("UNKNOWN");

  const missingEvidence = await executeTrustedGate(
    gate(),
    async () => ({
      ok: true,
      outputReference: { path: "/managed/model-output.md" },
      results: [
        {
          acceptance: {
            evidenceStatus: "verified",
            verifyRuns: [
              {
                id: "gate",
                command: "pnpm check",
                exitCode: 0,
                status: "passed",
                durationMs: 1,
              },
            ],
          },
        },
      ],
    }),
    "package-check",
  );
  if (!missingEvidence.valid) throw new Error("Expected a valid Gate");
  expect(missingEvidence.value.status).toBe("UNKNOWN");

  const noRuntimeEvidence = await executeTrustedGate(
    gate(),
    async () => ({ ok: true, output: "PASS" }),
    "package-check",
  );
  expect(noRuntimeEvidence.valid && noRuntimeEvidence.value.status).toBe(
    "UNKNOWN",
  );
});

it("does not retry a failed managed gate", async () => {
  let calls = 0;
  const result = await executeTrustedGate(
    gate(),
    async () => {
      calls += 1;
      throw new Error("gate runner unavailable");
    },
    "package-check",
  );

  expect(calls).toBe(1);
  expect(result.valid && result.value.status).toBe("UNKNOWN");
});

it("rejects untrusted command declarations before execution", async () => {
  const invalid = createManagedGateRun(
    gate({ command: "pnpm check\nrm -rf ." }),
    "package-check",
  );
  expect(invalid.valid).toBe(false);

  let calls = 0;
  const result = await executeTrustedGate(
    { ...gate(), source: "not-a-source" },
    async () => {
      calls += 1;
      return passedRun();
    },
    "package-check",
  );
  expect(result.valid).toBe(false);
  expect(calls).toBe(0);
});
