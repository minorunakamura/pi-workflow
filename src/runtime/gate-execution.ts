import {
  TIMEOUTS,
  isValidArtifactRef,
  validateTrustedGate,
  type ArtifactRef,
  type TrustedGate,
  type TrustedGateStatus,
} from "../core/index.ts";
import {
  invalidResult,
  isBoundedString,
  isRecord,
  utf8ByteLength,
  validResult,
  type ValidationResult,
} from "../core/validation.ts";

export const MANAGED_GATE_AGENT = "scout" as const;
export const MANAGED_GATE_OUTPUT_PREFIX = "trusted-gate" as const;

export interface ManagedGateRunParams {
  readonly agent: typeof MANAGED_GATE_AGENT;
  readonly context: "fresh";
  readonly task: string;
  readonly gate: string;
  readonly timeoutMs: number;
  readonly output: string;
  readonly outputMode: "file-only";
  readonly artifacts: true;
  readonly worktree: false;
}

export type ManagedGateRunner = (
  key: string,
  params: ManagedGateRunParams,
) => Promise<unknown>;

const GATE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MAX_GATE_KEY_BYTES = 128;
const MAX_REASON_BYTES = 4096;

type VerificationStatus = "passed" | "failed" | "timed-out" | "allowed-failure";

interface VerificationRecord {
  command: string;
  status: VerificationStatus;
  evidenceStatus?: string;
  artifact?: ArtifactRef;
}

function isVerificationStatus(value: unknown): value is VerificationStatus {
  return (
    value === "passed" ||
    value === "failed" ||
    value === "timed-out" ||
    value === "allowed-failure"
  );
}

function outputPath(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.path === "string") return value.path;
  return undefined;
}

function artifactFromPath(value: unknown): ArtifactRef | undefined {
  const path = outputPath(value);
  if (path === undefined) return undefined;
  const candidate = {
    kind: "managed" as const,
    path,
    mediaType: "text/plain" as const,
  };
  return isValidArtifactRef(candidate) ? candidate : undefined;
}

function verificationRecords(value: unknown): VerificationRecord[] {
  if (!isRecord(value)) return [];
  const records: VerificationRecord[] = [];
  const addAcceptance = (candidate: unknown): void => {
    if (!isRecord(candidate) || !Array.isArray(candidate.verifyRuns)) return;
    for (const run of candidate.verifyRuns) {
      if (
        !isRecord(run) ||
        typeof run.command !== "string" ||
        !isVerificationStatus(run.status)
      ) {
        continue;
      }
      const artifact = artifactFromPath(run.artifactPath);
      records.push({
        command: run.command,
        status: run.status,
        ...(typeof candidate.evidenceStatus === "string"
          ? { evidenceStatus: candidate.evidenceStatus }
          : {}),
        ...(artifact === undefined ? {} : { artifact }),
      });
    }
  };

  addAcceptance(value.acceptance);
  const directResults = value.results;
  if (Array.isArray(directResults)) {
    for (const result of directResults) {
      if (!isRecord(result)) continue;
      addAcceptance(result.acceptance);
      addAcceptance(result.details);
    }
  }
  if (isRecord(value.details)) {
    addAcceptance(value.details.acceptance);
    const detailResults = value.details.results;
    if (Array.isArray(detailResults)) {
      for (const result of detailResults) {
        if (!isRecord(result)) continue;
        addAcceptance(result.acceptance);
        addAcceptance(result.details);
      }
    }
  }
  return records;
}

function boundedReason(value: string): string {
  let reason = value.trim();
  while (reason.length > 0 && utf8ByteLength(reason) > MAX_REASON_BYTES) {
    reason = reason.slice(0, -1);
  }
  return reason || "Managed Gate evidence is unavailable";
}

