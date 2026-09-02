import {
  appendFile as nodeAppendFile,
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  parseDomainEvent,
  type DomainEvent,
  type DomainEventDraft,
  type EventId,
} from "../../../contracts/events/event.js";
import type { RunId } from "../../../domain/primitives/ids.js";
import { redactJson } from "../../../telemetry/redaction.js";
import type { EventWriter } from "../../../ports/event-log.js";
import type { ReadTextFile } from "../read/state-snapshot-files.js";

export type AppendTextFile = (path: string, contents: string) => Promise<void>;
export type MakeDirectory = (path: string) => Promise<void>;

export type JsonlEventWriterOptions = Readonly<{
  readFile?: ReadTextFile;
  appendFile?: AppendTextFile;
  mkdir?: MakeDirectory;
}>;

const RUN_ID_PATTERN = /^run-\d+$/;
const EVENT_LOG_FILE = ["events", "events.jsonl"] as const;
const defaultReadTextFile: ReadTextFile = (path) => nodeReadFile(path, "utf8");
const defaultAppendTextFile: AppendTextFile = (path, contents) =>
  nodeAppendFile(path, contents, "utf8");
const defaultMakeDirectory: MakeDirectory = async (path) => {
  await nodeMkdir(path, { recursive: true });
};

function validRunId(value: unknown): RunId {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    throw new Error(`Invalid Run ID: ${String(value)}`);
  }
  return value as RunId;
}

function nextValue(value: number, name: string): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${name} exhausted`);
  }
  return value + 1;
}

function eventNumber(eventId: EventId): number {
  const value = Number(eventId.slice("evt-".length));
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Event ID sequence exhausted");
  }
  return value;
}

type EventCursor = Readonly<{
  contents: string;
  sequence: number;
  eventId: number;
}>;

export class JsonlEventWriter implements EventWriter {
  private readonly repositoryRoot: string;
  private readonly readTextFile: ReadTextFile;
  private readonly appendTextFile: AppendTextFile;
  private readonly makeDirectory: MakeDirectory;

  constructor(repositoryRoot: string, options: JsonlEventWriterOptions = {}) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.readTextFile = options.readFile ?? defaultReadTextFile;
    this.appendTextFile = options.appendFile ?? defaultAppendTextFile;
    this.makeDirectory = options.mkdir ?? defaultMakeDirectory;
  }

  async append(event: DomainEventDraft): Promise<DomainEvent> {
    const events = await this.appendBatch([event]);
    const appended = events[0];
    if (appended === undefined) {
      throw new Error("Event append produced no event");
    }
    return appended;
  }

  async appendBatch(events: readonly DomainEventDraft[]): Promise<DomainEvent[]> {
    if (events.length === 0) {
      return [];
    }

    const runId = validRunId(events[0]?.run_id);
    for (const event of events) {
      if (validRunId(event.run_id) !== runId) {
        throw new Error("Event batch must contain one Run ID");
      }
    }

    const path = this.eventLogPath(runId);
    const cursor = await this.readCursor(path, runId);
    let sequence = cursor.sequence;
    let eventId = cursor.eventId;
    const appended: DomainEvent[] = [];

    for (const draft of events) {
      sequence = nextValue(sequence, "Event sequence");
      eventId = nextValue(eventId, "Event ID sequence");
      const event = parseDomainEvent({
        ...draft,
        event_id: formatEventId(eventId),
        sequence,
      });
      appended.push(event);
    }

    const persisted = appended.map((event) => parseDomainEvent(redactJson(event)));
    await this.makeDirectory(join(this.repositoryRoot, ".pi", "runs", runId, "events"));
    const separator = cursor.contents.length > 0 && !/[\r\n]$/.test(cursor.contents) ? "\n" : "";
    await this.appendTextFile(
      path,
      `${separator}${persisted.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    return persisted;
  }

  private async readCursor(path: string, runId: RunId): Promise<EventCursor> {
    let contents: string;
    try {
      contents = await this.readTextFile(path);
    } catch (error) {
      if (isNotFound(error)) {
        return { contents: "", sequence: 0, eventId: 0 };
      }
      throw error;
    }

    let sequence = 0;
    let eventId = 0;
    for (const line of contents.split(/\r?\n/)) {
      if (line.trim() === "") {
        continue;
      }

      try {
        const event = parseDomainEvent(JSON.parse(line) as unknown);
        if (event.run_id !== runId) {
          continue;
        }
        sequence = Math.max(sequence, event.sequence);
        eventId = Math.max(eventId, eventNumber(event.event_id));
      } catch {
        // Corrupt entries do not prevent allocation for later valid events.
      }
    }

    return { contents, sequence, eventId };
  }

  private eventLogPath(runId: RunId): string {
    return join(this.repositoryRoot, ".pi", "runs", runId, ...EVENT_LOG_FILE);
  }
}

function formatEventId(sequence: number): EventId {
  return `evt-${String(sequence).padStart(6, "0")}` as EventId;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
