import { readFile as nodeReadFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDomainEvent, type DomainEvent } from "../../../contracts/events/event.js";
import type { RunId } from "../../../domain/primitives/ids.js";
import type { EventReader } from "../../../ports/event-log.js";
import type { ReadTextFile } from "./state-snapshot-files.js";

export type JsonlEventReaderOptions = Readonly<{
  readFile?: ReadTextFile;
}>;

const RUN_ID_PATTERN = /^run-\d+$/;
const EVENT_LOG_FILE = ["events", "events.jsonl"] as const;
const defaultReadTextFile: ReadTextFile = (path) => nodeReadFile(path, "utf8");

function validRunId(runId: RunId): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid Run ID: ${runId}`);
  }
}

function validSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError("sequence must be a non-negative safe integer");
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export class JsonlEventReader implements EventReader {
  private readonly repositoryRoot: string;
  private readonly readTextFile: ReadTextFile;

  constructor(repositoryRoot: string, options: JsonlEventReaderOptions = {}) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.readTextFile = options.readFile ?? defaultReadTextFile;
  }

  async readAfter(runId: RunId, sequence: number): Promise<DomainEvent[]> {
    validRunId(runId);
    validSequence(sequence);

    let contents: string;
    try {
      contents = await this.readTextFile(this.eventLogPath(runId));
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }

    const events: DomainEvent[] = [];
    for (const line of contents.split(/\r?\n/)) {
      if (line.trim() === "") {
        continue;
      }

      try {
        const event = parseDomainEvent(JSON.parse(line) as unknown);
        if (event.run_id === runId && event.sequence > sequence) {
          events.push(event);
        }
      } catch {
        // A malformed JSONL entry is isolated from the rest of the event history.
      }
    }

    return events;
  }

  private eventLogPath(runId: RunId): string {
    return join(this.repositoryRoot, ".pi", "runs", runId, ...EVENT_LOG_FILE);
  }
}
