import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { FileRunLock, runLockPath } from "../../src/adapters/persistence/write/file-run-lock.js";
import {
  FileWorkspaceLock,
  workspaceLockPath,
} from "../../src/adapters/persistence/write/file-workspace-lock.js";
import type { RunId } from "../../src/domain/primitives/ids.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const RUN_ID = "run-001" as RunId;
const LIVE_LOCK_SOURCE = `
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const lockPath = process.env.PI_WORKFLOW_LOCK_PATH;
const host = process.env.PI_WORKFLOW_LOCK_HOST;
if (lockPath === undefined || host === undefined) throw new Error("lock process configuration missing");
await mkdir(dirname(lockPath), { recursive: true });
await writeFile(lockPath, JSON.stringify({
  owner: "child-lock-holder",
  process: process.pid,
  host,
  acquired: "2026-08-30T03:02:10.123Z",
  heartbeat: "2026-08-30T03:02:10.123Z"
}), { encoding: "utf8", flag: "wx" });
setInterval(() => undefined, 1_000);
`;

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    const done = () => {
      child.off("exit", done);
      child.off("error", done);
      resolve();
    };
    child.once("exit", done);
    child.once("error", done);
    if (!child.kill()) done();
  });
}

async function startLiveLockProcess(lockPath: string, host: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", LIVE_LOCK_SOURCE], {
    env: {
      ...process.env,
      PI_WORKFLOW_LOCK_PATH: lockPath,
      PI_WORKFLOW_LOCK_HOST: host,
    },
    stdio: "ignore",
  });
  let childError: Error | undefined;
  child.once("error", (error) => {
    childError = error;
  });

  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await readFile(lockPath, "utf8");
        return child;
      } catch (error) {
        if (!isNotFound(error)) throw error;
        if (childError !== undefined) throw childError;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`lock holder exited before creating its lock: ${child.exitCode}`);
        }
        await delay(10);
      }
    }
    throw new Error("timed out waiting for the live lock process");
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
}

describe("cross-platform process liveness", () => {
  it.each([
    {
      name: "Run",
      lockPath: (root: string) => runLockPath(root, RUN_ID),
      acquire: (root: string, host: string) =>
        new FileRunLock(root, { owner: "parent", host }).acquire(RUN_ID, {
          recoverStale: true,
        }),
      lockedCode: "RUN_LOCKED",
    },
    {
      name: "Workspace",
      lockPath: (root: string) => workspaceLockPath(root),
      acquire: (root: string, host: string) =>
        new FileWorkspaceLock(root, { owner: "parent", host }).acquire({ recoverStale: true }),
      lockedCode: "WORKSPACE_LOCKED",
    },
  ] as const)(
    "does not recover a live $name lock from an actual child process",
    async (fixture) => {
      const workspaceDirectory = "workspace with spaces-日本語";
      await withTempRepository({ [`${workspaceDirectory}/.keep`]: "" }, async (repositoryRoot) => {
        const workspaceRoot = join(repositoryRoot, workspaceDirectory);
        const host = hostname();
        const lockPath = fixture.lockPath(workspaceRoot);
        const child = await startLiveLockProcess(lockPath, host);

        try {
          await expect(fixture.acquire(workspaceRoot, host)).rejects.toMatchObject({
            code: fixture.lockedCode,
          });
        } finally {
          await stopProcess(child);
        }

        const recovered = await fixture.acquire(workspaceRoot, host);
        await recovered.release();
      });
    },
  );
});
