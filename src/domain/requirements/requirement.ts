import type { RequirementElementId } from "../primitives/ids.js";

export const REQUIREMENT_CANDIDATE_OPERATIONS = ["add", "clarify"] as const;
export type RequirementCandidateOperation = (typeof REQUIREMENT_CANDIDATE_OPERATIONS)[number];

export const REQUIREMENT_CANDIDATE_EFFECTS = [
  "preserving",
  "narrowing",
  "broadening",
  "changing",
] as const;
export type RequirementCandidateEffect = (typeof REQUIREMENT_CANDIDATE_EFFECTS)[number];

export const REQUIREMENT_ELEMENT_KINDS = [
  "acceptanceCriteria",
  "constraints",
  "assumptions",
] as const;
export type RequirementElementKind = (typeof REQUIREMENT_ELEMENT_KINDS)[number];

export const REQUIREMENT_PLAN_IMPACTS = ["current", "compatible", "replan-required"] as const;
export type RequirementPlanImpact = (typeof REQUIREMENT_PLAN_IMPACTS)[number];

export type RequirementElement = Readonly<{
  id: RequirementElementId;
  supersedes?: RequirementElementId;
  [key: string]: unknown;
}>;

export type Requirement = Readonly<{
  revision: number;
  acceptanceCriteria: readonly RequirementElement[];
  constraints: readonly RequirementElement[];
  assumptions: readonly unknown[];
  [key: string]: unknown;
}>;

type RequirementElementInput = Readonly<{
  id: string;
  supersedes?: string;
  [key: string]: unknown;
}>;

export type RequirementInput = Readonly<{
  revision?: number;
  acceptanceCriteria?: readonly RequirementElementInput[];
  constraints?: readonly RequirementElementInput[];
  assumptions?: readonly unknown[];
  [key: string]: unknown;
}>;

export type RequirementCandidate = Readonly<{
  operation: RequirementCandidateOperation;
  effect: RequirementCandidateEffect;
  targetId?: string;
  targetIndex?: number;
  kind?: RequirementElementKind;
  [key: string]: unknown;
}>;

export type RequirementMutation = Readonly<{
  kind: RequirementElementKind;
  candidate: RequirementCandidate;
}>;

export type RequirementImpact = Readonly<{
  planImpact: RequirementPlanImpact;
  requiresReclassification: boolean;
  requiresReplan: boolean;
}>;

export type RequirementChange = Readonly<{
  kind: RequirementElementKind;
  operation: RequirementCandidateOperation;
  effect: RequirementCandidateEffect;
  resultingId?: RequirementElementId;
  supersededId?: RequirementElementId;
  preservedIdentity: boolean;
  impact: RequirementImpact;
}>;

export type RequirementRevision = Readonly<{
  requirement: Requirement;
  changes: readonly RequirementChange[];
  impact: RequirementImpact;
}>;

export class RequirementValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequirementValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical<T extends readonly string[]>(
  value: unknown,
  values: T,
  name: string,
): T[number] {
  const found = typeof value === "string" ? values.find((entry) => entry === value) : undefined;
  if (found === undefined) {
    throw new RequirementValidationError(`Invalid ${name}: ${String(value)}`);
  }
  return found;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RequirementValidationError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RequirementValidationError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function arrayValue(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new RequirementValidationError(`${name} must be an array`);
  }
  return value;
}

function optionalArray(value: unknown, name: string): readonly unknown[] {
  return value === undefined ? [] : arrayValue(value, name);
}

function id(value: unknown, prefix: "AC" | "C", name: string): string {
  if (typeof value !== "string" || !new RegExp(`^${prefix}-(\\d+)$`).test(value)) {
    throw new RequirementValidationError(`${name} must be a ${prefix}-<number> identity`);
  }
  positiveInteger(Number(value.slice(prefix.length + 1)), name);
  return value;
}

function anyElementId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^(?:AC|C)-(\d+)$/.test(value)) {
    throw new RequirementValidationError(`${name} must be an AC- or C-<number> identity`);
  }
  positiveInteger(Number(value.slice(value.indexOf("-") + 1)), name);
  return value;
}

