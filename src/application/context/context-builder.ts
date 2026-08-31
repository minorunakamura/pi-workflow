import type { JsonObject, JsonValue } from "../../contracts/execution/agent-execution.js";
import type { FreshnessStatus } from "../../domain/freshness/freshness.js";

export const CONTEXT_PRIORITIES = [
  "authoritative-state",
  "resolved-decisions",
  "current-plan",
  "current-evidence",
  "required-artifact",
  "supporting-evidence",
  "optional",
] as const;
export type ContextPriority = (typeof CONTEXT_PRIORITIES)[number];

export type ContextCandidate = Readonly<{
  ref: string;
  content: JsonValue;
  priority: ContextPriority;
  required?: boolean;
  freshness?: FreshnessStatus;
  superseded?: boolean;
  estimatedTokens?: number;
  artifactRef?: string;
}>;

export type ContextBuilderInput = Readonly<{
  candidates: readonly ContextCandidate[];
  budget: number;
  requirementRevision?: number;
  decisionRefs?: readonly string[];
  uncertaintyRefs?: readonly string[];
}>;

export type ContextBuildResult = Readonly<{
  pack: JsonObject;
  manifest: JsonObject;
  artifactRefs: readonly string[];
}>;

export type ContextBuilderErrorCode =
  | "INVALID_CONTEXT_INPUT"
  | "REQUIRED_CONTEXT_MISSING"
  | "CONTEXT_BUDGET_EXCEEDED";

export type ContextBuilderErrorDetails = Readonly<{
  budget: number;
  requiredRefs: readonly string[];
  requiredTokenSize: number;
  excludedRefs: readonly string[];
}>;

export class ContextBuilderError extends Error {
  constructor(
    readonly code: ContextBuilderErrorCode,
    readonly details: ContextBuilderErrorDetails,
  ) {
    super(`Context Builder failed: ${code}`);
    this.name = "ContextBuilderError";
  }
}

const REQUIRED_PRIORITIES = new Set<ContextPriority>([
  "authoritative-state",
  "resolved-decisions",
  "required-artifact",
]);

function assertNonEmpty(value: string): void {
  if (value.trim().length === 0) {
    throw new ContextBuilderError("INVALID_CONTEXT_INPUT", {
      budget: 0,
      requiredRefs: [],
      requiredTokenSize: 0,
      excludedRefs: [],
    });
  }
}

function assertNonNegativeSafeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ContextBuilderError("INVALID_CONTEXT_INPUT", {
      budget: value,
      requiredRefs: [],
      requiredTokenSize: 0,
      excludedRefs: [],
    });
  }
}

function estimateTokens(content: JsonValue): number {
  return Math.max(1, Math.ceil(JSON.stringify(content).length / 4));
}

function candidateTokens(candidate: ContextCandidate): number {
  if (candidate.estimatedTokens === undefined) {
    return estimateTokens(candidate.content);
  }
  assertNonNegativeSafeInteger(candidate.estimatedTokens);
  return candidate.estimatedTokens;
}

function isRequired(candidate: ContextCandidate): boolean {
  return candidate.required === true || REQUIRED_PRIORITIES.has(candidate.priority);
}

function isExcluded(candidate: ContextCandidate): boolean {
  return candidate.freshness === "stale" || candidate.superseded === true;
}

function contextError(
  code: ContextBuilderErrorCode,
  budget: number,
  requiredRefs: readonly string[],
  requiredTokenSize: number,
  excludedRefs: readonly string[] = [],
): ContextBuilderError {
  return new ContextBuilderError(code, {
    budget,
    requiredRefs,
    requiredTokenSize,
    excludedRefs,
  });
}

function uniqueRefs(refs: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    assertNonEmpty(ref);
    if (seen.has(ref)) {
      throw contextError("INVALID_CONTEXT_INPUT", 0, [], 0, [ref]);
    }
    seen.add(ref);
    result.push(ref);
  }
  return result;
}

export function buildContext(input: ContextBuilderInput): ContextBuildResult {
  assertNonNegativeSafeInteger(input.budget);
  if (
    input.requirementRevision !== undefined &&
    (!Number.isSafeInteger(input.requirementRevision) || input.requirementRevision < 1)
  ) {
    throw contextError("INVALID_CONTEXT_INPUT", input.budget, [], 0);
  }

  const seenRefs = new Set<string>();
  const candidates = input.candidates.map((candidate) => {
    assertNonEmpty(candidate.ref);
    if (seenRefs.has(candidate.ref)) {
      throw contextError("INVALID_CONTEXT_INPUT", input.budget, [], 0, [candidate.ref]);
    }
    seenRefs.add(candidate.ref);
    return {
      candidate,
      tokens: candidateTokens(candidate),
      required: isRequired(candidate),
    };
  });

  const ordered = CONTEXT_PRIORITIES.flatMap((priority) =>
    candidates.filter(({ candidate }) => candidate.priority === priority),
  );
  const unavailable = ordered.filter(
    ({ candidate, required }) => required && isExcluded(candidate),
  );
  if (unavailable.length > 0) {
    throw contextError(
      "REQUIRED_CONTEXT_MISSING",
      input.budget,
      unavailable.map(({ candidate }) => candidate.ref),
      unavailable.reduce((total, { tokens }) => total + tokens, 0),
      unavailable.map(({ candidate }) => candidate.ref),
    );
  }

  const available = ordered.filter(({ candidate }) => !isExcluded(candidate));
  const requiredEntries = available.filter(({ required }) => required);
  const requiredTokenSize = requiredEntries.reduce((total, { tokens }) => total + tokens, 0);
  const requiredRefs = requiredEntries.map(({ candidate }) => candidate.ref);
  if (requiredTokenSize > input.budget) {
    throw contextError("CONTEXT_BUDGET_EXCEEDED", input.budget, requiredRefs, requiredTokenSize);
  }

  const selected = new Set<string>(requiredRefs);
  let estimatedTokenSize = requiredTokenSize;
  for (const entry of available) {
    if (entry.required || estimatedTokenSize + entry.tokens > input.budget) {
      continue;
    }
    selected.add(entry.candidate.ref);
    estimatedTokenSize += entry.tokens;
  }

  const selectedEntries = available.filter(({ candidate }) => selected.has(candidate.ref));
  const pack: Record<string, JsonValue> = {};
  const artifactRefs: string[] = [];
  const seenArtifactRefs = new Set<string>();

  for (const { candidate } of selectedEntries) {
    pack[candidate.ref] = candidate.content;
    const artifactRef =
      candidate.artifactRef ??
      (candidate.priority === "required-artifact" ? candidate.ref : undefined);
    if (artifactRef !== undefined && !seenArtifactRefs.has(artifactRef)) {
      assertNonEmpty(artifactRef);
      seenArtifactRefs.add(artifactRef);
      artifactRefs.push(artifactRef);
    }
  }

  const manifest: JsonObject = {
    requirementRevision: input.requirementRevision ?? null,
    artifactRefs,
    decisionRefs: uniqueRefs(input.decisionRefs ?? []),
    uncertaintyRefs: uniqueRefs(input.uncertaintyRefs ?? []),
    inclusionMode: Object.fromEntries(
      selectedEntries.map(({ candidate }) => [candidate.ref, candidate.priority]),
    ),
    estimatedTokenSize,
  };

  return { pack, manifest, artifactRefs };
}
