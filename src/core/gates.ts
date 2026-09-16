import {
  hasOnlyKeys,
  invalidResult,
  isBoundedString,
  isRecord,
  validResult,
  type ValidationResult,
} from "./validation.ts";
import { isValidArtifactRef, type ArtifactRef } from "./workflow.ts";

export type TrustedGateStatus = "PASS" | "FAIL" | "SKIPPED" | "UNKNOWN";
export type GateRequirement = "required" | "optional";
export type TrustedGateSource =
  | "package-script"
  | "build-target"
  | "ci-config"
  | "repository-doc";

export interface TrustedGate {
  name: string;
  command: string;
  requirement: GateRequirement;
  status: TrustedGateStatus;
  evidence?: ArtifactRef;
  reason?: string;
  source: TrustedGateSource;
}

export interface GateBlocker {
  code: string;
  reason: string;
  gateName?: string;
}

export interface TrustedGateEvaluation {
  valid: boolean;
  passed: boolean;
  blockers: readonly GateBlocker[];
}

const GATE_KEYS = [
  "name",
  "command",
  "requirement",
  "status",
  "evidence",
  "reason",
  "source",
] as const;

const GATE_SOURCES: readonly TrustedGateSource[] = [
  "package-script",
  "build-target",
  "ci-config",
  "repository-doc",
];

function isGateRequirement(value: unknown): value is GateRequirement {
  return value === "required" || value === "optional";
}

function isTrustedGateStatus(value: unknown): value is TrustedGateStatus {
  return (
    value === "PASS" ||
    value === "FAIL" ||
    value === "SKIPPED" ||
    value === "UNKNOWN"
  );
}

function isTrustedGateSource(value: unknown): value is TrustedGateSource {
  return GATE_SOURCES.some((source) => source === value);
}

export function validateTrustedGate(
  value: unknown,
): ValidationResult<TrustedGate> {
  if (!isRecord(value) || !hasOnlyKeys(value, GATE_KEYS)) {
    return invalidResult("Trusted Gate has unknown or missing fields");
  }
  const name = value.name;
  const command = value.command;
  const requirement = value.requirement;
  const status = value.status;
  const source = value.source;
  if (
    !isBoundedString(name, 4096, true) ||
    !isBoundedString(command, 4096, true) ||
    !isGateRequirement(requirement) ||
    !isTrustedGateStatus(status) ||
    !isTrustedGateSource(source)
  ) {
    return invalidResult("Trusted Gate contains an invalid value");
  }

  const gate: TrustedGate = { name, command, requirement, status, source };
  if ("evidence" in value) {
    if (!isValidArtifactRef(value.evidence)) {
      return invalidResult("Trusted Gate contains an invalid value");
    }
    gate.evidence = value.evidence;
  }
  if ("reason" in value) {
    if (!isBoundedString(value.reason, 4096)) {
      return invalidResult("Trusted Gate contains an invalid value");
    }
    if (
      (status === "SKIPPED" || status === "UNKNOWN") &&
      value.reason.trim().length === 0
    ) {
      return invalidResult("Skipped or unknown Gate requires a reason");
    }
    gate.reason = value.reason;
  } else if (status === "SKIPPED" || status === "UNKNOWN") {
    return invalidResult("Skipped or unknown Gate requires a reason");
  }
  return validResult(gate);
}

function gateIdentity(gate: Pick<TrustedGate, "name" | "command">): string {
  return `${gate.name}\u0000${gate.command}`;
}

function sameGateSemantics(left: TrustedGate, right: TrustedGate): boolean {
  return (
    left.name === right.name &&
    left.command === right.command &&
    left.status === right.status &&
    left.source === right.source &&
    left.reason === right.reason &&
    left.evidence?.kind === right.evidence?.kind &&
    left.evidence?.path === right.evidence?.path &&
    left.evidence?.mediaType === right.evidence?.mediaType
  );
}

function findGate(
  gates: readonly TrustedGate[],
  key: string,
): TrustedGate | undefined {
  return gates.find((gate) => gate.name === key || gateIdentity(gate) === key);
}

