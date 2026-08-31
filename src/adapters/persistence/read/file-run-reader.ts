import { readFile as nodeReadFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ContractValidationError } from "../../../contracts/execution/agent-execution.js";
import type { RunId } from "../../../domain/primitives/ids.js";
import type { RunYamlV1 } from "../../../contracts/state/workflow-state.js";
import type { RunReader, StateSnapshot, WorkflowState } from "../../../ports/run-reader.js";
import { readRunYaml, readSnapshotDirectory, type ReadTextFile } from "./state-snapshot-files.js";

export type { ReadTextFile } from "./state-snapshot-files.js";

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

      validateWorkflowStateConsistency(latestRun, snapshot);
      return { run: latestRun, snapshot };
    }

    throw new RunReaderConsistencyError(runId);
  }

  private async readRun(runDirectory: string): Promise<RunYamlV1> {
    return readRunYaml(join(runDirectory, "run.yaml"), this.readTextFile);
  }

  private readSnapshot(runDirectory: string, stateRevision: number): Promise<StateSnapshot> {
    return readSnapshotDirectory(
      join(runDirectory, "state", "snapshots", String(stateRevision)),
      this.readTextFile,
    );
  }

  private samePointer(left: RunYamlV1, right: RunYamlV1): boolean {
    return left.run_id === right.run_id && left.state_revision === right.state_revision;
  }
}

export function validateWorkflowStateConsistency(run: RunYamlV1, snapshot: StateSnapshot): void {
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
