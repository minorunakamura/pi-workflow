import type { ValidationIssue, ValidationResult } from "../validation";

export const FOREGROUND_ASYNC = false as const;

export const FOREGROUND_POLICY = {
  main: { async: FOREGROUND_ASYNC },
  runsRun: { async: FOREGROUND_ASYNC },
  runsAll: { async: FOREGROUND_ASYNC },
  runsLanes: { async: FOREGROUND_ASYNC },
} as const;

export type ForegroundPolicy = typeof FOREGROUND_POLICY;

export type StructuredOutputClass = "large-artifact" | "bounded-compact";
export type StructuredOutputMode = "file-only" | "inline";

export interface StructuredOutputRequest {
  readonly dataClass: StructuredOutputClass;
  readonly outputMode: StructuredOutputMode;
  readonly hasOutputSchema: boolean;
}

export interface LargeArtifactOutputPolicy {
  readonly dataClass: "large-artifact";
  readonly outputMode: "file-only";
  readonly outputSchema: "forbidden";
  readonly mainDetails: "artifact-reference-only";
}

export interface BoundedCompactOutputPolicy {
  readonly dataClass: "bounded-compact";
  readonly outputMode: StructuredOutputMode;
  readonly outputSchema: "allowed";
  readonly mainDetails: "structured-output-visible";
}

export const LARGE_ARTIFACT_OUTPUT_POLICY: LargeArtifactOutputPolicy = {
  dataClass: "large-artifact",
  outputMode: "file-only",
  outputSchema: "forbidden",
  mainDetails: "artifact-reference-only",
};

export const BOUNDED_COMPACT_OUTPUT_POLICY: BoundedCompactOutputPolicy = {
  dataClass: "bounded-compact",
  outputMode: "file-only",
  outputSchema: "allowed",
  mainDetails: "structured-output-visible",
};

export const S2_STRUCTURED_OUTPUT_POLICY = {
  fileOnlyWithSchema: "structured-output-visible",
} as const;

export const WORKFLOW_RESOURCE_OUTPUT_POLICIES = {
  discovery: {
    artifact: LARGE_ARTIFACT_OUTPUT_POLICY,
    metadata: BOUNDED_COMPACT_OUTPUT_POLICY,
  },
  research: {
    artifact: LARGE_ARTIFACT_OUTPUT_POLICY,
    metadata: BOUNDED_COMPACT_OUTPUT_POLICY,
  },
  planning: {
    artifact: LARGE_ARTIFACT_OUTPUT_POLICY,
    decision: BOUNDED_COMPACT_OUTPUT_POLICY,
    planReview: BOUNDED_COMPACT_OUTPUT_POLICY,
  },
  implementation: {
    result: LARGE_ARTIFACT_OUTPUT_POLICY,
  },
  verification: {
    evidence: LARGE_ARTIFACT_OUTPUT_POLICY,
    status: BOUNDED_COMPACT_OUTPUT_POLICY,
  },
  "verification-fix": {
    result: LARGE_ARTIFACT_OUTPUT_POLICY,
  },
  review: {
    findings: LARGE_ARTIFACT_OUTPUT_POLICY,
    decision: BOUNDED_COMPACT_OUTPUT_POLICY,
  },
} as const;

function isStructuredOutputRequest(
  value: unknown,
): value is StructuredOutputRequest {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("dataClass" in value) ||
    !("outputMode" in value) ||
    !("hasOutputSchema" in value)
  )
    return false;

  return (
    (value.dataClass === "large-artifact" ||
      value.dataClass === "bounded-compact") &&
    (value.outputMode === "file-only" || value.outputMode === "inline") &&
    typeof value.hasOutputSchema === "boolean"
  );
}

export function validateStructuredOutputPolicy(
  request: StructuredOutputRequest,
): ValidationResult<StructuredOutputRequest>;
export function validateStructuredOutputPolicy(
  dataClass: StructuredOutputClass,
  hasOutputSchema: boolean,
  outputMode?: StructuredOutputMode,
): ValidationResult<StructuredOutputRequest>;
export function validateStructuredOutputPolicy(
  requestOrClass: StructuredOutputRequest | StructuredOutputClass,
  hasOutputSchema?: boolean,
  outputMode: StructuredOutputMode = "file-only",
): ValidationResult<StructuredOutputRequest> {
  const candidate: unknown =
    typeof requestOrClass === "string"
      ? {
          dataClass: requestOrClass,
          outputMode,
          hasOutputSchema: hasOutputSchema ?? false,
        }
      : requestOrClass;
  if (!isStructuredOutputRequest(candidate)) {
    const error: ValidationIssue = {
      path: "/",
      message: "invalid structured-output policy request",
    };
    return { ok: false, errors: [error] };
  }
  const request = candidate;

  if (request.dataClass === "large-artifact") {
    if (request.outputMode !== "file-only") {
      return {
        ok: false,
        errors: [
          {
            path: "/outputMode",
            message: "large Artifact output must use file-only mode",
          },
        ],
      };
    }
    if (request.hasOutputSchema) {
      return {
        ok: false,
        errors: [
          {
            path: "/hasOutputSchema",
            message: "large Artifact output cannot use outputSchema",
          },
        ],
      };
    }
  }

  return { ok: true, value: request, errors: [] };
}

export function isStructuredOutputSchemaAllowed(
  dataClass: StructuredOutputClass,
): boolean {
  return dataClass === "bounded-compact";
}

export type ForegroundWorkflowInvocation<Args> = {
  readonly workflow: string;
  readonly args: Args;
  readonly missionId: string;
  readonly cwd?: string;
  readonly async: typeof FOREGROUND_ASYNC;
};

export function buildForegroundWorkflowInvocation<Args>(
  input: Omit<ForegroundWorkflowInvocation<Args>, "async">,
): ForegroundWorkflowInvocation<Args> {
  return { ...input, async: FOREGROUND_ASYNC };
}
