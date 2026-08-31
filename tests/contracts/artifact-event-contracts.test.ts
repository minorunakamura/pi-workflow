import { describe, expect, it } from "vitest";
import {
  ArtifactFrontMatterV1Schema,
  ARTIFACT_STATUSES,
} from "../../src/contracts/artifacts/artifact.js";
import {
  CANONICAL_EVENT_TYPES,
  DomainEventSchema,
  EventEnvelopeV1Schema,
} from "../../src/contracts/events/event.js";

function validArtifact() {
  return {
    schema_version: 1,
    run_id: "run-001",
    step_id: "step-001",
    execution_id: "exec-001",
    execution_state_revision: 41,
    agent: { id: "worker", version: 1 },
    artifact: { type: "implementation", status: "complete" },
    created_at: "2026-08-30T03:02:10.123+09:00",
    skills: [],
  };
}

function validEvent(type: (typeof CANONICAL_EVENT_TYPES)[number] = "step.completed") {
  return {
    schema_version: 1,
    event_id: "evt-000123",
    sequence: 123,
    type,
    timestamp: "2026-08-30T03:02:10.123+09:00",
    run_id: "run-001",
    source: { component: "orchestrator" },
    actor: { type: "agent", id: "worker" },
    state_revision: 42,
    correlation_id: "exec-001",
    caused_by: { event_id: "evt-000121" },
    data: { step_id: "step-001" },
  };
}

describe("artifact and event contracts", () => {
  it("validates Artifact front matter and its common statuses", () => {
    expect(ArtifactFrontMatterV1Schema.parse(validArtifact())).toEqual(validArtifact());

    for (const status of ARTIFACT_STATUSES) {
      expect(
        ArtifactFrontMatterV1Schema.parse({
          ...validArtifact(),
          artifact: { ...validArtifact().artifact, status },
        }).artifact.status,
      ).toBe(status);
    }

    expect(() =>
      ArtifactFrontMatterV1Schema.parse({
        ...validArtifact(),
        artifact: { ...validArtifact().artifact, status: "draft" },
      }),
    ).toThrow(/artifact\.status.*complete, partial/);
  });

  it("validates the Event envelope and every canonical type", () => {
    for (const type of CANONICAL_EVENT_TYPES) {
      expect(DomainEventSchema.parse(validEvent(type)).type).toBe(type);
    }

    expect(EventEnvelopeV1Schema.parse(validEvent())).toEqual(validEvent());
    const {
      actor: _actor,
      correlation_id: _correlationId,
      caused_by: _causedBy,
      ...withoutOptional
    } = validEvent();
    expect(EventEnvelopeV1Schema.parse(withoutOptional)).toEqual(withoutOptional);
  });

  it("rejects malformed envelopes and non-canonical noisy event types", () => {
    expect(() => EventEnvelopeV1Schema.parse({ ...validEvent(), data: [] })).toThrow(
      /data.*object/,
    );
    expect(() => EventEnvelopeV1Schema.parse({ ...validEvent(), type: "step.ready" })).toThrow(
      /type.*run\.created.*error\.escalated/,
    );
    expect(() => EventEnvelopeV1Schema.parse({ ...validEvent(), type: "run.finalized" })).toThrow(
      /type.*one of/,
    );
    expect(() => EventEnvelopeV1Schema.parse({ ...validEvent(), timestamp: "2026-08-30" })).toThrow(
      /timestamp.*timezone offset/,
    );
  });
});