function normalizeElements(value: unknown, prefix: "AC" | "C", name: string): RequirementElement[] {
  return arrayValue(value, name).map((entry, index) => {
    if (!isRecord(entry)) {
      throw new RequirementValidationError(`${name}[${index}] must be an object`);
    }
    const normalized: Record<string, unknown> = Object.assign({}, entry, {
      id: id(entry.id, prefix, `${name}[${index}].id`),
    });
    if ("supersedes" in entry) {
      normalized.supersedes = id(entry.supersedes, prefix, `${name}[${index}].supersedes`);
    }
    return normalized as RequirementElement;
  });
}

function assertUnique(elements: readonly RequirementElement[], name: string): void {
  const identities = new Set<string>();
  for (const element of elements) {
    if (identities.has(element.id)) {
      throw new RequirementValidationError(`${name} contains duplicate identity: ${element.id}`);
    }
    identities.add(element.id);
  }
}

export function createRequirement(input: RequirementInput): Requirement {
  if (!isRecord(input)) {
    throw new RequirementValidationError("Requirement must be an object");
  }
  const revision = input.revision === undefined ? 1 : input.revision;
  positiveInteger(revision, "revision");
  const acceptanceCriteria = normalizeElements(
    optionalArray(input.acceptanceCriteria, "acceptanceCriteria"),
    "AC",
    "acceptanceCriteria",
  );
  const constraints = normalizeElements(
    optionalArray(input.constraints, "constraints"),
    "C",
    "constraints",
  );
  assertUnique(acceptanceCriteria, "acceptanceCriteria");
  assertUnique(constraints, "constraints");
  const assumptions = optionalArray(input.assumptions, "assumptions");
  return { ...input, revision, acceptanceCriteria, constraints, assumptions };
}

export function validateRequirementCandidate(input: unknown): RequirementCandidate {
  if (!isRecord(input)) {
    throw new RequirementValidationError("Requirement candidate must be an object");
  }
  canonical(input.operation, REQUIREMENT_CANDIDATE_OPERATIONS, "Requirement candidate operation");
  canonical(input.effect, REQUIREMENT_CANDIDATE_EFFECTS, "Requirement candidate effect");
  if ("id" in input || "supersedes" in input) {
    throw new RequirementValidationError(
      "Requirement candidate must not contain an authoritative identity",
    );
  }
  if ("targetId" in input) {
    anyElementId(input.targetId, "targetId");
  }
  if ("targetIndex" in input) {
    nonNegativeInteger(input.targetIndex, "targetIndex");
  }
  if ("targetId" in input && "targetIndex" in input) {
    throw new RequirementValidationError(
      "Requirement candidate cannot contain targetId and targetIndex",
    );
  }
  if ("kind" in input) {
    canonical(input.kind, REQUIREMENT_ELEMENT_KINDS, "Requirement candidate kind");
  }
  return input as RequirementCandidate;
}

function candidatePayload(candidate: RequirementCandidate): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (!["operation", "effect", "targetId", "targetIndex", "kind"].includes(key)) {
      payload[key] = value;
    }
  }
  return payload;
}

function nextId(elements: readonly RequirementElement[], prefix: "AC" | "C"): RequirementElementId {
  let maximum = 0;
  for (const element of elements) {
    for (const value of [element.id, element.supersedes]) {
      if (value === undefined) {
        continue;
      }
      const number = Number(value.slice(prefix.length + 1));
      if (!value.startsWith(`${prefix}-`) || !Number.isSafeInteger(number)) {
        throw new RequirementValidationError(`Invalid ${prefix} identity: ${value}`);
      }
      maximum = Math.max(maximum, number);
    }
  }
  if (maximum === Number.MAX_SAFE_INTEGER) {
    throw new RequirementValidationError(`${prefix} identity sequence exhausted`);
  }
  return `${prefix}-${String(maximum + 1).padStart(3, "0")}` as RequirementElementId;
}

type ElementChange = Readonly<{
  elements: readonly RequirementElement[];
  resultingId: RequirementElementId;
  supersededId?: RequirementElementId;
  preservedIdentity: boolean;
}>;

