import type { UncertaintyId } from "../primitives/ids.js";

export const UNCERTAINTY_STATUSES = [
  "open",
  "resolving",
  "resolved",
  "accepted",
  "escalated",
] as const;
export type UncertaintyStatus = (typeof UNCERTAINTY_STATUSES)[number];

export const UNCERTAINTY_CATEGORIES = [
  "requirement",
  "behavior",
  "design",
  "external",
  "impact",
  "verification",
] as const;
export type UncertaintyCategory = (typeof UNCERTAINTY_CATEGORIES)[number];

export type Uncertainty = Readonly<{
  id: UncertaintyId;
  status: UncertaintyStatus;
  category: UncertaintyCategory;
}>;

export type UncertaintyInput = Readonly<{
  id: UncertaintyId;
  category: UncertaintyCategory;
  status?: UncertaintyStatus;
}>;

export class UncertaintyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UncertaintyValidationError";
  }
}

function isCanonical<T extends readonly string[]>(value: string, values: T): value is T[number] {
  return (values as readonly string[]).includes(value);
}

function canonical<T extends readonly string[]>(value: string, values: T, name: string): T[number] {
  if (!isCanonical(value, values)) {
    throw new UncertaintyValidationError(`Invalid ${name}: ${value}`);
  }
  return value;
}

export function createUncertainty(input: UncertaintyInput): Uncertainty {
  return {
    id: input.id,
    status: canonical(input.status ?? "open", UNCERTAINTY_STATUSES, "Uncertainty status"),
    category: canonical(input.category, UNCERTAINTY_CATEGORIES, "Uncertainty category"),
  };
}

export function canTransitionUncertainty(from: string, to: string): to is UncertaintyStatus {
  return isCanonical(from, UNCERTAINTY_STATUSES) && isCanonical(to, UNCERTAINTY_STATUSES);
}

export function transitionUncertainty(
  uncertainty: Uncertainty,
  to: UncertaintyStatus,
): Uncertainty {
  canonical(uncertainty.status, UNCERTAINTY_STATUSES, "Uncertainty status");
  const status = canonical(to, UNCERTAINTY_STATUSES, "Uncertainty status");
  return status === uncertainty.status ? uncertainty : { ...uncertainty, status };
}