export function evaluateTrustedGates(
  gates: readonly TrustedGate[],
  requiredGateKeys: readonly string[] = [],
): TrustedGateEvaluation {
  if (!Array.isArray(gates) || !Array.isArray(requiredGateKeys)) {
    return {
      valid: false,
      passed: false,
      blockers: [
        { code: "INVALID_GATE_INPUT", reason: "Gate input must be arrays" },
      ],
    };
  }

  const blockers: GateBlocker[] = [];
  const validGates: TrustedGate[] = [];
  const identities = new Set<string>();
  let valid = true;
  for (const value of gates) {
    const gate = validateTrustedGate(value);
    if (!gate.valid) {
      valid = false;
      blockers.push({ code: "INVALID_GATE", reason: gate.errors.join(", ") });
      continue;
    }
    const identity = gateIdentity(gate.value);
    if (identities.has(identity)) {
      valid = false;
      blockers.push({
        code: "DUPLICATE_GATE",
        reason: `Duplicate Gate: ${gate.value.name}`,
        gateName: gate.value.name,
      });
      continue;
    }
    identities.add(identity);
    validGates.push(gate.value);
    if (gate.value.requirement === "required" && gate.value.status !== "PASS") {
      blockers.push({
        code: `REQUIRED_GATE_${gate.value.status}`,
        reason: `Required Gate ${gate.value.name} is ${gate.value.status}`,
        gateName: gate.value.name,
      });
    }
  }

  for (const key of requiredGateKeys) {
    const matching = findGate(validGates, key);
    if (
      !isBoundedString(key, 4096, true) ||
      matching === undefined ||
      matching.requirement !== "required"
    ) {
      valid = false;
      blockers.push({
        code: "MISSING_REQUIRED_GATE",
        reason: `Required Gate is missing or optional: ${key}`,
      });
    }
  }

  return { valid, passed: valid && blockers.length === 0, blockers };
}

export function validateRequiredGatesPreserved(
  approvedGates: readonly TrustedGate[],
  finalGates: readonly TrustedGate[],
): ValidationResult<true> {
  const approved = evaluateTrustedGates(approvedGates);
  const final = evaluateTrustedGates(finalGates);
  if (!approved.valid || !final.valid) {
    return invalidResult("Cannot compare invalid Gate sets");
  }
  for (const approvedGate of approvedGates) {
    if (approvedGate.requirement !== "required") {
      continue;
    }
    const matching = finalGates.find(
      (gate) => gateIdentity(gate) === gateIdentity(approvedGate),
    );
    if (matching === undefined || matching.requirement !== "required") {
      return invalidResult(
        `Approved required Gate was removed or downgraded: ${approvedGate.name}`,
      );
    }
  }
  return validResult(true);
}

export function validateRequiredGateResolution(
  approvedGates: readonly TrustedGate[],
  repositoryGates: readonly TrustedGate[],
): ValidationResult<true> {
  const approved = evaluateTrustedGates(approvedGates);
  const repository = evaluateTrustedGates(repositoryGates);
  if (!approved.valid || !repository.valid) {
    return invalidResult("Cannot resolve invalid Gate sets");
  }
  for (const approvedGate of approvedGates) {
    if (approvedGate.requirement !== "required") {
      continue;
    }
    const matching = repositoryGates.find(
      (gate) => gateIdentity(gate) === gateIdentity(approvedGate),
    );
    if (
      matching === undefined ||
      matching.requirement !== "required" ||
      matching.source !== approvedGate.source
    ) {
      return invalidResult(
        `Required Gate drift detected: ${approvedGate.name}`,
      );
    }
  }
  return validResult(true);
}

export function buildFinalGateSet(
  approvedGates: readonly TrustedGate[],
  mechanicallyRequiredGates: readonly TrustedGate[] = [],
): ValidationResult<TrustedGate[]> {
  const approved = evaluateTrustedGates(approvedGates);
  const additions = evaluateTrustedGates(mechanicallyRequiredGates);
  if (!approved.valid || !additions.valid) {
    return invalidResult("Cannot build a Gate set from invalid input");
  }
  if (
    mechanicallyRequiredGates.some((gate) => gate.requirement !== "required")
  ) {
    return invalidResult("Only mechanically required Gates may be added");
  }

  const finalGates = [...approvedGates];
  for (const gate of mechanicallyRequiredGates) {
    const existingIndex = finalGates.findIndex(
      (candidate) => gateIdentity(candidate) === gateIdentity(gate),
    );
    if (existingIndex === -1) {
      finalGates.push(gate);
      continue;
    }
    const existingGate = finalGates[existingIndex];
    if (existingGate === undefined || !sameGateSemantics(existingGate, gate)) {
      return invalidResult(`Conflicting Gate record: ${gate.name}`);
    }
    if (existingGate.requirement === "optional") {
      finalGates[existingIndex] = {
        ...existingGate,
        requirement: "required",
      };
    }
  }
  const preserved = validateRequiredGatesPreserved(approvedGates, finalGates);
  return preserved.valid ? validResult(finalGates) : preserved;
}
