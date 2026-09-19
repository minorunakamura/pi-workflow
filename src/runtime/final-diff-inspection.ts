import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import {
  evaluateFinalDiffInspection,
  type FinalDiffInspectionInput,
  type FinalDiffInspectionResult,
  type WorkingTreeEvidence,
} from "../core/index.ts";
import {
  hasOnlyKeys,
  invalidResult,
  isBoundedString,
  isRecord,
  isSafeRelativePath,
  utf8ByteLength,
  validResult,
  type ValidationResult,
} from "../core/validation.ts";

export const FINAL_DIFF_INSPECTION_TOOL_NAME =
  "pi_workflow_inspect_diff" as const;
export const FINAL_DIFF_INSPECTION_TOOL_PARAMETERS = Type.Object({});
export type FinalDiffInspectionToolParameters = Static<
  typeof FINAL_DIFF_INSPECTION_TOOL_PARAMETERS
>;

export const FINAL_DIFF_INSPECTION_GIT_OPERATIONS = [
  { name: "git status --short", args: ["status", "--short"] },
  { name: "git diff --name-only", args: ["diff", "--name-only"] },
  { name: "git diff --stat", args: ["diff", "--stat"] },
  { name: "git diff --check", args: ["diff", "--check"] },
] as const;

const MAX_EVIDENCE_BYTES = 50 * 1024;
const MAX_ITEM_BYTES = 4096;
const MAX_STAT_BYTES = 16 * 1024;

type CommandStatus = "PASS" | "UNKNOWN";

export interface FinalDiffInspectionCommandEvidence {
  readonly operation: (typeof FINAL_DIFF_INSPECTION_GIT_OPERATIONS)[number]["name"];
  readonly status: CommandStatus;
  readonly reason?: string;
}

export interface FinalDiffInspectionToolEvidence {
  readonly status: "known" | "unknown";
  readonly changedPaths: readonly string[];
  readonly trackedPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
  readonly stat: string;
  readonly commands: readonly FinalDiffInspectionCommandEvidence[];
}

export interface FinalDiffInspectionToolDetails {
  readonly evidence: FinalDiffInspectionToolEvidence;
}

export type FinalDiffInspectionContext = Omit<
  FinalDiffInspectionInput,
  "changedPaths" | "workingTree"
>;

interface GitOperationResult {
  readonly operation: (typeof FINAL_DIFF_INSPECTION_GIT_OPERATIONS)[number]["name"];
  readonly status: CommandStatus;
  readonly stdout: string;
  readonly reason?: string;
}

function boundedReason(reason: string): string {
  const trimmed = reason.trim();
  if (utf8ByteLength(trimmed) <= MAX_ITEM_BYTES) return trimmed;
  return `${trimmed.slice(0, MAX_ITEM_BYTES - 1)}…`;
}

function commandFailure(
  operation: GitOperationResult["operation"],
  reason: string,
): GitOperationResult {
  return {
    operation,
    status: "UNKNOWN",
    stdout: "",
    reason: boundedReason(reason),
  };
}

async function runGitOperation(
  exec: ExtensionAPI["exec"],
  operation: (typeof FINAL_DIFF_INSPECTION_GIT_OPERATIONS)[number],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<GitOperationResult> {
  try {
    const result = await exec("git", [...operation.args], {
      cwd,
      ...(signal === undefined ? {} : { signal }),
    });
    if (
      typeof result.code !== "number" ||
      typeof result.stdout !== "string" ||
      result.killed
    ) {
      return commandFailure(
        operation.name,
        "Git operation returned unknown evidence",
      );
    }
    if (result.code !== 0) {
      return commandFailure(
        operation.name,
        `Git operation exited with code ${result.code}`,
      );
    }
    if (utf8ByteLength(result.stdout) > MAX_EVIDENCE_BYTES) {
      return commandFailure(
        operation.name,
        "Git operation output exceeded the bounded evidence limit",
      );
    }
    return { operation: operation.name, status: "PASS", stdout: result.stdout };
  } catch {
    return commandFailure(operation.name, "Git operation failed");
  }
}

function validatePaths(
  value: unknown,
  fieldName: string,
): ValidationResult<string[]> {
  if (!Array.isArray(value)) {
    return invalidResult(`${fieldName} must be an array`);
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const path of value) {
    if (
      !isBoundedString(path, MAX_ITEM_BYTES, true) ||
      !isSafeRelativePath(path) ||
      seen.has(path)
    ) {
      return invalidResult(
        `${fieldName} contains an invalid or duplicate path`,
      );
    }
    seen.add(path);
    paths.push(path);
  }
  return validResult(paths);
}

function addPath(paths: string[], seen: Set<string>, path: string): boolean {
  if (
    !isBoundedString(path, MAX_ITEM_BYTES, true) ||
    !isSafeRelativePath(path)
  ) {
    return false;
  }
  if (!seen.has(path)) {
    seen.add(path);
    paths.push(path);
  }
  return true;
}

function parseNameOnlyOutput(value: string): string[] | undefined {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const line of value.split(/\r?\n/u).filter((item) => item.length > 0)) {
    if (!addPath(paths, seen, line)) return undefined;
  }
  return paths;
}

