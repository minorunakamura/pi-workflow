import {
  ContractValidationError,
  type JsonObject,
  type RuntimeSchema,
  type SafeParseResult,
} from "../execution/agent-execution.js";
import type { RunId } from "../../domain/primitives/ids.js";

export const CANONICAL_EVENT_TYPES = [
  "run.created",
  "run.started",
  "run.blocked",
  "run.unblocked",
  "run.failed",
  "run.resumed",
  "run.cancel-requested",
  "run.cancelled",
  "run.completed",
  "request.received",
  "request.amended",
  "requirement.created",
  "requirement.revised",
  "playbook.selected",
  "playbook.switched",
  "graph.step-added",
  "step.started",
  "step.blocked",
  "step.completed",
  "step.failed",
  "step.skipped",
  "execution.started",
  "execution.completed",
  "execution.blocked",
  "execution.failed",
  "execution.interrupted",
  "model.resolved",
  "model.fallback",
  "skill.used",
  "skill.requested",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "artifact.finalized",
  "uncertainty.created",
  "uncertainty.resolving",
  "uncertainty.resolved",
  "uncertainty.accepted",
  "uncertainty.escalated",
  "decision.created",
  "decision.resolved",
  "decision.superseded",
  "gate.created",
  "gate.passed",
  "gate.failed",
  "gate.superseded",
  "plan.created",
  "plan.applicability-changed",
  "change-set.created",
  "change-set.relevance-changed",
  "verification.completed",
  "verification.invalidated",
  "review.completed",
  "review.invalidated",
  "finding.created",
  "finding.disposition-changed",
  "finding.severity-changed",
  "finding.reopened",
  "repository.drift.detected",
  "repository.drift.reconciled",
  "error.occurred",
  "error.recovered",
  "error.escalated",
] as const;

export const EVENT_TYPES = CANONICAL_EVENT_TYPES;
export type EventType = (typeof CANONICAL_EVENT_TYPES)[number];
export type CanonicalEventType = EventType;

declare const eventIdBrand: unique symbol;
export type EventId = string & {
  readonly [eventIdBrand]: "EventId";
};

export type EventSourceV1 = JsonObject &
  Readonly<{
    component: string;
  }>;

export type EventActorV1 = JsonObject &
  Readonly<{
    type: string;
    id?: string;
  }>;

export type EventCauseV1 = JsonObject &
  Readonly<{
    event_id: EventId;
  }>;

export type EventDataV1 = JsonObject;

export type EventEnvelopeV1 = JsonObject &
  Readonly<{
    schema_version: 1;
    event_id: EventId;
    sequence: number;
    type: EventType;
    timestamp: string;
    run_id: RunId;
    source: EventSourceV1;
    actor?: EventActorV1;
    state_revision: number;
    correlation_id?: string;
    caused_by?: EventCauseV1;
    data: EventDataV1;
  }>;

export type EventDataByType = {
  [Type in EventType]: EventDataV1;
};

export type EventOfType<Type extends EventType> = EventEnvelopeV1 &
  Readonly<{
    type: Type;
    data: EventDataByType[Type];
  }>;

export type DomainEvent = {
  [Type in EventType]: EventOfType<Type>;
}[EventType];

const CONTRACT = "EventEnvelopeV1";
const OFFSET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(path: string, expected: string): never {
  throw new ContractValidationError(CONTRACT, { path, expected });
}

function stringValue(input: unknown, path: string): string {
  if (typeof input !== "string") {
    fail(path, "a string");
  }
  return input;
}

function nonEmptyString(input: unknown, path: string): string {
  const value = stringValue(input, path);
  if (value.trim().length === 0) {
    fail(path, "a non-empty string");
  }
  return value;
}

function record(input: unknown, path: string): Record<string, unknown> {
  if (!isRecord(input)) {
    fail(path, "an object");
  }
  return input;
}