function withOutcome(
  gate: TrustedGate,
  status: TrustedGateStatus,
  reason?: string,
  evidence?: ArtifactRef,
): TrustedGate {
  const result: TrustedGate = { ...gate, status };
  delete result.evidence;
  delete result.reason;
  if (evidence !== undefined) result.evidence = evidence;
  if (reason !== undefined) result.reason = boundedReason(reason);
  return result;
}

function resultFailed(value: unknown): boolean {
  if (!isRecord(value)) return true;
  return (
    value.ok === false || value.success === false || value.isError === true
  );
}

export function createManagedGateRun(
  value: unknown,
  key: string,
): ValidationResult<ManagedGateRunParams> {
  const gate = validateTrustedGate(value);
  if (!gate.valid) return gate;
  if (
    !isBoundedString(key, MAX_GATE_KEY_BYTES, true) ||
    !GATE_KEY_PATTERN.test(key)
  ) {
    return invalidResult("Managed Gate key is invalid");
  }
  return validResult({
    agent: MANAGED_GATE_AGENT,
    context: "fresh",
    task:
      `Run the exact repository-declared Trusted Gate selected by the gate field for ${gate.value.name}. ` +
      "Do not split, expand, substitute, or infer commands. Runtime host evidence is authoritative; model prose is not evidence.",
    gate: gate.value.command,
    timeoutMs: TIMEOUTS.gateTimeoutMs,
    output: `${MANAGED_GATE_OUTPUT_PREFIX}-${key}.md`,
    outputMode: "file-only",
    artifacts: true,
    worktree: false,
  });
}

export function normalizeManagedGateResult(
  value: unknown,
  managedResult: unknown,
): ValidationResult<TrustedGate> {
  const gate = validateTrustedGate(value);
  if (!gate.valid) return gate;

  const verification = verificationRecords(managedResult).filter(
    (record) => record.command === gate.value.command,
  );
  if (verification.length !== 1) {
    return validResult(
      withOutcome(
        gate.value,
        "UNKNOWN",
        "Managed Gate did not return exactly one matching runtime verification.",
      ),
    );
  }

  const [record] = verification;
  if (record === undefined) {
    return validResult(
      withOutcome(
        gate.value,
        "UNKNOWN",
        "Managed Gate verification is missing.",
      ),
    );
  }
  if (record.status === "timed-out") {
    return validResult(
      withOutcome(
        gate.value,
        "UNKNOWN",
        "Managed Gate verification timed out.",
      ),
    );
  }

  const evidence = record.artifact;
  if (evidence === undefined) {
    return validResult(
      withOutcome(
        gate.value,
        "UNKNOWN",
        "Managed Gate verification has no saved evidence.",
      ),
    );
  }

  if (record.status === "passed") {
    if (
      record.evidenceStatus !== undefined &&
      record.evidenceStatus !== "verified"
    ) {
      return validResult(
        withOutcome(
          gate.value,
          "UNKNOWN",
          "Managed Gate acceptance evidence is not verified.",
        ),
      );
    }
    if (resultFailed(managedResult)) {
      return validResult(
        withOutcome(
          gate.value,
          "UNKNOWN",
          "Managed Gate runner failed despite a passed verification.",
        ),
      );
    }
    return validResult(withOutcome(gate.value, "PASS", undefined, evidence));
  }

  return validResult(
    withOutcome(
      gate.value,
      "FAIL",
      record.status === "allowed-failure"
        ? "Managed Gate completed with an allowed failure."
        : "Managed Gate command failed.",
      evidence,
    ),
  );
}

export async function executeTrustedGate(
  value: unknown,
  runner: ManagedGateRunner,
  key: string,
): Promise<ValidationResult<TrustedGate>> {
  const request = createManagedGateRun(value, key);
  if (!request.valid) return request;

  try {
    const managedResult = await runner(key, request.value);
    return normalizeManagedGateResult(value, managedResult);
  } catch (error) {
    return normalizeManagedGateResult(value, {
      ok: false,
      error: boundedReason(
        error instanceof Error ? error.message : "Managed Gate runner failed.",
      ),
    });
  }
}
