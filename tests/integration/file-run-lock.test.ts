import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileRunLock,
  RunLockedError,
  runLockPath,
} from "../../src/adapters/persistence/write/file-run-lock.js";
import type { RunId } from "../../src/domain/primitives/ids.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const RUN_ID = "run-001" as RunId;

function lockFile(metadata: Record<string, unknown>): Record<string, string> {
  return { [`.pi/runs/${RUN_ID}/run.lock`]: JSON.stringify(metadata) };
}

describe("FileRunLock", () => {
  it("permits one owner and records the required metadata", async () => {
    await withTempRepository({}, async (repositoryRoot) => {
      const first = new FileRunLock(repositoryRoot, { owner: "owner-a" });
      const second = new FileRunLock(repositoryRoot, { owner: "owner-b" });
      const handle = await first.acquire(RUN_ID);

      await expect(second.acquire(RUN_ID)).rejects.toMatchObject({ code: "RUN_LOCKED" });
      await expect(readFile(runLockPath(repositoryRoot, RUN_ID), "utf8")).resolves.toContain(
        '"owner":"owner-a"',
      );
      const metadata = JSON.parse(
        await readFile(runLockPath(repositoryRoot, RUN_ID), "utf8"),
      ) as Record<string, unknown>;
      expect(metadata).toEqual(
        expect.objectContaining({
          owner: "owner-a",
          process: process.pid,
          host: hostname(),
        }),
      );
      expect(metadata.acquired).toEqual(expect.any(String));
      expect(metadata.heartbeat).toEqual(expect.any(String));

      await handle.release();
      const replacement = await second.acquire(RUN_ID);
      await replacement.release();
    });
  });

  it("requires explicit stale recovery and does not recover a live process lock", async () => {
    const metadata = {
      owner: "owner-a",
      process: 12345,
      host: "test-host",
      acquired: "2026-08-30T03:02:10.123Z",
      heartbeat: "2026-08-30T03:02:10.123Z",
    };

    await withTempRepository(lockFile(metadata), async (repositoryRoot) => {
      const staleLock = new FileRunLock(repositoryRoot, {
        owner: "owner-b",
        host: "test-host",
        processAlive: () => false,
      });

      await expect(staleLock.acquire(RUN_ID)).rejects.toBeInstanceOf(RunLockedError);
      const recovered = await staleLock.acquire(RUN_ID, { recoverStale: true });
      await recovered.release();
    });

    await withTempRepository(
      lockFile({ ...metadata, process: process.pid }),
      async (repositoryRoot) => {
        const liveLock = new FileRunLock(repositoryRoot, {
          owner: "owner-b",
          host: "test-host",
          processAlive: () => true,
        });

        await expect(liveLock.acquire(RUN_ID, { recoverStale: true })).rejects.toMatchObject({
          code: "RUN_LOCKED",
        });
        await expect(readFile(runLockPath(repositoryRoot, RUN_ID), "utf8")).resolves.toBe(
          JSON.stringify({ ...metadata, process: process.pid }),
        );
      },
    );
  });

  it("uses native paths and process liveness for roots with spaces", async () => {
    await withTempRepository(
      { "workspace with spaces-日本語/.keep": "" },
      async (repositoryRoot) => {
        const nestedRoot = join(repositoryRoot, "workspace with spaces-日本語");
        const first = new FileRunLock(nestedRoot, {
          owner: "owner-a",
          host: hostname(),
        });
        const handle = await first.acquire(RUN_ID);

        expect(runLockPath(nestedRoot, RUN_ID)).toBe(
          join(nestedRoot, ".pi", "runs", RUN_ID, "run.lock"),
        );
        await expect(
          new FileRunLock(nestedRoot, { owner: "owner-b", host: hostname() }).acquire(RUN_ID, {
            recoverStale: true,
          }),
        ).rejects.toMatchObject({ code: "RUN_LOCKED" });

        await handle.release();
      },
    );
  });
});