function jsonValue(input: unknown, path: string): void {
  if (input === null || typeof input === "string" || typeof input === "boolean") {
    return;
  }
  if (typeof input === "number" && Number.isFinite(input)) {
    return;
  }
  if (Array.isArray(input)) {
    input.forEach((entry, index) => jsonValue(entry, `${path}[${index}]`));
    return;
  }
  if (isRecord(input)) {
    Object.entries(input).forEach(([key, value]) => jsonValue(value, `${path}.${key}`));
    return;
  }
  fail(path, "a JSON value");
}

function jsonObject(input: unknown, path: string): JsonObject {
  const value = record(input, path);
  Object.entries(value).forEach(([key, entry]) => jsonValue(entry, `${path}.${key}`));
  return value as JsonObject;
}

function safeIntegerAtLeast(input: unknown, path: string, minimum: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum) {
    fail(path, `a safe integer greater than or equal to ${minimum}`);
  }
  return input;
}

function enumValue(input: unknown, path: string): EventType {
  const value = stringValue(input, path);
  if (!(CANONICAL_EVENT_TYPES as readonly string[]).includes(value)) {
    fail(path, `one of ${CANONICAL_EVENT_TYPES.join(", ")}`);
  }
  return value as EventType;
}

function eventId(input: unknown, path: string): EventId {
  const value = nonEmptyString(input, path);
  if (!/^evt-\d+$/.test(value)) {
    fail(path, "evt-<number> identity");
  }
  return value as EventId;
}

function timestamp(input: unknown, path: string): string {
  const value = nonEmptyString(input, path);
  if (!OFFSET_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    fail(path, "an ISO 8601 timestamp with a timezone offset");
  }
  return value;
}

function source(input: unknown): EventSourceV1 {
  const value = jsonObject(input, "source");
  nonEmptyString(value.component, "source.component");
  return value as EventSourceV1;
}

function actor(input: unknown): EventActorV1 {
  const value = jsonObject(input, "actor");
  nonEmptyString(value.type, "actor.type");
  if ("id" in value) {
    nonEmptyString(value.id, "actor.id");
  }
  return value as EventActorV1;
}

function cause(input: unknown): EventCauseV1 {
  const value = jsonObject(input, "caused_by");
  eventId(value.event_id, "caused_by.event_id");
  return value as EventCauseV1;
}

export function parseEventEnvelopeV1(input: unknown): EventEnvelopeV1 {
  const root = jsonObject(input, "");
  if (root.schema_version !== 1) {
    fail("schema_version", "schema version 1");
  }
  eventId(root.event_id, "event_id");
  safeIntegerAtLeast(root.sequence, "sequence", 0);
  enumValue(root.type, "type");
  timestamp(root.timestamp, "timestamp");
  const runId = nonEmptyString(root.run_id, "run_id");
  if (!/^run-\d+$/.test(runId)) {
    fail("run_id", "run-<number> identity");
  }
  source(root.source);
  if ("actor" in root) {
    actor(root.actor);
  }
  safeIntegerAtLeast(root.state_revision, "state_revision", 0);
  if ("correlation_id" in root) {
    nonEmptyString(root.correlation_id, "correlation_id");
  }
  if ("caused_by" in root) {
    cause(root.caused_by);
  }
  jsonObject(root.data, "data");
  return input as EventEnvelopeV1;
}

export function parseDomainEvent(input: unknown): DomainEvent {
  return parseEventEnvelopeV1(input) as DomainEvent;
}

function createRuntimeSchema<T>(parser: (input: unknown) => T): RuntimeSchema<T> {
  return {
    parse: parser,
    safeParse(input: unknown): SafeParseResult<T> {
      try {
        return { success: true, data: parser(input) };
      } catch (error) {
        if (error instanceof ContractValidationError) {
          return { success: false, error };
        }
        throw error;
      }
    },
  };
}

export const EventEnvelopeV1Schema = createRuntimeSchema(parseEventEnvelopeV1);
export const DomainEventSchema = createRuntimeSchema(parseDomainEvent);
export const eventEnvelopeV1Schema = EventEnvelopeV1Schema;
export const domainEventSchema = DomainEventSchema;
