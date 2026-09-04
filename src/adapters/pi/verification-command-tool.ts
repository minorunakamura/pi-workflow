import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import {
  createBashTool,
  type BashToolInput,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentExecutionRequestV1,
  JsonObject,
  JsonValue,
  StepResultV1,
} from "../../contracts/execution/agent-execution.js";
import { redactSecrets } from "../../telemetry/redaction.js";
import {
  runVerificationCommand,
  type VerificationCommandRunnerResult,
} from "../repository/verification-command-runner.js";

export const VERIFICATION_TOOL_NAME = "verification";
export const VERIFICATION_POLICY_ENV = "PI_WORKFLOW_VERIFICATION_POLICY_V1";
const VERIFICATION_POLICY_VERSION = 1 as const;
const VERIFICATION_CHECK_TYPES = [
  "test",
  "build",
  "lint",
  "typecheck",
  "format",
  "behavior",
  "regression",
  "inspection",
  "manual",
] as const;
type VerificationCheckType = (typeof VERIFICATION_CHECK_TYPES)[number];
const VERIFICATION_STATUSES = ["passed", "failed", "unavailable"] as const;
type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
const SAFE_ENVIRONMENT_KEYS = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "TMP",
  "TEMP",
  "TMPDIR",
  "CI",
  "LANG",
  "LC_ALL",
  "SYSTEMROOT",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
] as const;
const COMMAND_TOKEN = /^[A-Za-z0-9_./:@=+,-]+$/u;
const SHELL_SYNTAX = /[;&|><`$(){}[\]\\*?!~"']/u;
const SAFE_RUN_ID = /^run-\d+$/u;
const SAFE_EXECUTION_ID = /^exec-\d+$/u;
const APPROVED_PACKAGE_SCRIPTS = new Set([
  "test",
  "check",
  "typecheck",
  "lint",
  "format:check",
  "build",
]);

export type VerificationCommandPolicyCheck = Readonly<{
  key: string;
  type: VerificationCheckType;
  required: boolean;
  command?: string;
  executable?: string;
  args?: readonly string[];
  reason?: string;
}>;

export type VerificationCommandPolicy = Readonly<{
  version: typeof VERIFICATION_POLICY_VERSION;
  runId: string;
  executionId: string;
  repositoryRoot: string;
  cwd: string;
  timeoutMs: number;
  evidencePath: string;
  checks: readonly VerificationCommandPolicyCheck[];
}>;

type VerificationEvidenceRecord = Readonly<{
  version: typeof VERIFICATION_POLICY_VERSION;
  run_id: string;
  execution_id: string;
  check: string;
  command: string | null;
  type: VerificationCheckType;
  required: boolean;
  status: VerificationStatus;
  exit_code: number | null;
  cwd: string;
  timeout_ms: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  output_truncated: boolean;
  reason?: string;
}>;

type ParsedCommand = Readonly<{
  executable: string;
  args: readonly string[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function safeRelativeTestPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.includes("\\") &&
    !value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  );
}

function executableName(value: string): string {
  return basename(value)
    .toLowerCase()
    .replace(/\.(?:cmd|exe)$/u, "");
}

/** Parses only repository test commands; the returned argv is never shell-parsed. */
export function parseApprovedVerificationCommand(command: string): ParsedCommand | undefined {
  const normalized = command.trim();
  if (
    normalized.length === 0 ||
    hasControlCharacter(normalized) ||
    SHELL_SYNTAX.test(normalized) ||
    normalized.split(/\s+/u).some((token) => !COMMAND_TOKEN.test(token))
  ) {
    return undefined;
  }
  const tokens = normalized.split(/\s+/u);
  const executable = tokens[0];
  if (executable === undefined || isAbsolute(executable) || executable.includes("/")) {
    return undefined;
  }

  if (executableName(executable) === "node") {
    if (tokens[1] === "--test") {
      const args = tokens.slice(2);
      return args.every(safeRelativeTestPath) ? { executable, args: tokens.slice(1) } : undefined;
    }
    const script = tokens[1];
    const scriptIsRepositoryModule =
      script !== undefined && safeRelativeTestPath(script) && /\.(?:cjs|js|mjs)$/u.test(script);
    const args = tokens.slice(2);
    return scriptIsRepositoryModule && args.every((arg) => safeRelativeTestPath(arg))
      ? { executable, args: tokens.slice(1) }
      : undefined;
  }

  const name = executableName(executable);
  const script = tokens.slice(1).join(" ");
  const scriptName = script.startsWith("run ") ? script.slice(4) : script;
  const isPackageScript =
    ["pnpm", "npm", "yarn", "bun"].includes(name) && APPROVED_PACKAGE_SCRIPTS.has(scriptName);
  return isPackageScript ? { executable, args: tokens.slice(1) } : undefined;
}

function commandFromPlanCheck(value: unknown): string | undefined {
  if (isRecord(value) && (value.type === "inspection" || value.type === "manual")) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (!isRecord(value)) return undefined;
  for (const key of ["command", "check"] as const) {
    if (typeof value[key] === "string" && value[key].trim().length > 0) {
      return value[key].trim();
    }
  }
  return undefined;
}

function checkType(value: unknown): VerificationCheckType {
  return typeof value === "string" &&
    VERIFICATION_CHECK_TYPES.includes(value as VerificationCheckType)
    ? (value as VerificationCheckType)
    : "test";
}

function checkRequired(value: unknown): boolean {
  return typeof value === "boolean" ? value : true;
}

function planCheckKey(index: number): string {
  return `check-${index + 1}`;
}

/** Converts Planner check intent into an Orchestrator-approved, fixed-argv policy. */
export function createVerificationCommandPolicy(
  input: Readonly<{
    runId: string;
    executionId: string;
    repositoryRoot: string;
    timeoutMs: number;
    evidencePath: string;
    checks: readonly unknown[];
  }>,
): VerificationCommandPolicy {
  const checks = input.checks.map((value, index) => {
    const command = commandFromPlanCheck(value);
    const parsed = command === undefined ? undefined : parseApprovedVerificationCommand(command);
    const record = isRecord(value) ? value : undefined;
    return {
      key: planCheckKey(index),
      type: checkType(record?.type),
      required: checkRequired(record?.required),
      ...(command === undefined ? {} : { command }),
      ...(parsed === undefined
        ? command === undefined
          ? {}
          : { reason: "command-not-approved" }
        : { executable: parsed.executable, args: [...parsed.args] }),
    } satisfies VerificationCommandPolicyCheck;
  });
  return {
    version: VERIFICATION_POLICY_VERSION,
    runId: input.runId,
    executionId: input.executionId,
    repositoryRoot: resolve(input.repositoryRoot),
    cwd: resolve(input.repositoryRoot),
    timeoutMs: input.timeoutMs,
    evidencePath: resolve(input.evidencePath),
    checks,
  };
}

function parsePolicy(value: unknown): VerificationCommandPolicy | undefined {
  if (!isRecord(value) || value.version !== VERIFICATION_POLICY_VERSION) return undefined;
  const runId = value.run_id;
  const executionId = value.execution_id;
  const repositoryRoot = value.repository_root;
  const cwd = value.cwd;
  const evidencePath = value.evidence_path;
  const timeoutMs = value.timeout_ms;
  const checksValue = value.checks;
  if (
    typeof runId !== "string" ||
    !SAFE_RUN_ID.test(runId) ||
    typeof executionId !== "string" ||
    !SAFE_EXECUTION_ID.test(executionId) ||
    !nonEmptyString(repositoryRoot) ||
    !nonEmptyString(cwd) ||
    !nonEmptyString(evidencePath) ||
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Array.isArray(checksValue)
  ) {
    return undefined;
  }

  const checks: VerificationCommandPolicyCheck[] = [];
  for (const [index, candidate] of checksValue.entries()) {
    if (!isRecord(candidate) || candidate.key !== planCheckKey(index)) return undefined;
    const type = checkType(candidate.type);
    if (candidate.type !== type || typeof candidate.required !== "boolean") return undefined;
    if (candidate.command !== undefined && !nonEmptyString(candidate.command)) return undefined;
    if (candidate.executable !== undefined && !nonEmptyString(candidate.executable))
      return undefined;
    if (
      candidate.args !== undefined &&
      (!Array.isArray(candidate.args) || candidate.args.some((arg) => typeof arg !== "string"))
    ) {
      return undefined;
    }
    checks.push({
      key: candidate.key,
      type,
      required: candidate.required,
      ...(candidate.command === undefined ? {} : { command: candidate.command }),
      ...(candidate.executable === undefined ? {} : { executable: candidate.executable }),
      ...(candidate.args === undefined ? {} : { args: candidate.args as string[] }),
      ...(typeof candidate.reason === "string" ? { reason: candidate.reason } : {}),
    });
  }
  return {
    version: VERIFICATION_POLICY_VERSION,
    runId,
    executionId,
    repositoryRoot: resolve(repositoryRoot),
    cwd: resolve(cwd),
    timeoutMs,
    evidencePath: resolve(evidencePath),
    checks,
  };
}

function policyJson(policy: VerificationCommandPolicy): JsonObject {
  return {
    version: policy.version,
    run_id: policy.runId,
    execution_id: policy.executionId,
    repository_root: policy.repositoryRoot,
    cwd: policy.cwd,
    timeout_ms: policy.timeoutMs,
    evidence_path: policy.evidencePath,
    checks: policy.checks.map((check) => ({
      key: check.key,
      type: check.type,
      required: check.required,
      ...(check.command === undefined ? {} : { command: check.command }),
      ...(check.executable === undefined ? {} : { executable: check.executable }),
      ...(check.args === undefined ? {} : { args: [...check.args] }),
      ...(check.reason === undefined ? {} : { reason: check.reason }),
    })),
  };
}

export function verificationPolicyValue(policy: VerificationCommandPolicy): JsonObject {
  return policyJson(policy);
}

export function verificationPolicyForRequest(
  request: AgentExecutionRequestV1,
): VerificationCommandPolicy | undefined {
  if (request.identity.agentId !== "verifier" || !isRecord(request.tools.policy)) return undefined;
  return parsePolicy(request.tools.policy.verification);
}

export function encodeVerificationPolicy(policy: VerificationCommandPolicy): string {
  return Buffer.from(JSON.stringify(policyJson(policy)), "utf8").toString("base64url");
}

export function decodeVerificationPolicy(
  value: string | undefined,
): VerificationCommandPolicy | undefined {
  if (value === undefined || value.length === 0) return undefined;
  try {
    return parsePolicy(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { CI: "1" };
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function expectedEvidencePath(policy: VerificationCommandPolicy): string {
  return resolve(
    policy.repositoryRoot,
    ".pi",
    "runs",
    policy.runId,
    "runtime",
    "executions",
    `${policy.executionId}-verification.json`,
  );
}

function evidencePathIsSafe(policy: VerificationCommandPolicy): boolean {
  const expected = expectedEvidencePath(policy);
  const relativePath = relative(resolve(policy.repositoryRoot), resolve(policy.evidencePath));
  return (
    resolve(policy.evidencePath) === expected &&
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !isAbsolute(relativePath)
  );
}

function evidenceRecord(value: unknown): VerificationEvidenceRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.version !== VERIFICATION_POLICY_VERSION ||
    typeof value.run_id !== "string" ||
    !SAFE_RUN_ID.test(value.run_id) ||
    typeof value.execution_id !== "string" ||
    !SAFE_EXECUTION_ID.test(value.execution_id) ||
    typeof value.check !== "string" ||
    (value.command !== null && typeof value.command !== "string") ||
    typeof value.type !== "string" ||
    !VERIFICATION_CHECK_TYPES.includes(value.type as VerificationCheckType) ||
    typeof value.required !== "boolean" ||
    typeof value.status !== "string" ||
    !VERIFICATION_STATUSES.includes(value.status as VerificationStatus) ||
    (value.exit_code !== null && !Number.isSafeInteger(value.exit_code)) ||
    !nonEmptyString(value.cwd) ||
    typeof value.timeout_ms !== "number" ||
    !Number.isSafeInteger(value.timeout_ms) ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    typeof value.duration_ms !== "number" ||
    !Number.isSafeInteger(value.duration_ms) ||
    typeof value.output_truncated !== "boolean"
  ) {
    return undefined;
  }
  return value as unknown as VerificationEvidenceRecord;
}

export function readVerificationEvidence(
  policy: VerificationCommandPolicy,
): readonly VerificationEvidenceRecord[] {
  if (!evidencePathIsSafe(policy) || !existsSync(policy.evidencePath)) return [];
  try {
    const value: unknown = JSON.parse(readFileSync(policy.evidencePath, "utf8"));
    if (!Array.isArray(value)) return [];
    return value
      .map(evidenceRecord)
      .filter(
        (record): record is VerificationEvidenceRecord =>
          record !== undefined &&
          record.run_id === policy.runId &&
          record.execution_id === policy.executionId &&
          resolve(record.cwd) === policy.cwd,
      );
  } catch {
    return [];
  }
}

function appendVerificationEvidence(
  policy: VerificationCommandPolicy,
  record: VerificationEvidenceRecord,
): void {
  if (!evidencePathIsSafe(policy))
    throw new Error("Verification evidence path is outside the Run runtime area");
  mkdirSync(resolve(policy.evidencePath, ".."), { recursive: true, mode: 0o700 });
  const current = readVerificationEvidence(policy);
  writeFileSync(policy.evidencePath, `${JSON.stringify([...current, record], null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function evidenceRecordFor(
  policy: VerificationCommandPolicy,
  check: VerificationCommandPolicyCheck,
  result: VerificationCommandRunnerResult,
): VerificationEvidenceRecord {
  return {
    version: VERIFICATION_POLICY_VERSION,
    run_id: policy.runId,
    execution_id: policy.executionId,
    check: check.key,
    command: check.command ?? null,
    type: check.type,
    required: check.required,
    status: result.status,
    exit_code: result.exitCode,
    cwd: policy.cwd,
    timeout_ms: policy.timeoutMs,
    stdout: redactSecrets(result.stdout),
    stderr: redactSecrets(result.stderr),
    duration_ms: result.durationMs,
    output_truncated: result.outputTruncated,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}

export function appendVerificationEvidenceRecord(
  policy: VerificationCommandPolicy,
  checkKey: string,
  result: VerificationCommandRunnerResult,
): void {
  const check = policy.checks.find((candidate) => candidate.key === checkKey);
  if (check === undefined) throw new Error(`Unknown verification check ${checkKey}`);
  appendVerificationEvidence(policy, evidenceRecordFor(policy, check, result));
}

function unavailableResult(
  policy: VerificationCommandPolicy,
  check: VerificationCommandPolicyCheck,
  reason: string,
): VerificationEvidenceRecord {
  return evidenceRecordFor(policy, check, {
    status: "unavailable",
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    timedOut: reason === "timeout",
    outputTruncated: false,
    reason,
  });
}

function resultText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function toolResult(
  value: unknown,
  isError = false,
): {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
  details: JsonObject;
} {
  return {
    content: [{ type: "text", text: resultText(value) }],
    ...(isError ? { isError: true } : {}),
    details: isRecord(value) ? (value as JsonObject) : {},
  };
}

function selectedCheck(
  policy: VerificationCommandPolicy,
  command: string,
  evidence: readonly VerificationEvidenceRecord[],
): VerificationCommandPolicyCheck | undefined {
  const candidates = policy.checks.filter((check) => check.command === command.trim());
  return (
    candidates.find((check) => !evidence.some((record) => record.check === check.key)) ??
    candidates[0]
  );
}

function commandSummary(
  policy: VerificationCommandPolicy,
  check: VerificationCommandPolicyCheck,
  evidence: VerificationEvidenceRecord,
): JsonObject {
  return {
    kind: "verification-result",
    check: check.key,
    command: check.command ?? null,
    type: check.type,
    required: check.required,
    status: evidence.status,
    exit_code: evidence.exit_code,
    cwd: evidence.cwd,
    timeout_ms: evidence.timeout_ms,
    duration_ms: evidence.duration_ms,
    stdout: evidence.stdout,
    stderr: evidence.stderr,
    output_truncated: evidence.output_truncated,
    ...(evidence.reason === undefined ? {} : { reason: evidence.reason }),
    evidence_path: policy.evidencePath,
  };
}

export async function executeApprovedVerificationCheck(
  policy: VerificationCommandPolicy,
  command: string,
  signal?: AbortSignal,
): Promise<Readonly<{ evidence: VerificationEvidenceRecord; summary: JsonObject }> | JsonObject> {
  const check = selectedCheck(policy, command, readVerificationEvidence(policy));
  if (check === undefined) {
    return {
      kind: "verification-result",
      status: "unavailable",
      reason: "command-not-approved",
      requested_command: command,
    };
  }

  const evidence =
    check.executable === undefined || check.args === undefined
      ? unavailableResult(policy, check, check.reason ?? "command-not-approved")
      : evidenceRecordFor(
          policy,
          check,
          await runVerificationCommand({
            executable: check.executable,
            args: check.args,
            cwd: policy.cwd,
            timeoutMs: policy.timeoutMs,
            env: safeEnvironment(),
            ...(signal === undefined ? {} : { signal }),
          }),
        );
  appendVerificationEvidence(policy, evidence);
  return { evidence, summary: commandSummary(policy, check, evidence) };
}

/** Registers a non-shell Tool that executes only Orchestrator-approved check argv. */
export function registerVerificationCommandTool(pi: Pick<ExtensionAPI, "registerTool">): void {
  const parameters = createBashTool(process.cwd()).parameters;
  pi.registerTool({
    name: VERIFICATION_TOOL_NAME,
    label: "verification",
    description:
      "Execute one exact, Orchestrator-approved repository verification command. The supplied command is matched to the approved policy and is never executed directly. This Tool cannot edit source or run arbitrary shell syntax.",
    promptSnippet: "Run an approved repository verification check",
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params: BashToolInput, signal, _onUpdate, context) {
      const encoded = process.env[VERIFICATION_POLICY_ENV];
      const policy = decodeVerificationPolicy(encoded);
      if (policy === undefined) {
        return toolResult(
          {
            kind: "verification-result",
            status: "unavailable",
            reason: "verification-policy-unavailable",
          },
          true,
        );
      }
      if (
        resolve(context.cwd) !== policy.cwd ||
        resolve(policy.cwd) !== resolve(policy.repositoryRoot)
      ) {
        return toolResult(
          {
            kind: "verification-result",
            status: "unavailable",
            reason: "working-directory-not-approved",
            cwd: context.cwd,
          },
          true,
        );
      }

      const previous = readVerificationEvidence(policy);
      const check = selectedCheck(policy, params.command, previous);
      if (check === undefined) {
        return toolResult(
          {
            kind: "verification-result",
            status: "unavailable",
            reason: "command-not-approved",
            requested_command: params.command,
          },
          true,
        );
      }

      try {
        const executed = await executeApprovedVerificationCheck(policy, params.command, signal);
        if ("evidence" in executed && "summary" in executed) {
          return toolResult(executed.summary);
        }
        return toolResult(executed);
      } catch (error) {
        return toolResult(
          {
            kind: "verification-result",
            status: "unavailable",
            reason: "evidence-write-failed",
            message: redactSecrets(error instanceof Error ? error.message : String(error)),
          },
          true,
        );
      }
    },
  });
}

function actualEvidence(
  check: VerificationCommandPolicyCheck,
  records: readonly VerificationEvidenceRecord[],
): VerificationEvidenceRecord | undefined {
  let match: VerificationEvidenceRecord | undefined;
  for (const record of records) {
    if (
      record.check === check.key &&
      record.command === (check.command ?? null) &&
      record.type === check.type &&
      record.required === check.required
    ) {
      match = record;
    }
  }
  return match;
}

function checkEvidence(
  check: VerificationCommandPolicyCheck,
  record: VerificationEvidenceRecord | undefined,
  modelEvidence?: JsonValue,
): JsonObject {
  if (record === undefined) {
    return modelEvidence !== undefined && check.command === undefined
      ? { source: "verifier", value: modelEvidence }
      : {
          source: "verification-tool",
          command: check.command ?? null,
          status: "unavailable",
          reason: check.reason ?? "not-run",
        };
  }
  return {
    source: "verification-tool",
    command: record.command,
    cwd: record.cwd,
    timeout_ms: record.timeout_ms,
    exit_code: record.exit_code,
    stdout: record.stdout,
    stderr: record.stderr,
    duration_ms: record.duration_ms,
    output_truncated: record.output_truncated,
    status: record.status,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  };
}

/** Replaces model-claimed checks with actual records emitted by the verification Tool. */
export function applyVerificationEvidence(
  result: StepResultV1,
  request: AgentExecutionRequestV1,
): StepResultV1 {
  const policy = verificationPolicyForRequest(request);
  if (policy === undefined) return result;
  const records = readVerificationEvidence(policy);
  const executionChecks = policy.checks.map((check, index) => {
    const record = actualEvidence(check, records);
    const modelCheck = result.execution_checks[index];
    const modelStatus =
      isRecord(modelCheck) && typeof modelCheck.status === "string" ? modelCheck.status : undefined;
    const modelEvidence =
      isRecord(modelCheck) && modelCheck.evidence !== undefined ? modelCheck.evidence : undefined;
    return {
      localId: check.key,
      type: check.type,
      status:
        record?.status ??
        (check.command === undefined &&
        (modelStatus === "passed" ||
          modelStatus === "failed" ||
          modelStatus === "skipped" ||
          modelStatus === "unavailable")
          ? modelStatus
          : "unavailable"),
      required: check.required,
      evidence: checkEvidence(check, record, modelEvidence),
    };
  });
  const commands = records
    .map((record) => record.command)
    .filter((command): command is string => command !== null);
  return {
    ...result,
    execution_checks: executionChecks,
    runtime: {
      ...result.runtime,
      commands_executed: commands,
    },
  };
}

export function verificationPolicyForEnvironment(
  request: AgentExecutionRequestV1,
): string | undefined {
  const policy = verificationPolicyForRequest(request);
  return policy === undefined ? undefined : encodeVerificationPolicy(policy);
}
