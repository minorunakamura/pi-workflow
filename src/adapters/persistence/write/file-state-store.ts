import { deepStrictEqual } from "node:assert/strict";
import {
  link as nodeLink,
  mkdir as nodeMkdir,
  mkdtemp as nodeMkdtemp,
  readFile as nodeReadFile,
  rename as nodeRename,
  rm as nodeRm,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify } from "yaml";
import { ContractValidationError } from "../../../contracts/execution/agent-execution.js";
import {
  RequirementSnapshotV1Schema,
  type RequirementSnapshotV1,
} from "../../../contracts/state/workflow-state.js";
import type { RunId } from "../../../domain/primitives/ids.js";
import { redactSecrets } from "../../../telemetry/redaction.js";
import { FileRunReader, validateWorkflowStateConsistency } from "../read/file-run-reader.js";
import { JsonlEventWriter } from "./jsonl-event-writer.js";
import {
  readRunYaml,
  readSnapshotDirectory,
  type ReadTextFile,
  validateRunYaml,
  validateStateSnapshot,
} from "../read/state-snapshot-files.js";
import type { EventWriter } from "../../../ports/event-log.js";
import type { RunReader, StateSnapshot, WorkflowState } from "../../../ports/run-reader.js";
import type { StateStore, StateStoreCommitInput } from "../../../ports/state-store.js";

export type WriteTextFile = (path: string, contents: string) => Promise<void>;
export type RenamePath = (source: string, destination: string) => Promise<void>;
export type LinkPath = (source: string, destination: string) => Promise<void>;
export type MakeDirectory = (path: string) => Promise<void>;
export type MakeTempDirectory = (prefix: string) => Promise<string>;
export type RemovePath = (path: string) => Promise<void>;

export type FileStateStoreOptions = Readonly<{
  reader?: RunReader;
  eventWriter?: EventWriter;
  readFile?: ReadTextFile;
  writeFile?: WriteTextFile;
  rename?: RenamePath;
  link?: LinkPath;
  mkdir?: MakeDirectory;
  mkdtemp?: MakeTempDirectory;
  rm?: RemovePath;
}>;

const defaultReadTextFile: ReadTextFile = (path) => nodeReadFile(path, "utf8");
const defaultWriteTextFile: WriteTextFile = (path, contents) =>
  nodeWriteFile(path, contents, "utf8");
const defaultRename: RenamePath = nodeRename;
const defaultLink: LinkPath = nodeLink;
const defaultMakeTempDirectory: MakeTempDirectory = nodeMkdtemp;
const defaultRemovePath: RemovePath = (path) => nodeRm(path, { force: true, recursive: true });
const defaultMakeDirectory: MakeDirectory = async (path) => {
  await nodeMkdir(path, { recursive: true });
};

export class StateRevisionConflictError extends Error {
  readonly code = "STATE_REVISION_CONFLICT";