function parseStatusOutput(
  value: string,
): { trackedPaths: string[]; untrackedPaths: string[] } | undefined {
  const trackedPaths: string[] = [];
  const untrackedPaths: string[] = [];
  const tracked = new Set<string>();
  const untracked = new Set<string>();
  for (const line of value.split(/\r?\n/u).filter((item) => item.length > 0)) {
    if (line.length < 4 || line.startsWith('"')) return undefined;
    const status = line.slice(0, 2);
    const pathValue = line.slice(3);
    if (status === "??") {
      if (!addPath(untrackedPaths, untracked, pathValue)) return undefined;
      continue;
    }
    if (pathValue.includes(" -> ")) {
      const [oldPath, newPath] = pathValue.split(" -> ");
      if (
        oldPath === undefined ||
        newPath === undefined ||
        !addPath(trackedPaths, tracked, oldPath) ||
        !addPath(trackedPaths, tracked, newPath)
      ) {
        return undefined;
      }
      continue;
    }
    if (!addPath(trackedPaths, tracked, pathValue)) return undefined;
  }
  return { trackedPaths, untrackedPaths };
}

function commandEvidence(
  results: readonly GitOperationResult[],
): FinalDiffInspectionCommandEvidence[] {
  return results.map(({ operation, status, reason }) => ({
    operation,
    status,
    ...(reason === undefined ? {} : { reason }),
  }));
}

export async function inspectRepositoryDiff(
  exec: ExtensionAPI["exec"],
  cwd: string,
  signal?: AbortSignal,
): Promise<FinalDiffInspectionToolDetails> {
  const results: GitOperationResult[] = [];
  for (const operation of FINAL_DIFF_INSPECTION_GIT_OPERATIONS) {
    results.push(await runGitOperation(exec, operation, cwd, signal));
  }

  const statusResult = results[0];
  const namesResult = results[1];
  const statResult = results[2];
  const checkResult = results[3];
  const status =
    statusResult?.status === "PASS" &&
    namesResult?.status === "PASS" &&
    statResult?.status === "PASS" &&
    checkResult?.status === "PASS"
      ? "known"
      : "unknown";
  const parsedStatus =
    statusResult?.status === "PASS"
      ? parseStatusOutput(statusResult.stdout)
      : undefined;
  const diffPaths =
    namesResult?.status === "PASS"
      ? parseNameOnlyOutput(namesResult.stdout)
      : undefined;
  const evidenceValid = parsedStatus !== undefined && diffPaths !== undefined;
  const changedPaths: string[] = [];
  const changed = new Set<string>();
  if (evidenceValid) {
    for (const path of [
      ...parsedStatus.trackedPaths,
      ...parsedStatus.untrackedPaths,
      ...diffPaths,
    ]) {
      addPath(changedPaths, changed, path);
    }
  }
  const stat =
    statResult?.status === "PASS" &&
    utf8ByteLength(statResult.stdout) <= MAX_STAT_BYTES
      ? statResult.stdout.trim()
      : "";
  const evidenceStatus =
    evidenceValid && status === "known" ? "known" : "unknown";
  const evidence: FinalDiffInspectionToolEvidence = {
    status: evidenceStatus,
    changedPaths,
    trackedPaths: parsedStatus?.trackedPaths ?? [],
    untrackedPaths: parsedStatus?.untrackedPaths ?? [],
    stat,
    commands: commandEvidence(results),
  };
  return { evidence };
}

