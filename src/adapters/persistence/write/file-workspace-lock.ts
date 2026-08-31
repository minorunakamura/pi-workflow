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
import type {
  WorkspaceLock,
  WorkspaceLockAcquireOptions,
  WorkspaceLockHandle,
  WorkspaceLockMetadata,
} from "../../../ports/workspace-lock.js";
import type { ReadTextFile } from "../read/state-snapshot-files.js";

export type CreateExclusiveWorkspaceLockFile = (path: string, contents: string) => Promise<void>;
export type WriteWorkspaceLockFile = (path: string, contents: string) => Promise<void>;
export type RenameWorkspaceLockPath = (source: string, destination: string) => Promise<void>;
export type RemoveWorkspaceLockPath = (path: string) => Promise<void>;
export type MakeWorkspaceLockDirectory = (path: string) => Promise<void>;
export type WorkspaceProcessAlive = (processId: number) => boolean;

export type FileWorkspaceLockOptions = Readonly<{
  owner?: string;
  processId?: number;
  host?: string;
  now?: () => Date;
  readFile?: ReadTextFile;
  createFile?: CreateExclusiveWorkspaceLockFile;
  writeFile?: WriteWorkspaceLockFile;
  rename?: RenameWorkspaceLockPath;
  unlink?: RemoveWorkspaceLockPath;
  mkdir?: MakeWorkspaceLockDirectory;
  processAlive?: WorkspaceProcessAlive;
}>;

const defaultReadTextFile: ReadTextFile = (path) => nodeReadFile(path, "utf8");
const defaultCreateExclusiveFile: CreateExclusiveWorkspaceLockFile = (path, contents) =>
  nodeWriteFile(path, contents, { encoding: "utf8", flag: "wx" });
const defaultWriteLockFile: WriteWorkspaceLockFile = (path, contents) =>
  nodeWriteFile(path, contents, "utf8");
const defaultRename: RenameWorkspaceLockPath = nodeRename;
const defaultRemove: RemoveWorkspaceLockPath = nodeUnlink;
const defaultMakeDirectory: MakeWorkspaceLockDirectory = async (path) => {
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

function parseLockMetadata(contents: string): WorkspaceLockMetadata {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new WorkspaceLockedError();
  }

  if (!isRecord(value)) {
    throw new WorkspaceLockedError();
  }

  const processId = processIdValue(value.process);
  if (
    !nonEmptyString(value.owner) ||
    processId === undefined ||
    !nonEmptyString(value.host) ||
    !nonEmptyString(value.acquired) ||
    !nonEmptyString(value.heartbeat)
  ) {
    throw new WorkspaceLockedError();
  }

  return {
    owner: value.owner,
    process: processId,
    host: value.host,
    acquired: value.acquired,
    heartbeat: value.heartbeat,
  };
}

function sameLockIdentity(left: WorkspaceLockMetadata, right: WorkspaceLockMetadata): boolean {
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

export function workspaceLockPath(repositoryRoot: string): string {
  return join(resolve(repositoryRoot), ".pi", "workspace.lock");
}

export class WorkspaceLockedError extends Error {
  readonly code = "WORKSPACE_LOCKED";
  readonly metadata: WorkspaceLockMetadata | undefined;

  constructor(metadata?: WorkspaceLockMetadata) {
    super("WORKSPACE_LOCKED");
    this.name = "WorkspaceLockedError";
    this.metadata = metadata;
  }
}

export class WorkspaceLockOwnershipError extends Error {
  readonly code = "WORKSPACE_LOCK_OWNERSHIP_LOST";

  constructor() {
    super("WORKSPACE_LOCK_OWNERSHIP_LOST");
    this.name = "WorkspaceLockOwnershipError";
  }
}

export class FileWorkspaceLock implements WorkspaceLock {
  private readonly repositoryRoot: string;
  private readonly owner: string;
  private readonly processId: number;
  private readonly host: string;
  private readonly now: () => Date;
  private readonly readTextFile: ReadTextFile;
  private readonly createExclusiveFile: CreateExclusiveWorkspaceLockFile;
  private readonly writeLockFile: WriteWorkspaceLockFile;
  private readonly renamePath: RenameWorkspaceLockPath;
  private readonly removePath: RemoveWorkspaceLockPath;
  private readonly makeDirectory: MakeWorkspaceLockDirectory;
  private readonly processAlive: WorkspaceProcessAlive;

  constructor(repositoryRoot: string, options: FileWorkspaceLockOptions = {}) {
    if (repositoryRoot.trim().length === 0) {
      throw new Error("FileWorkspaceLock repository root must not be empty");
    }
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

  async acquire(options: WorkspaceLockAcquireOptions = {}): Promise<WorkspaceLockHandle> {
    const lockPath = workspaceLockPath(this.repositoryRoot);
    await this.makeDirectory(dirname(lockPath));

    for (;;) {
      const metadata = this.newMetadata();
      try {
        await this.createExclusiveFile(lockPath, JSON.stringify(metadata));
        return new FileWorkspaceLockHandle(
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

        let current: WorkspaceLockMetadata;
        try {
          current = await this.readMetadata(lockPath);
        } catch (readError) {
          if (isNotFound(readError)) {
            continue;
          }
          throw readError;
        }

        if (!options.recoverStale || this.isLive(current)) {
          throw new WorkspaceLockedError(current);
        }

        const stalePath = join(dirname(lockPath), `.workspace.lock.stale-${randomUUID()}`);
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

  private newMetadata(): WorkspaceLockMetadata {
    const timestamp = validTimestamp(this.now());
    return {
      owner: this.owner,
      process: this.processId,
      host: this.host,
      acquired: timestamp,
      heartbeat: timestamp,
    };
  }

  private async readMetadata(lockPath: string): Promise<WorkspaceLockMetadata> {
    return parseLockMetadata(await this.readTextFile(lockPath));
  }

  private isLive(metadata: WorkspaceLockMetadata): boolean {
    return metadata.host !== this.host || this.processAlive(metadata.process);
  }
}

class FileWorkspaceLockHandle implements WorkspaceLockHandle {
  private released = false;

  constructor(
    private readonly lockPath: string,
    readonly metadata: WorkspaceLockMetadata,
    private readonly readTextFile: ReadTextFile,
    private readonly writeLockFile: WriteWorkspaceLockFile,
    private readonly removePath: RemoveWorkspaceLockPath,
    private readonly now: () => Date,
  ) {}

  async heartbeat(): Promise<void> {
    this.assertUsable();
    const current = await this.readCurrentMetadata();
    if (!sameLockIdentity(current, this.metadata)) {
      throw new WorkspaceLockOwnershipError();
    }

    const heartbeat = validTimestamp(this.now());
    await this.writeLockFile(this.lockPath, JSON.stringify({ ...this.metadata, heartbeat }));
  }

  async release(): Promise<void> {
    if (this.released) {
      return;
    }

    let current: WorkspaceLockMetadata;
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
      throw new WorkspaceLockOwnershipError();
    }

    await this.removePath(this.lockPath);
    this.released = true;
  }

  private async readCurrentMetadata(): Promise<WorkspaceLockMetadata> {
    return parseLockMetadata(await this.readTextFile(this.lockPath));
  }

  private assertUsable(): void {
    if (this.released) {
      throw new WorkspaceLockOwnershipError();
    }
  }
}
