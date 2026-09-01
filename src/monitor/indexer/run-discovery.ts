import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, resolve } from "node:path";
import type { RunYamlV1 } from "../../contracts/state/workflow-state.js";
import {
  DEFAULT_STATE_SCHEMA_MIGRATIONS,
  readRunYaml,
  type ReadTextFile,
  type StateSchemaMigrations,
} from "../../read-model/run-store-readers.js";

export const RUN_DISCOVERY_STATES = ["valid", "degraded", "unreadable"] as const;
export type RunDiscoveryState = (typeof RUN_DISCOVERY_STATES)[number];

export type RunCandidate = Readonly<{
  directoryName: string;
  runId: string;
  path: string;
  state: RunDiscoveryState;
  run?: RunYamlV1;
  error?: string;
}>;

export type RunDiscoveryOptions = Readonly<{
  runsRoot?: string;
  readFile?: ReadTextFile;
  migrations?: StateSchemaMigrations;
}>;

const RUN_ID_PATTERN = /^run-\d+$/;
const defaultReadTextFile: ReadTextFile = (path) => readFile(path, "utf8");

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isUnreadable(error: unknown): boolean {
  return ["EACCES", "EBUSY", "EIO", "EISDIR", "ELOOP", "ENODEV", "ENOTDIR", "EPERM"].includes(
    errorCode(error) ?? "",
  );
}

function degradedCandidate(
  directoryName: string,
  path: string,
  run: RunYamlV1 | undefined,
  message: string,
): RunCandidate {
  return {
    directoryName,
    runId: directoryName,
    path,
    state: "degraded",
    ...(run === undefined ? {} : { run }),
    error: message,
  };
}

export class RunDiscovery {
  readonly runsRoot: string;
  private readonly readTextFile: ReadTextFile;
  private readonly migrations: StateSchemaMigrations;

  constructor(repositoryRoot: string, options: RunDiscoveryOptions = {}) {
    this.runsRoot = resolve(options.runsRoot ?? join(repositoryRoot, ".pi", "runs"));
    this.readTextFile = options.readFile ?? defaultReadTextFile;
    this.migrations = options.migrations ?? DEFAULT_STATE_SCHEMA_MIGRATIONS;
  }

  async scan(): Promise<RunCandidate[]> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(this.runsRoot, { encoding: "utf8", withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const candidates: RunCandidate[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;

      const path = join(this.runsRoot, entry.name);
      try {
        const run = await readRunYaml(join(path, "run.yaml"), this.readTextFile, this.migrations);
        if (entry.name !== run.run_id || !RUN_ID_PATTERN.test(entry.name)) {
          candidates.push(
            degradedCandidate(
              entry.name,
              path,
              run,
              `Run directory ${entry.name} does not match run.yaml.run_id ${String(run.run_id)}`,
            ),
          );
          continue;
        }
        candidates.push({
          directoryName: entry.name,
          runId: entry.name,
          path,
          state: "valid",
          run,
        });
      } catch (error) {
        if (isNotFound(error)) continue;
        candidates.push(
          isUnreadable(error)
            ? {
                directoryName: entry.name,
                runId: entry.name,
                path,
                state: "unreadable",
                error: errorMessage(error),
              }
            : degradedCandidate(entry.name, path, undefined, errorMessage(error)),
        );
      }
    }

    return candidates;
  }
}

export async function discoverRuns(
  repositoryRoot: string,
  options: RunDiscoveryOptions = {},
): Promise<RunCandidate[]> {
  return new RunDiscovery(repositoryRoot, options).scan();
}
