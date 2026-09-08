import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PHASE_NAMES, PhaseSchemas, type PhaseName } from "./inputs";
import {
  isJsonValue,
  jsonByteLength,
  schemaIssues,
  type ValidationIssue,
  type ValidationResult,
} from "../validation";

export const MAX_PHASE_PAYLOAD_BYTES = 64 * 1024;
const INPUT_PLACEHOLDER = "__PI_WORKFLOW_INPUT__";

export interface PreparedPhase {
  phase: PhaseName;
  workflowScript: string;
  sha256: string;
}

function isPhaseName(value: unknown): value is PhaseName {
  return (
    typeof value === "string" &&
    (PHASE_NAMES as readonly string[]).includes(value)
  );
}

export function validatePhaseInput(
  phase: unknown,
  payload: unknown,
): ValidationResult<unknown> {
  if (!isPhaseName(phase)) {
    return {
      ok: false,
      errors: [{ path: "/phase", message: "unknown phase" }],
    };
  }

  const errors: ValidationIssue[] = schemaIssues(PhaseSchemas[phase], payload);
  if (errors.length > 0) return { ok: false, errors };

  if (!isJsonValue(payload)) {
    return {
      ok: false,
      errors: [{ path: "/", message: "payload must contain JSON values only" }],
    };
  }

  if (jsonByteLength(payload) > MAX_PHASE_PAYLOAD_BYTES) {
    return {
      ok: false,
      errors: [
        {
          path: "/",
          message: `payload exceeds ${MAX_PHASE_PAYLOAD_BYTES} bytes`,
        },
      ],
    };
  }

  return { ok: true, value: payload, errors: [] };
}

function templateFor(phase: PhaseName): string {
  const path = fileURLToPath(
    new URL(`../../../workflow-scripts/${phase}.js`, import.meta.url),
  );
  return readFileSync(path, "utf8").replaceAll("\r\n", "\n");
}

export function renderPhase(phase: unknown, payload: unknown): PreparedPhase {
  const validation = validatePhaseInput(phase, payload);
  if (!validation.ok) {
    throw new Error(
      validation.errors
        .map((error) => `${error.path}: ${error.message}`)
        .join("; "),
    );
  }
  if (!isPhaseName(phase)) throw new Error("unknown phase");

  const template = templateFor(phase);
  const occurrences = template.split(INPUT_PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `phase template must contain exactly one ${INPUT_PLACEHOLDER} placeholder`,
    );
  }

  const workflowScript = template.replace(
    INPUT_PLACEHOLDER,
    JSON.stringify(validation.value),
  );
  const sha256 = createHash("sha256").update(workflowScript).digest("hex");

  return { phase, workflowScript, sha256 };
}