function applyElementCandidate(
  elements: readonly RequirementElement[],
  candidate: RequirementCandidate,
  kind: Exclude<RequirementElementKind, "assumptions">,
  prefix: "AC" | "C",
): ElementChange {
  if (candidate.operation === "add") {
    if (candidate.targetId !== undefined || candidate.targetIndex !== undefined) {
      throw new RequirementValidationError("An add candidate must not target an existing element");
    }
    const result = {
      ...candidatePayload(candidate),
      id: nextId(elements, prefix),
    } as RequirementElement;
    return { elements: [...elements, result], resultingId: result.id, preservedIdentity: false };
  }

  if (candidate.targetId === undefined) {
    throw new RequirementValidationError("A clarify candidate requires targetId");
  }
  if (!candidate.targetId.startsWith(`${prefix}-`)) {
    throw new RequirementValidationError(`${kind} candidate targetId must use ${prefix}- identity`);
  }
  const index = elements.findIndex((element) => element.id === candidate.targetId);
  if (index < 0) {
    throw new RequirementValidationError(`Unknown ${kind} targetId: ${candidate.targetId}`);
  }

  const current = elements[index]!;
  const payload = candidatePayload(candidate);
  if (candidate.effect !== "changing") {
    if (Object.keys(payload).length === 0) {
      return { elements, resultingId: current.id, preservedIdentity: true };
    }
    const next = [...elements];
    next[index] = { ...current, ...payload, id: current.id };
    return { elements: next, resultingId: current.id, preservedIdentity: true };
  }

  const replacement = {
    ...current,
    ...payload,
    id: nextId(elements, prefix),
    supersedes: current.id,
  } as RequirementElement;
  const next = [...elements];
  next[index] = replacement;
  return {
    elements: next,
    resultingId: replacement.id,
    supersededId: current.id,
    preservedIdentity: false,
  };
}

function assumptionValue(candidate: RequirementCandidate): unknown {
  if ("value" in candidate) {
    return candidate.value;
  }
  const payload = candidatePayload(candidate);
  return Object.keys(payload).length === 0 ? undefined : payload;
}

function applyAssumptionCandidate(
  assumptions: readonly unknown[],
  candidate: RequirementCandidate,
): { assumptions: readonly unknown[]; preservedIdentity: boolean } {
  if (candidate.operation === "add") {
    if (candidate.targetId !== undefined || candidate.targetIndex !== undefined) {
      throw new RequirementValidationError(
        "An add candidate must not target an existing assumption",
      );
    }
    return { assumptions: [...assumptions, assumptionValue(candidate)], preservedIdentity: false };
  }
  if (candidate.targetId !== undefined || candidate.targetIndex === undefined) {
    throw new RequirementValidationError("An assumption clarify candidate requires targetIndex");
  }
  if (candidate.targetIndex >= assumptions.length) {
    throw new RequirementValidationError(
      "An assumption clarify candidate requires a valid targetIndex",
    );
  }
  const payload = candidatePayload(candidate);
  if (Object.keys(payload).length === 0) {
    return { assumptions, preservedIdentity: true };
  }
  const next = [...assumptions];
  next[candidate.targetIndex] = assumptionValue(candidate);
  return { assumptions: next, preservedIdentity: true };
}

function impact(effect: RequirementCandidateEffect): RequirementImpact {
  if (effect === "preserving") {
    return { planImpact: "current", requiresReclassification: false, requiresReplan: false };
  }
  if (effect === "narrowing") {
    return { planImpact: "compatible", requiresReclassification: true, requiresReplan: false };
  }
  return { planImpact: "replan-required", requiresReclassification: true, requiresReplan: true };
}

function mergeImpact(left: RequirementImpact, right: RequirementImpact): RequirementImpact {
  const rank = { current: 0, compatible: 1, "replan-required": 2 } as const;
  return {
    planImpact:
      rank[left.planImpact] >= rank[right.planImpact] ? left.planImpact : right.planImpact,
    requiresReclassification: left.requiresReclassification || right.requiresReclassification,
    requiresReplan: left.requiresReplan || right.requiresReplan,
  };
}

