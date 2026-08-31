import type { RunId } from "../domain/primitives/ids.js";

export type RunLockMetadata = Readonly<{
  owner: string;
  process: number;
  host: string;
  acquired: string;
  heartbeat: string;
}>;

export type RunLockAcquireOptions = Readonly<{
  recoverStale?: boolean;
}>;

export interface RunLockHandle {
  readonly metadata: RunLockMetadata;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

export interface RunLock {
  acquire(runId: RunId, options?: RunLockAcquireOptions): Promise<RunLockHandle>;
}
