import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DomainEventDraft } from "../../src/contracts/events/event.js";
import { JsonlEventReader } from "../../src/adapters/persistence/read/jsonl-event-reader.js";
import { JsonlEventWriter } from "../../src/adapters/persistence/write/jsonl-event-writer.js";
import type { RunId } from "../../src/domain/primitives/ids.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const RUN_ID = "run-001" as RunId;
const EVENT_LOG_PATH = [".pi", "runs", RUN_ID, "events", "events.jsonl"];

function eventDraft(type: DomainEventDraft["type"] = "step.completed"): DomainEventDraft {
  return {
    schema_version: 1,
    type,
    timestamp: "2026-08-30T03:02:10.123+09:00",
    run_id: RUN_ID,
    source: { component: "orchestrator" },
    state_revision: 1,
    data: { step_id: "step-001" },
  };
}

describe("JSONL event log", () => {
  it("allocates writer-owned sequence and Event IDs in write order", async () => {
    await withTempRepository({}, async (repositoryRoot) => {
      const writer = new JsonlEventWriter(repositoryRoot);
      const first = await writer.append(eventDraft("step.started"));
      const rest = await writer.appendBatch([
        eventDraft(),
        { ...eventDraft("step.failed"), caused_by: { event_id: first.event_id } },
      ]);

      expect([first, ...rest].map(({ sequence, event_id }) => ({ sequence, event_id }))).toEqual([
        { sequence: 1, event_id: "evt-000001" },
        { sequence: 2, event_id: "evt-000002" },
        { sequence: 3, event_id: "evt-000003" },
      ]);

      expect(rest[1]?.caused_by).toEqual({ event_id: first.event_id });

      const reader = new JsonlEventReader(repositoryRoot);
      await expect(reader.readAfter(RUN_ID, 1)).resolves.toEqual(rest);
      await expect(readFile(join(repositoryRoot, ...EVENT_LOG_PATH), "utf8")).resolves.toBe(
        `${[first, ...rest].map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
    });
  });

  it("skips corrupt JSONL lines while reading later events", async () => {
    await withTempRepository({}, async (repositoryRoot) => {
      const writer = new JsonlEventWriter(repositoryRoot);
      const first = await writer.append(eventDraft());
      const path = join(repositoryRoot, ...EVENT_LOG_PATH);
      await appendFile(path, "not-json\n", "utf8");
      const second = await writer.append(eventDraft("step.failed"));

      await expect(new JsonlEventReader(repositoryRoot).readAfter(RUN_ID, 0)).resolves.toEqual([
        first,
        second,
      ]);
    });
  });
});
