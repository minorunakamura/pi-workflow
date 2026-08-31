import { readFile as nodeReadFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ContractValidationError,
  type RuntimeSchema,
} from "../../../contracts/execution/agent-execution.js";
import {
  DecisionsSnapshotV1Schema,
  FindingsSnapshotV1Schema,
  GatesSnapshotV1Schema,
  RequirementSnapshotV1Schema,
  RunYamlV1Schema,
  SnapshotManifestV1Schema,
  StepsSnapshotV1Schema,
  UncertaintiesSnapshotV1Schema,
  type RunYamlV1,
} from "../../../contracts/state/workflow-state.js";
import type { RunId } from "../../../domain/primitives/ids.js";
import type { RunReader, StateSnapshot, WorkflowState } from "../../../ports/run-reader.js";

export type ReadTextFile = (path: string) => Promise<string>;

export type FileRunReaderOptions = Readonly<{
  maxAttempts?: number;
  readFile?: ReadTextFile;
}>;

const RUN_ID_PATTERN = /^run-\d+$/;
const DEFAULT_MAX_ATTEMPTS = 3;

const defaultReadTextFile: ReadTextFile = (path) => nodeReadFile(path, "utf8");

export class RunReaderConsistencyError extends Error {
  constructor(runId: RunId) {
    super(`Run pointer changed while reading ${runId}`);
    this.name = "RunReaderConsistencyError";
  }
}

function failConsistency(path: string, expected: string): never {
  throw new ContractValidationError("WorkflowState", { path, expected });
}

async function readYaml<T>(
  path: string,
  schema: RuntimeSchema<T>,
  readTextFile: ReadTextFile,
): Promise<T> {
  return schema.parse(parseYaml(await readTextFile(path)));
}

async function readJson<T>(
  path: string,
  schema: RuntimeSchema<T>,
  readTextFile: ReadTextFile,
): Promise<T> {
  return schema.parse(JSON.parse(await readTextFile(path)) as unknown);
}

export class FileRunReader implements RunReader {
  private readonly repositoryRoot: string;
  private readonly maxAttempts: number;
  private readonly readTextFile: ReadTextFile;

  constructor(repositoryRoot: string, options: FileRunReaderOptions = {}) {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError("maxAttempts must be a positive safe integer");
    }

    this.repositoryRoot = resolve(repositoryRoot);
    this.maxAttempts = maxAttempts;
    this.readTextFile = options.readFile ?? defaultReadTextFile;
  }

  async load(runId: RunId): Promise<WorkflowState> {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new Error(`Invalid Run ID: ${runId}`);
    }

    const runDirectory = join(this.repositoryRoot, ".pi", "runs", runId);

    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const initialRun = await this.readRun(runDirectory);
      if (initialRun.run_id !== runId) {
        failConsistency("run.run_id", `the requested Run ID ${runId}`);
      }

      let snapshot: StateSnapshot;
      try {
        snapshot = await this.readSnapshot(runDirectory, initialRun.state_revision);
      } catch (error) {
        const latestRun = await this.readRun(runDirectory);
        if (this.samePointer(initialRun, latestRun)) {
          throw error;
        }
        continue;
      }

      const latestRun = await this.readRun(runDirectory);
      if (!this.samePointer(initialRun, latestRun)) {
        continue;
      }

      validateConsistency(latestRun, snapshot);
      return { run: latestRun, snapshot };
    }

    throw new RunReaderConsistencyError(runId);
  }

  private async readRun(runDirectory: string): Promise<RunYamlV1> {
    return readYaml(join(runDirectory, "run.yaml"), RunYamlV1Schema, this.readTextFile);
  }

  private async readSnapshot(runDirectory: string, stateRevision: number): Promise<StateSnapshot> {
    const snapshotDirectory = join(runDirectory, "state", "snapshots", String(stateRevision));
    const [requirement, steps, uncertainties, decisions, gates, findings, manifest] =
      await Promise.all([
        readYaml(
          join(snapshotDirectory, "requirement.yaml"),
          RequirementSnapshotV1Schema,
          this.readTextFile,
        ),
        readYaml(join(snapshotDirectory, "steps.yaml"), StepsSnapshotV1Schema, this.readTextFile),
        readYaml(
          join(snapshotDirectory, "uncertainties.yaml"),
          UncertaintiesSnapshotV1Schema,
          this.readTextFile,
        ),
        readYaml(
          join(snapshotDirectory, "decisions.yaml"),
          DecisionsSnapshotV1Schema,
          this.readTextFile,
        ),
        readYaml(join(snapshotDirectory, "gates.yaml"), GatesSnapshotV1Schema, this.readTextFile),
        readYaml(
          join(snapshotDirectory, "findings.yaml"),
          FindingsSnapshotV1Schema,
          this.readTextFile,
        ),
        readJson(
          join(snapshotDirectory, "manifest.json"),
          SnapshotManifestV1Schema,
          this.readTextFile,
        ),
      ]);

    return { requirement, steps, uncertainties, decisions, gates, findings, manifest };
  }

  private samePointer(left: RunYamlV1, right: RunYamlV1): boolean {
    return left.run_id === right.run_id && left.state_revision === right.state_revision;
  }
}

function validateConsistency(run: RunYamlV1, snapshot: StateSnapshot): void {
  const documents = [
    ["requirement", snapshot.requirement],
    ["steps", snapshot.steps],
    ["uncertainties", snapshot.uncertainties],
    ["decisions", snapshot.decisions],
    ["gates", snapshot.gates],
    ["findings", snapshot.findings],
    ["manifest", snapshot.manifest],
  ] as const;

  for (const [name, document] of documents) {
    if (document.run_id !== run.run_id) {
      failConsistency(`${name}.run_id`, `the current Run ID ${run.run_id}`);
    }
    if (document.state_revision !== run.state_revision) {
      failConsistency(`${name}.state_revision`, `the current state revision ${run.state_revision}`);
    }
  }

  if (snapshot.steps.graph_revision !== run.graph_revision) {
    failConsistency("steps.graph_revision", `the current graph revision ${run.graph_revision}`);
  }
}
