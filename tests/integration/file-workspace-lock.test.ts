import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileWorkspaceLock,
  WorkspaceLockedError,
  WorkspaceLockOwnershipError,
  workspaceLockPath,
} from "../../src/adapters/persistence/write/file-workspace-lock.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

function lockFile(metadata: Record<string, unknown>): Record<string, string> {
  return { ".pi/workspace.lock": JSON.stringify(metadata) };
}

describe("FileWorkspaceLock", () => {
  it("permits one owner and records the required metadata", async () => {
    await withTempRepository({}, async (repositoryRoot) => {
      const first = new FileWorkspaceLock(repositoryRoot, { owner: "owner-a" });
      const second = new FileWorkspaceLock(repositoryRoot, { owner: "owner-b" });
      const handle = await first.acquire();

      await expect(second.acquire()).rejects.toMatchObject({ code: "WORKSPACE_LOCKED" });
      const metadata = JSON.parse(
        await readFile(workspaceLockPath(repositoryRoot), "utf8"),
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
      const replacement = await second.acquire();
      await replacement.release();
    });
  });

  it("requires explicit stale recovery and never recovers a live lock", async () => {
    const metadata = {
      owner: "owner-a",
      process: 12345,
      host: "test-host",
      acquired: "2026-08-30T03:02:10.123Z",
      heartbeat: "2026-08-30T03:02:10.123Z",
    };

    await withTempRepository(lockFile(metadata), async (repositoryRoot) => {
      const staleLock = new FileWorkspaceLock(repositoryRoot, {
        owner: "owner-b",
        host: "test-host",
        processAlive: () => false,
      });

      await expect(staleLock.acquire()).rejects.toBeInstanceOf(WorkspaceLockedError);
      const recovered = await staleLock.acquire({ recoverStale: true });
      await recovered.release();
    });

    await withTempRepository(
      lockFile({ ...metadata, process: process.pid }),
      async (repositoryRoot) => {
        const liveLock = new FileWorkspaceLock(repositoryRoot, {
          owner: "owner-b",
          host: "test-host",
          processAlive: () => true,
        });

        await expect(liveLock.acquire({ recoverStale: true })).rejects.toMatchObject({
          code: "WORKSPACE_LOCKED",
        });
        await expect(readFile(workspaceLockPath(repositoryRoot), "utf8")).resolves.toBe(
          JSON.stringify({ ...metadata, process: process.pid }),
        );
      },
    );
  });

  it("does not release a lock after ownership changes", async () => {
    await withTempRepository({}, async (repositoryRoot) => {
      const handle = await new FileWorkspaceLock(repositoryRoot, { owner: "owner-a" }).acquire();
      const replacement = {
        ...handle.metadata,
        owner: "owner-b",
      };
      await writeFile(workspaceLockPath(repositoryRoot), JSON.stringify(replacement), "utf8");

      await expect(handle.release()).rejects.toBeInstanceOf(WorkspaceLockOwnershipError);
      await expect(readFile(workspaceLockPath(repositoryRoot), "utf8")).resolves.toBe(
        JSON.stringify(replacement),
      );
    });
  });

  it("uses native paths and process liveness for roots with spaces", async () => {
    await withTempRepository(
      { "workspace with spaces-日本語/.keep": "" },
      async (repositoryRoot) => {
        const nestedRoot = join(repositoryRoot, "workspace with spaces-日本語");
        const first = new FileWorkspaceLock(nestedRoot, {
          owner: "owner-a",
          host: hostname(),
        });
        const handle = await first.acquire();

        expect(workspaceLockPath(nestedRoot)).toBe(join(nestedRoot, ".pi", "workspace.lock"));
        await expect(
          new FileWorkspaceLock(nestedRoot, {
            owner: "owner-b",
            host: hostname(),
          }).acquire({ recoverStale: true }),
        ).rejects.toMatchObject({ code: "WORKSPACE_LOCKED" });

        await handle.release();
      },
    );
  });
});