function validateCommandEvidence(
  value: unknown,
): ValidationResult<FinalDiffInspectionCommandEvidence[]> {
  if (
    !Array.isArray(value) ||
    value.length !== FINAL_DIFF_INSPECTION_GIT_OPERATIONS.length
  ) {
    return invalidResult("Git command evidence is incomplete");
  }
  const commands: FinalDiffInspectionCommandEvidence[] = [];
  for (const [index, item] of value.entries()) {
    const expected = FINAL_DIFF_INSPECTION_GIT_OPERATIONS[index];
    if (
      expected === undefined ||
      !isRecord(item) ||
      !hasOnlyKeys(item, ["operation", "status", "reason"]) ||
      item.operation !== expected.name ||
      (item.status !== "PASS" && item.status !== "UNKNOWN")
    ) {
      return invalidResult("Git command evidence is invalid");
    }
    let reason: string | undefined;
    if ("reason" in item) {
      if (!isBoundedString(item.reason, MAX_ITEM_BYTES, true)) {
        return invalidResult("Git command evidence is invalid");
      }
      reason = item.reason;
    }
    commands.push({
      operation: expected.name,
      status: item.status,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  return validResult(commands);
}

export function validateFinalDiffInspectionToolDetails(
  value: unknown,
): ValidationResult<FinalDiffInspectionToolDetails> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["evidence"]) ||
    !isRecord(value.evidence) ||
    !hasOnlyKeys(value.evidence, [
      "status",
      "changedPaths",
      "trackedPaths",
      "untrackedPaths",
      "stat",
      "commands",
    ])
  ) {
    return invalidResult("Final Diff Inspection tool result is invalid");
  }
  const changedPaths = validatePaths(
    value.evidence.changedPaths,
    "changedPaths",
  );
  const trackedPaths = validatePaths(
    value.evidence.trackedPaths,
    "trackedPaths",
  );
  const untrackedPaths = validatePaths(
    value.evidence.untrackedPaths,
    "untrackedPaths",
  );
  const commands = validateCommandEvidence(value.evidence.commands);
  if (
    (value.evidence.status !== "known" &&
      value.evidence.status !== "unknown") ||
    !isBoundedString(value.evidence.stat, MAX_STAT_BYTES) ||
    !changedPaths.valid ||
    !trackedPaths.valid ||
    !untrackedPaths.valid ||
    !commands.valid
  ) {
    return invalidResult(
      "Final Diff Inspection tool result is invalid",
      ...(!changedPaths.valid ? changedPaths.errors : []),
      ...(!trackedPaths.valid ? trackedPaths.errors : []),
      ...(!untrackedPaths.valid ? untrackedPaths.errors : []),
      ...(!commands.valid ? commands.errors : []),
    );
  }
  return validResult({
    evidence: {
      status: value.evidence.status,
      changedPaths: changedPaths.value,
      trackedPaths: trackedPaths.value,
      untrackedPaths: untrackedPaths.value,
      stat: value.evidence.stat,
      commands: commands.value,
    },
  });
}

function unknownInspectionResult(
  context: FinalDiffInspectionContext,
): FinalDiffInspectionResult {
  return evaluateFinalDiffInspection({
    ...context,
    changedPaths: [],
    workingTree: {
      status: "unknown",
      trackedPaths: [],
      untrackedPaths: [],
    },
  });
}

export function evaluateFinalDiffInspectionWithEvidence(
  context: FinalDiffInspectionContext,
  toolDetails: unknown,
): ValidationResult<FinalDiffInspectionResult> {
  const details = validateFinalDiffInspectionToolDetails(toolDetails);
  if (!details.valid) return validResult(unknownInspectionResult(context));
  const workingTree: WorkingTreeEvidence = {
    status: details.value.evidence.status,
    trackedPaths: details.value.evidence.trackedPaths,
    untrackedPaths: details.value.evidence.untrackedPaths,
  };
  const result = evaluateFinalDiffInspection({
    ...context,
    changedPaths: details.value.evidence.changedPaths,
    workingTree,
  });
  return validResult(result);
}

function createFinalDiffInspectionTool(
  exec: ExtensionAPI["exec"],
): ToolDefinition<
  typeof FINAL_DIFF_INSPECTION_TOOL_PARAMETERS,
  FinalDiffInspectionToolDetails
> {
  return {
    name: FINAL_DIFF_INSPECTION_TOOL_NAME,
    label: "Inspect Final Diff",
    description:
      "Capture bounded read-only repository evidence for Final Diff Inspection. This tool accepts no command or arguments.",
    parameters: FINAL_DIFF_INSPECTION_TOOL_PARAMETERS,
    async execute(
      _toolCallId,
      _params,
      signal,
      _onUpdate,
      ctx,
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: FinalDiffInspectionToolDetails;
    }> {
      const details = await inspectRepositoryDiff(exec, ctx.cwd, signal);
      return {
        content: [
          {
            type: "text",
            text: `Final Diff Inspection evidence captured: ${details.evidence.status}.`,
          },
        ],
        details,
      };
    },
  };
}

export function registerFinalDiffInspectionChildTool(
  pi: Pick<ExtensionAPI, "registerTool" | "exec">,
): void {
  pi.registerTool(createFinalDiffInspectionTool(pi.exec));
}

export default function finalDiffInspectionChildExtension(
  pi: Pick<ExtensionAPI, "registerTool" | "exec">,
): void {
  if (process.env.PI_SUBAGENT_CHILD !== "1") return;
  registerFinalDiffInspectionChildTool(pi);
}

export type FinalDiffInspectionToolInput = FinalDiffInspectionToolParameters;