  constructor(runId: RunId, expectedRevision: number, actualRevision: number) {
    super(
      `STATE_REVISION_CONFLICT for ${runId}: expected ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "StateRevisionConflictError";
  }
}

export class RequirementRevisionConflictError extends Error {
  readonly code = "REQUIREMENT_REVISION_CONFLICT";

  constructor(runId: RunId, revision: number) {
    super(`REQUIREMENT_REVISION_CONFLICT for ${runId}: revision ${revision} is immutable`);
    this.name = "RequirementRevisionConflictError";
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

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function sameYaml(left: string, right: string): boolean {
  try {
    deepStrictEqual(parseYaml(left), parseYaml(right));
    return true;
  } catch {
    return false;
  }
}

type RequirementHistoryEntry = Readonly<{
  runId: RunId;
  revision: number;
  path: string;
  contents: string;
}>;

function durableRequirementSnapshot(snapshot: RequirementSnapshotV1): RequirementSnapshotV1 {
  return RequirementSnapshotV1Schema.parse(parseYaml(redactSecrets(stringify(snapshot))));
}

function normalizedRequirementContents(snapshot: RequirementSnapshotV1): string {
  const normalized = Object.fromEntries(
    Object.entries(snapshot).filter(
      ([key]) => key !== "schema_version" && key !== "run_id" && key !== "state_revision",
    ),
  );
  return redactSecrets(stringify(normalized));
}

function requirementHistoryEntries(
  runDir: string,
  runId: RunId,
  requirements: readonly RequirementSnapshotV1[],
): readonly RequirementHistoryEntry[] {
  const entries = new Map<number, RequirementHistoryEntry>();
  for (const requirement of requirements) {
    const entry: RequirementHistoryEntry = {
      runId,
      revision: requirement.revision,
      path: join(runDir, "requirements", `requirement-v${requirement.revision}.yaml`),
      contents: normalizedRequirementContents(requirement),
    };
    const previous = entries.get(entry.revision);
    if (previous !== undefined && !sameYaml(previous.contents, entry.contents)) {
      throw new RequirementRevisionConflictError(runId, entry.revision);
    }
    entries.set(entry.revision, entry);
  }
  return [...entries.values()];
}

function failState(path: string, expected: string): never {
  throw new ContractValidationError("WorkflowState", { path, expected });
}

function runDirectory(repositoryRoot: string, runId: RunId): string {
  return join(repositoryRoot, ".pi", "runs", runId);
}

export class FileStateStore implements StateStore {
  private readonly repositoryRoot: string;
  private readonly reader: RunReader;
  private readonly eventWriter: EventWriter;
  private readonly readTextFile: ReadTextFile;
  private readonly writeTextFile: WriteTextFile;
  private readonly renamePath: RenamePath;
  private readonly linkPath: LinkPath;
  private readonly makeDirectory: MakeDirectory;
  private readonly makeTempDirectory: MakeTempDirectory;
  private readonly removePath: RemovePath;

  constructor(repositoryRoot: string, options: FileStateStoreOptions = {}) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.readTextFile = options.readFile ?? defaultReadTextFile;
    this.writeTextFile = options.writeFile ?? defaultWriteTextFile;
    this.renamePath = options.rename ?? defaultRename;
    this.linkPath = options.link ?? defaultLink;
    this.makeDirectory = options.mkdir ?? defaultMakeDirectory;
    this.makeTempDirectory = options.mkdtemp ?? defaultMakeTempDirectory;
    this.removePath = options.rm ?? defaultRemovePath;
    this.eventWriter =
      options.eventWriter ??
      new JsonlEventWriter(this.repositoryRoot, { readFile: this.readTextFile });
    this.reader =
      options.reader ??
      new FileRunReader(this.repositoryRoot, {
        readFile: this.readTextFile,
      });
  }

  load(runId: RunId): Promise<WorkflowState> {
    return this.reader.load(runId);
  }

  async commit(input: StateStoreCommitInput): Promise<WorkflowState> {
    const { expectedRevision, next } = input;
    const current = await this.reader.load(next.run.run_id);

    if (current.run.state_revision !== expectedRevision) {
      throw new StateRevisionConflictError(
        current.run.run_id,
        expectedRevision,
        current.run.state_revision,
      );
    }

    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new StateRevisionConflictError(
        current.run.run_id,
        expectedRevision,
        current.run.state_revision,
      );
    }
    if (expectedRevision === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("State revision exhausted");
    }

    const nextRevision = expectedRevision + 1;
    const durableNext: WorkflowState = {
      ...next,
      snapshot: {
        ...next.snapshot,
        requirement: durableRequirementSnapshot(next.snapshot.requirement),
      },
    };
    validateRunYaml(durableNext.run);
    validateStateSnapshot(durableNext.snapshot);
    validateWorkflowStateConsistency(durableNext.run, durableNext.snapshot);
    if (durableNext.run.state_revision !== nextRevision) {
      failState("run.state_revision", `the next state revision ${nextRevision}`);
    }
    if (durableNext.snapshot.manifest.previous_state_revision !== expectedRevision) {
      failState(
        "snapshot.manifest.previous_state_revision",
        `the previous state revision ${expectedRevision}`,
      );
    }

    const runDir = runDirectory(this.repositoryRoot, current.run.run_id);
    const historyEntries = requirementHistoryEntries(runDir, current.run.run_id, [
      durableRequirementSnapshot(current.snapshot.requirement),
      durableNext.snapshot.requirement,
    ]);
    const missingHistoryEntries = await this.findMissingOrConflictingHistory(historyEntries);
    const snapshotsDir = join(runDir, "state", "snapshots");
    const snapshotDir = join(snapshotsDir, String(nextRevision));
    await this.makeDirectory(snapshotsDir);

    const temporarySnapshotDir = await this.makeTempDirectory(
      join(snapshotsDir, `.${nextRevision}.tmp-`),
    );
    let snapshotFinalized = false;
    let temporaryRunDir: string | undefined;

    try {
      await this.writeSnapshot(temporarySnapshotDir, durableNext.snapshot);
      const readBackSnapshot = await readSnapshotDirectory(temporarySnapshotDir, this.readTextFile);
      validateWorkflowStateConsistency(durableNext.run, readBackSnapshot);
      deepStrictEqual(readBackSnapshot, durableNext.snapshot);

      await this.renamePath(temporarySnapshotDir, snapshotDir);
      snapshotFinalized = true;
      for (const entry of missingHistoryEntries) {
        await this.publishRequirementHistory(entry);
      }

      temporaryRunDir = await this.makeTempDirectory(join(runDir, ".run-tmp-"));
      const temporaryRunFile = join(temporaryRunDir, "run.yaml");
      await this.writeTextFile(temporaryRunFile, stringify(durableNext.run));
      const readBackRun = await readRunYaml(temporaryRunFile, this.readTextFile);
      deepStrictEqual(readBackRun, durableNext.run);

      const currentRun = await readRunYaml(join(runDir, "run.yaml"), this.readTextFile);
      if (currentRun.state_revision !== expectedRevision) {
        throw new StateRevisionConflictError(
          currentRun.run_id,
          expectedRevision,
          currentRun.state_revision,
        );
      }

      await this.renamePath(temporaryRunFile, join(runDir, "run.yaml"));
      const events = input.events ?? [];
      if (events.length > 0) {
        await this.eventWriter.appendBatch(events);
      }
      return durableNext;
    } finally {
      if (!snapshotFinalized) {
        await this.removePath(temporarySnapshotDir);
      }
      if (temporaryRunDir !== undefined) {
        await this.removePath(temporaryRunDir);
      }
    }
  }

  private async findMissingOrConflictingHistory(
    entries: readonly RequirementHistoryEntry[],
  ): Promise<readonly RequirementHistoryEntry[]> {
    const missing: RequirementHistoryEntry[] = [];
    for (const entry of entries) {
      try {
        const existing = await this.readTextFile(entry.path);
        if (!sameYaml(existing, entry.contents)) {
          throw new RequirementRevisionConflictError(entry.runId, entry.revision);
        }
      } catch (error) {
        if (isNotFound(error)) {
          missing.push(entry);
          continue;
        }
        throw error;
      }
    }
    return missing;
  }

  private async publishRequirementHistory(entry: RequirementHistoryEntry): Promise<void> {
    const directory = dirname(entry.path);
    await this.makeDirectory(directory);
    const temporaryDirectory = await this.makeTempDirectory(
      join(directory, `.${entry.revision}.tmp-`),
    );
    try {
      const temporaryFile = join(temporaryDirectory, "requirement.yaml");
      await this.writeTextFile(temporaryFile, entry.contents);
      try {
        await this.linkPath(temporaryFile, entry.path);
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error;
        }
        const existing = await this.readTextFile(entry.path);
        if (!sameYaml(existing, entry.contents)) {
          throw new RequirementRevisionConflictError(entry.runId, entry.revision);
        }
      }
    } finally {
      await this.removePath(temporaryDirectory);
    }
  }

  private async writeSnapshot(snapshotDir: string, snapshot: StateSnapshot): Promise<void> {
    const files = [
      ["requirement.yaml", stringify(snapshot.requirement)],
      ["steps.yaml", stringify(snapshot.steps)],
      ["uncertainties.yaml", stringify(snapshot.uncertainties)],
      ["decisions.yaml", stringify(snapshot.decisions)],
      ["gates.yaml", stringify(snapshot.gates)],
      ["findings.yaml", stringify(snapshot.findings)],
      ["manifest.json", JSON.stringify(snapshot.manifest)],
    ] as const;

    const results = await Promise.allSettled(
      files.map(([name, contents]) => this.writeTextFile(join(snapshotDir, name), contents)),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) {
      throw failure.reason;
    }
  }
}
