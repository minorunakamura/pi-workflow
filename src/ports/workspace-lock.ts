export type WorkspaceLockMetadata = Readonly<{
  owner: string;
  process: number;
  host: string;
  acquired: string;
  heartbeat: string;
}>;

export type WorkspaceLockAcquireOptions = Readonly<{
  recoverStale?: boolean;
}>;

export interface WorkspaceLockHandle {
  readonly metadata: WorkspaceLockMetadata;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

export interface WorkspaceLock {
  acquire(options?: WorkspaceLockAcquireOptions): Promise<WorkspaceLockHandle>;
}
