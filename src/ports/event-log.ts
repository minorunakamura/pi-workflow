import type { DomainEvent, DomainEventDraft } from "../contracts/events/event.js";
import type { RunId } from "../domain/primitives/ids.js";

export type { DomainEventDraft } from "../contracts/events/event.js";

export interface EventWriter {
  append(event: DomainEventDraft): Promise<DomainEvent>;
  appendBatch(events: readonly DomainEventDraft[]): Promise<DomainEvent[]>;
}

export interface EventReader {
  readAfter(runId: RunId, sequence: number): Promise<DomainEvent[]>;
}
