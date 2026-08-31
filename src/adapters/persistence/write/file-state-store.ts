import { deepStrictEqual } from "node:assert/strict";
import {
  mkdir as nodeMkdir,
  mkdtemp as nodeMkdtemp,
  readFile as nodeReadFile,
  rename as nodeRename,
  rm as nodeRm,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { ContractValidationError } from "../../../contracts/execution/agent-execution.js";
import type { RunId } from "../../../domain/primitives/ids.js";
import { FileRunReader, validateWorkflowStateConsistency } from "../read/file-run-reader.js";
import {
  readRunYaml,
  readSnapshotDirectory,
  type ReadTextFile,
  validateRunYaml,
  validateStateSnapshot,
} from "../read/state-snapshot-files.js";
import type { RunReader, StateSnapshot, WorkflowState } from "../../../ports/run-reader.js";
import type { StateStore, StateStoreCommitInput } from "../../../ports/state-store.js";

export type WriteTextFile = (path: string, contents: string) => Promise<void>;
export type RenamePath = (source: string, destination: string) => Promise<void>;
export type MakeDirectory = (path: string) => Promise<void>;
export type MakeTempDirectory = (prefix: string) => Promise<string>;
export type RemovePath = (path: string) => Promise<void>;

export type FileStateStoreOptions = Readonly<{
  reader?: RunReader;
  readFile?: ReadTextFile;
  writeFile?: WriteTextFile;
  rename?: RenamePath;
  mkdir?: MakeDirectory;
  mkdtemp?: MakeTempDirectory;
  rm?: RemovePath;
}>;

const defaultReadTextFile: ReadTextFile = (path) => nodeReadFile(path, "utf8");
const defaultWriteTextFile: WriteTextFile = (path, contents) =>
  nodeWriteFile(path, contents, "utf8");
const defaultRename: RenamePath = nodeRename;
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

function failState(path: string, expected: string): never {
  throw new ContractValidationError("WorkflowState", { path, expected });
}

function runDirectory(repositoryRoot: string, runId: RunId): string {
  return join(repositoryRoot, ".pi", "runs", runId);
}

export class FileStateStore implements StateStore {
  private readonly repositoryRoot: string;
  private readonly reader: RunReader;
  private readonly readTextFile: ReadTextFile;
  private readonly writeTextFile: WriteTextFile;
  private readonly renamePath: RenamePath;
  private readonly makeDirectory: MakeDirectory;
  private readonly makeTempDirectory: MakeTempDirectory;
  private readonly removePath: RemovePath;

  constructor(repositoryRoot: string, options: FileStateStoreOptions = {}) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.readTextFile = options.readFile ?? defaultReadTextFile;
    this.writeTextFile = options.writeFile ?? defaultWriteTextFile;
    this.renamePath = options.rename ?? defaultRename;
    this.makeDirectory = options.mkdir ?? defaultMakeDirectory;
    this.makeTempDirectory = options.mkdtemp ?? defaultMakeTempDirectory;
    this.removePath = options.rm ?? defaultRemovePath;
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
    validateRunYaml(next.run);
    validateStateSnapshot(next.snapshot);
    validateWorkflowStateConsistency(next.run, next.snapshot);
    if (next.run.state_revision !== nextRevision) {
      failState("run.state_revision", `the next state revision ${nextRevision}`);
    }
    if (next.snapshot.manifest.previous_state_revision !== expectedRevision) {
      failState(
        "snapshot.manifest.previous_state_revision",
        `the previous state revision ${expectedRevision}`,
      );
    }

    const runDir = runDirectory(this.repositoryRoot, current.run.run_id);
    const snapshotsDir = join(runDir, "state", "snapshots");
    const snapshotDir = join(snapshotsDir, String(nextRevision));
    await this.makeDirectory(snapshotsDir);

    const temporarySnapshotDir = await this.makeTempDirectory(
      join(snapshotsDir, `.${nextRevision}.tmp-`),
    );
    let snapshotFinalized = false;
    let temporaryRunDir: string | undefined;

    try {
      await this.writeSnapshot(temporarySnapshotDir, next.snapshot);
      const readBackSnapshot = await readSnapshotDirectory(temporarySnapshotDir, this.readTextFile);
      validateWorkflowStateConsistency(next.run, readBackSnapshot);
      deepStrictEqual(readBackSnapshot, next.snapshot);

      await this.renamePath(temporarySnapshotDir, snapshotDir);
      snapshotFinalized = true;

      temporaryRunDir = await this.makeTempDirectory(join(runDir, ".run-tmp-"));
      const temporaryRunFile = join(temporaryRunDir, "run.yaml");
      await this.writeTextFile(temporaryRunFile, stringify(next.run));
      const readBackRun = await readRunYaml(temporaryRunFile, this.readTextFile);
      deepStrictEqual(readBackRun, next.run);

      const currentRun = await readRunYaml(join(runDir, "run.yaml"), this.readTextFile);
      if (currentRun.state_revision !== expectedRevision) {
        throw new StateRevisionConflictError(
          currentRun.run_id,
          expectedRevision,
          currentRun.state_revision,
        );
      }

      await this.renamePath(temporaryRunFile, join(runDir, "run.yaml"));
      return next;
    } finally {
      if (!snapshotFinalized) {
        await this.removePath(temporarySnapshotDir);
      }
      if (temporaryRunDir !== undefined) {
        await this.removePath(temporaryRunDir);
      }
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