export function classifyRequirementImpact(
  input: RequirementCandidate | RequirementCandidateEffect,
): RequirementImpact {
  const effect =
    typeof input === "string"
      ? canonical(input, REQUIREMENT_CANDIDATE_EFFECTS, "Requirement candidate effect")
      : validateRequirementCandidate(input).effect;
  return impact(effect);
}

function normalizeMutation(input: RequirementMutation): RequirementMutation {
  if (!isRecord(input)) {
    throw new RequirementValidationError("Requirement mutation must be an object");
  }
  const kind = canonical(input.kind, REQUIREMENT_ELEMENT_KINDS, "Requirement mutation kind");
  const candidate = validateRequirementCandidate(input.candidate);
  if (candidate.kind !== undefined && candidate.kind !== kind) {
    throw new RequirementValidationError(
      "Requirement candidate kind does not match its mutation kind",
    );
  }
  return { kind, candidate };
}

export function reviseRequirement(
  requirement: Requirement,
  input: RequirementMutation | readonly RequirementMutation[],
): RequirementRevision {
  const current = createRequirement(requirement);
  const mutations = (Array.isArray(input) ? input : [input]).map(normalizeMutation);
  if (mutations.length === 0) {
    return {
      requirement: current,
      changes: [],
      impact: { planImpact: "current", requiresReclassification: false, requiresReplan: false },
    };
  }

  let acceptanceCriteria = [...current.acceptanceCriteria];
  let constraints = [...current.constraints];
  let assumptions = [...current.assumptions];
  const changes: RequirementChange[] = [];
  let overallImpact: RequirementImpact = {
    planImpact: "current",
    requiresReclassification: false,
    requiresReplan: false,
  };

  for (const mutation of mutations) {
    const candidate = mutation.candidate;
    const candidateImpact = classifyRequirementImpact(candidate);
    overallImpact = mergeImpact(overallImpact, candidateImpact);
    if (mutation.kind === "assumptions") {
      const result = applyAssumptionCandidate(assumptions, candidate);
      assumptions = [...result.assumptions];
      changes.push({
        kind: mutation.kind,
        operation: candidate.operation,
        effect: candidate.effect,
        preservedIdentity: result.preservedIdentity,
        impact: candidateImpact,
      });
      continue;
    }

    const result =
      mutation.kind === "acceptanceCriteria"
        ? applyElementCandidate(acceptanceCriteria, candidate, mutation.kind, "AC")
        : applyElementCandidate(constraints, candidate, mutation.kind, "C");
    if (mutation.kind === "acceptanceCriteria") {
      acceptanceCriteria = [...result.elements];
    } else {
      constraints = [...result.elements];
    }
    changes.push({
      kind: mutation.kind,
      operation: candidate.operation,
      effect: candidate.effect,
      resultingId: result.resultingId,
      ...(result.supersededId === undefined ? {} : { supersededId: result.supersededId }),
      preservedIdentity: result.preservedIdentity,
      impact: candidateImpact,
    });
  }

  if (current.revision === Number.MAX_SAFE_INTEGER) {
    throw new RequirementValidationError("Requirement revision sequence exhausted");
  }
  return {
    requirement: {
      ...current,
      revision: current.revision + 1,
      acceptanceCriteria,
      constraints,
      assumptions,
    },
    changes,
    impact: overallImpact,
  };
}

export function applyRequirementCandidate(
  requirement: Requirement,
  mutation: RequirementMutation,
): Requirement;
export function applyRequirementCandidate(
  requirement: Requirement,
  kind: RequirementElementKind,
  candidate: RequirementCandidate,
): Requirement;
export function applyRequirementCandidate(
  requirement: Requirement,
  mutationOrKind: RequirementMutation | RequirementElementKind,
  candidate?: RequirementCandidate,
): Requirement {
  if (typeof mutationOrKind === "string") {
    if (candidate === undefined) {
      throw new RequirementValidationError("A candidate is required");
    }
    return reviseRequirement(requirement, { kind: mutationOrKind, candidate }).requirement;
  }
  return reviseRequirement(requirement, mutationOrKind).requirement;
}

export const classifyPlanImpact = classifyRequirementImpact;
