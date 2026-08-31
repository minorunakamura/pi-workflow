import { randomUUID } from "node:crypto";
import {
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  rename as nodeRename,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { hostname as nodeHostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RunId } from "../../../domain/primitives/ids.js";
import type {
  RunLock,
  RunLockAcquireOptions,
  RunLockHandle,
  RunLockMetadata,
} from "../../../ports/run-lock.js";
import type { ReadTextFile } from "../read/state-snapshot-files.js";

export type CreateExclusiveLockFile = (path: string, contents: string) => Promise<void>;
export type WriteLockFile = (path: string, contents: string) => Promise<void>;
export type RenameLockPath = (source: string, destination: string) => Promise<void>;
export type RemoveLockPath = (path: string) => Promise<void>;
export type MakeLockDirectory = (path: string) => Promise<void>;
export type ProcessAlive = (processId: number) => boolean;

export type FileRunLockOptions = Readonly<{
  owner?: string;
  processId?: number;
  host?: string;
  now?: () => Date;
  readFile?: ReadTextFile;
  createFile?: CreateExclusiveLockFile;
  writeFile?: WriteLockFile;
  rename?: RenameLockPath;
  unlink?: RemoveLockPath;
  mkdir?: MakeLockDirectory;
  processAlive?: ProcessAlive;
}>;

const RUN_ID_PATTERN = /^run-\d+$/;

const defaultReadTextFile: ReadTextFile = (path) => nodeReadFile(path, "utf8");
const defaultCreateExclusiveFile: CreateExclusiveLockFile = (path, contents) =>
  nodeWriteFile(path, contents, { encoding: "utf8", flag: "wx" });
const defaultWriteLockFile: WriteLockFile = (path, contents) =>
  nodeWriteFile(path, contents, "utf8");
const defaultRename: RenameLockPath = nodeRename;
const defaultRemove: RemoveLockPath = nodeUnlink;
const defaultMakeDirectory: MakeLockDirectory = async (path) => {
  await nodeMkdir(path, { recursive: true });
};

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function processIdValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function validRunId(runId: RunId): RunId {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid Run ID: ${runId}`);
  }
  return runId;
}

function validOwner(owner: string): string {
  if (owner.trim().length === 0) {
    throw new RangeError("owner must be a non-empty string");
  }
  return owner;
}

function validProcessId(processId: number): number {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new RangeError("processId must be a positive safe integer");
  }
  return processId;
}

function validTimestamp(now: Date): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError("now must return a valid Date");
  }
  return now.toISOString();
}

function parseLockMetadata(runId: RunId, contents: string): RunLockMetadata {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new RunLockedError(runId);
  }

  if (!isRecord(value)) {
    throw new RunLockedError(runId);
  }

  const processId = processIdValue(value.process);
  if (
    !nonEmptyString(value.owner) ||
    processId === undefined ||
    !nonEmptyString(value.host) ||
    !nonEmptyString(value.acquired) ||
    !nonEmptyString(value.heartbeat)
  ) {
    throw new RunLockedError(runId);
  }

  return {
    owner: value.owner,
    process: processId,
    host: value.host,
    acquired: value.acquired,
    heartbeat: value.heartbeat,
  };
}

function sameLockIdentity(left: RunLockMetadata, right: RunLockMetadata): boolean {
  return (
    left.owner === right.owner &&
    left.process === right.process &&
    left.host === right.host &&
    left.acquired === right.acquired
  );
}

function defaultProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

export function runLockPath(repositoryRoot: string, runId: RunId): string {
  validRunId(runId);
  return join(resolve(repositoryRoot), ".pi", "runs", runId, "run.lock");
}

export class RunLockedError extends Error {
  readonly code = "RUN_LOCKED";
  readonly metadata: RunLockMetadata | undefined;

  constructor(runId: RunId, metadata?: RunLockMetadata) {
    super(`RUN_LOCKED for ${runId}`);
    this.name = "RunLockedError";
    this.metadata = metadata;
  }
}

export class RunLockOwnershipError extends Error {
  readonly code = "RUN_LOCK_OWNERSHIP_LOST";

  constructor(runId: RunId) {
    super(`RUN_LOCK_OWNERSHIP_LOST for ${runId}`);
    this.name = "RunLockOwnershipError";
  }
}

export class FileRunLock implements RunLock {
  private readonly repositoryRoot: string;
  private readonly owner: string;
  private readonly processId: number;
  private readonly host: string;
  private readonly now: () => Date;
  private readonly readTextFile: ReadTextFile;
  private readonly createExclusiveFile: CreateExclusiveLockFile;
  private readonly writeLockFile: WriteLockFile;
  private readonly renamePath: RenameLockPath;
  private readonly removePath: RemoveLockPath;
  private readonly makeDirectory: MakeLockDirectory;
  private readonly processAlive: ProcessAlive;

  constructor(repositoryRoot: string, options: FileRunLockOptions = {}) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.owner = validOwner(options.owner ?? `workflow-${process.pid}`);
    this.processId = validProcessId(options.processId ?? process.pid);
    this.host = validOwner(options.host ?? nodeHostname());
    this.now = options.now ?? (() => new Date());
    this.readTextFile = options.readFile ?? defaultReadTextFile;
    this.createExclusiveFile = options.createFile ?? defaultCreateExclusiveFile;
    this.writeLockFile = options.writeFile ?? defaultWriteLockFile;
    this.renamePath = options.rename ?? defaultRename;
    this.removePath = options.unlink ?? defaultRemove;
    this.makeDirectory = options.mkdir ?? defaultMakeDirectory;
    this.processAlive = options.processAlive ?? defaultProcessAlive;
  }

  async acquire(runId: RunId, options: RunLockAcquireOptions = {}): Promise<RunLockHandle> {
    validRunId(runId);
    const lockPath = runLockPath(this.repositoryRoot, runId);
    await this.makeDirectory(dirname(lockPath));

    for (;;) {
      const metadata = this.newMetadata();
      try {
        await this.createExclusiveFile(lockPath, JSON.stringify(metadata));
        return new FileRunLockHandle(
          runId,
          lockPath,
          metadata,
          this.readTextFile,
          this.writeLockFile,
          this.removePath,
          this.now,
        );
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error;
        }

        let current: RunLockMetadata;
        try {
          current = await this.readMetadata(runId, lockPath);
        } catch (readError) {
          if (isNotFound(readError)) {
            continue;
          }
          throw readError;
        }

        if (!options.recoverStale || this.isLive(current)) {
          throw new RunLockedError(runId, current);
        }

        const stalePath = join(dirname(lockPath), `.run.lock.stale-${randomUUID()}`);
        try {
          await this.renamePath(lockPath, stalePath);
        } catch (renameError) {
          if (isNotFound(renameError)) {
            continue;
          }
          throw renameError;
        }
        try {
          await this.removePath(stalePath);
        } catch (removeError) {
          if (!isNotFound(removeError)) {
            throw removeError;
          }
        }
      }
    }
  }

  private newMetadata(): RunLockMetadata {
    const timestamp = validTimestamp(this.now());
    return {
      owner: this.owner,
      process: this.processId,
      host: this.host,
      acquired: timestamp,
      heartbeat: timestamp,
    };
  }

  private async readMetadata(runId: RunId, lockPath: string): Promise<RunLockMetadata> {
    return parseLockMetadata(runId, await this.readTextFile(lockPath));
  }

  private isLive(metadata: RunLockMetadata): boolean {
    return metadata.host !== this.host || this.processAlive(metadata.process);
  }
}

class FileRunLockHandle implements RunLockHandle {
  private released = false;

  constructor(
    private readonly runId: RunId,
    private readonly lockPath: string,
    readonly metadata: RunLockMetadata,
    private readonly readTextFile: ReadTextFile,
    private readonly writeLockFile: WriteLockFile,
    private readonly removePath: RemoveLockPath,
    private readonly now: () => Date,
  ) {}

  async heartbeat(): Promise<void> {
    this.assertUsable();
    const current = await this.readCurrentMetadata();
    if (!sameLockIdentity(current, this.metadata)) {
      throw new RunLockOwnershipError(this.runId);
    }

    const heartbeat = validTimestamp(this.now());
    await this.writeLockFile(this.lockPath, JSON.stringify({ ...this.metadata, heartbeat }));
  }

  async release(): Promise<void> {
    if (this.released) {
      return;
    }

    let current: RunLockMetadata;
    try {
      current = await this.readCurrentMetadata();
    } catch (error) {
      if (isNotFound(error)) {
        this.released = true;
        return;
      }
      throw error;
    }

    if (!sameLockIdentity(current, this.metadata)) {
      this.released = true;
      throw new RunLockOwnershipError(this.runId);
    }

    await this.removePath(this.lockPath);
    this.released = true;
  }

  private async readCurrentMetadata(): Promise<RunLockMetadata> {
    return parseLockMetadata(this.runId, await this.readTextFile(this.lockPath));
  }

  private assertUsable(): void {
    if (this.released) {
      throw new RunLockOwnershipError(this.runId);
    }
  }
}
