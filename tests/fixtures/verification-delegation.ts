import { execFileSync } from "node:child_process";
import type { AgentExecutionRequestV1 } from "../../src/contracts/execution/agent-execution.js";
import {
  appendVerificationEvidenceRecord,
  parseApprovedVerificationCommand,
  verificationPolicyForRequest,
} from "../../src/adapters/pi/verification-command-tool.js";
import type { SubagentDelegationRequest } from "pi-subagents/delegation";

function taskRequest(request: SubagentDelegationRequest): AgentExecutionRequestV1 {
  const marker = "Execution request (JSON):";
  const start = request.task.indexOf(marker);
  const jsonStart = request.task.indexOf("\n\n", start + marker.length);
  const jsonEnd = request.task.indexOf("\n\nReturn only", jsonStart + 2);
  if (start < 0 || jsonStart < 0 || jsonEnd < 0) {
    throw new Error("Delegation task does not contain the Workflow execution request");
  }
  return JSON.parse(request.task.slice(jsonStart + 2, jsonEnd)) as AgentExecutionRequestV1;
}

function errorOutput(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = error as { stdout?: unknown; stderr?: unknown };
  return [value.stdout, value.stderr]
    .filter(
      (entry): entry is string | Buffer => typeof entry === "string" || Buffer.isBuffer(entry),
    )
    .map((entry) => (Buffer.isBuffer(entry) ? entry.toString("utf8") : entry))
    .join("");
}

/** Test-only bridge helper: runs the same approved command used by the live Tool. */
export function executeVerificationRequest(
  request: AgentExecutionRequestV1,
  statusOverride?: "passed" | "failed" | "unavailable",
): void {
  if (request.identity.agentId !== "verifier") return;
  const policy = verificationPolicyForRequest(request);
  if (policy === undefined) return;
  for (const check of policy.checks) {
    const parsed =
      check.command === undefined ? undefined : parseApprovedVerificationCommand(check.command);
    const startedAt = Date.now();
    let status = statusOverride;
    let exitCode: number | null =
      statusOverride === "passed" ? 0 : statusOverride === "failed" ? 1 : null;
    let stdout = "";
    let stderr = "";
    let reason: string | undefined;
    if (status === undefined && parsed !== undefined) {
      try {
        stdout = execFileSync(parsed.executable, [...parsed.args], {
          cwd: policy.cwd,
          encoding: "utf8",
          env: { PATH: process.env.PATH, CI: "1" },
          maxBuffer: 64 * 1024,
        });
        status = "passed";
        exitCode = 0;
      } catch (error) {
        status = "failed";
        exitCode = 1;
        const output = errorOutput(error);
        stderr = output;
        reason = "command-failed";
      }
    }
    if (status === undefined) {
      status = "unavailable";
      reason = check.reason ?? "command-not-approved";
    }
    appendVerificationEvidenceRecord(policy, check.key, {
      status,
      exitCode,
      stdout,
      stderr,
      durationMs: Math.max(0, Date.now() - startedAt),
      timedOut: reason === "timeout",
      outputTruncated: false,
      ...(reason === undefined ? {} : { reason }),
    });
  }
}

export function executeDelegatedVerification(
  request: SubagentDelegationRequest,
  statusOverride?: "passed" | "failed" | "unavailable",
): void {
  if (request.agent !== "verifier") return;
  executeVerificationRequest(taskRequest(request), statusOverride);
}
