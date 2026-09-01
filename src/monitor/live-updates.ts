import { watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { RunIndexer, type RunIndexUpdate } from "./indexer/sqlite-run-indexer.js";

export type MonitorRunUpdated = Readonly<
  RunIndexUpdate & {
    type: "run-updated";
  }
>;

export type MonitorDegraded = Readonly<{
  type: "monitor-degraded";
  message: string;
}>;

export type MonitorNotification = MonitorRunUpdated | MonitorDegraded;
export type MonitorUpdateListener = (notification: MonitorNotification) => void;

export class MonitorUpdateHub {
  private readonly listeners = new Set<MonitorUpdateListener>();

  subscribe(listener: MonitorUpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(notification: MonitorNotification): void {
    for (const listener of this.listeners) {
      try {
        listener(notification);
      } catch {
        // A disconnected SSE client must not affect other subscribers.
      }
    }
  }
}

type WatchDirectory = (path: string, recursive: boolean, onChange: () => void) => FSWatcher;

const defaultWatchDirectory: WatchDirectory = (path, recursive, onChange) =>
  watch(path, { recursive }, () => onChange());

export type MonitorLiveUpdaterOptions = Readonly<{
  indexer?: RunIndexer;
  hub?: MonitorUpdateHub;
  reconciliationIntervalMs?: number;
  hintDebounceMs?: number;
  initialReconcile?: boolean;
  watch?: boolean;
  watchDirectory?: WatchDirectory;
}>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveMilliseconds(value: number | undefined, name: string, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

export class MonitorLiveUpdater {
  readonly hub: MonitorUpdateHub;

  private readonly indexer: RunIndexer;
  private readonly ownsIndexer: boolean;
  private readonly runsRoot: string;
  private readonly reconciliationIntervalMs: number;
  private readonly hintDebounceMs: number;
  private readonly initialReconcile: boolean;
  private readonly watchEnabled: boolean;
  private readonly watchDirectory: WatchDirectory;
  private started = false;
  private closed = false;
  private interval: ReturnType<typeof setInterval> | undefined;
  private hintTimer: ReturnType<typeof setTimeout> | undefined;
  private watcher: FSWatcher | undefined;
  private activeReconciliation: Promise<readonly RunIndexUpdate[]> | undefined;
  private reconciliationQueued = false;

  constructor(repositoryRoot: string, options: MonitorLiveUpdaterOptions = {}) {
    const root = resolve(repositoryRoot);
    this.indexer = options.indexer ?? new RunIndexer(root);
    this.ownsIndexer = options.indexer === undefined;
    this.hub = options.hub ?? new MonitorUpdateHub();
    this.runsRoot = join(root, ".pi", "runs");
    this.reconciliationIntervalMs = positiveMilliseconds(
      options.reconciliationIntervalMs,
      "reconciliationIntervalMs",
      1_000,
    );
    this.hintDebounceMs = positiveMilliseconds(options.hintDebounceMs, "hintDebounceMs", 25);
    this.initialReconcile = options.initialReconcile ?? true;
    this.watchEnabled = options.watch ?? true;
    this.watchDirectory = options.watchDirectory ?? defaultWatchDirectory;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("MonitorLiveUpdater is closed");
    if (this.started) return;

    this.started = true;
    if (this.initialReconcile && !this.indexer.hasIndexedRuns()) await this.reconcile();
    if (!this.started) return;

    this.interval = setInterval(() => {
      void this.reconcile();
    }, this.reconciliationIntervalMs);
    this.interval.unref?.();

    if (this.watchEnabled) this.openWatcher();
  }

  async reconcile(): Promise<readonly RunIndexUpdate[]> {
    if (this.activeReconciliation !== undefined) {
      this.reconciliationQueued = true;
      return this.activeReconciliation;
    }

    const current = this.indexer
      .indexWithUpdates()
      .then((result) => {
        for (const update of result.updates) {
          this.hub.publish({ type: "run-updated", ...update });
        }
        return result.updates;
      })
      .catch((error: unknown) => {
        this.hub.publish({ type: "monitor-degraded", message: errorMessage(error) });
        return [] as readonly RunIndexUpdate[];
      });
    this.activeReconciliation = current;

    try {
      return await current;
    } finally {
      if (this.activeReconciliation === current) {
        this.activeReconciliation = undefined;
        if (this.reconciliationQueued && this.started) {
          this.reconciliationQueued = false;
          void this.reconcile();
        } else {
          this.reconciliationQueued = false;
        }
      }
    }
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.reconciliationQueued = false;

    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    if (this.hintTimer !== undefined) {
      clearTimeout(this.hintTimer);
      this.hintTimer = undefined;
    }
    this.watcher?.close();
    this.watcher = undefined;

    const active = this.activeReconciliation;
    if (active !== undefined) {
      void active.finally(() => this.closeIndexer());
    } else {
      this.closeIndexer();
    }
  }

  private closeIndexer(): void {
    if (this.ownsIndexer) this.indexer.close();
  }

  private openWatcher(): void {
    for (const recursive of [true, false]) {
      try {
        const watcher = this.watchDirectory(this.runsRoot, recursive, () => this.hint());
        this.watcher = watcher;
        watcher.on("error", () => {
          if (this.watcher !== watcher) return;
          watcher.close();
          this.watcher = undefined;
        });
        return;
      } catch {
        // Periodic reconciliation remains the fallback when watching is unavailable.
      }
    }
  }

  private hint(): void {
    if (!this.started || this.hintTimer !== undefined) return;
    this.hintTimer = setTimeout(() => {
      this.hintTimer = undefined;
      void this.reconcile();
    }, this.hintDebounceMs);
    this.hintTimer.unref?.();
  }
}
