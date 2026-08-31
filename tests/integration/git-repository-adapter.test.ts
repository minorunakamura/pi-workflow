import { execFile as nodeExecFile } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitRepositoryAdapter } from "../../src/adapters/repository/git-repository-adapter.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const execFile = promisify(nodeExecFile);

async function git(root: string, args: readonly string[]): Promise<void> {
  await execFile("git", [...args], { cwd: root, encoding: "utf8" });
}

async function initializeGit(root: string): Promise<void> {
  await git(root, ["init", "--quiet"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Pi Workflow Test"]);
  await git(root, ["config", "commit.gpgSign", "false"]);
  await git(root, ["add", "--", "."]);
  await git(root, ["commit", "--quiet", "-m", "initial"]);
  await git(root, ["branch", "-M", "main"]);
}

describe("GitRepositoryAdapter", () => {
  it("captures repository facts and reports file changes", async () => {
    await withTempRepository({ "tracked.txt": "before\n" }, async (repositoryRoot) => {
      await initializeGit(repositoryRoot);
      const adapter = new GitRepositoryAdapter(repositoryRoot);
      const before = await adapter.captureSnapshot();

      expect(await adapter.getRoot()).toBe(await realpath(repositoryRoot));
      expect(await adapter.getHead()).toBe(before.head);
      expect(before.head).toMatch(/^[0-9a-f]{40}$/);
      expect(before.branch).toBe("main");
      expect(before.status).toEqual({ dirty: false, changed: [], untracked: [], entries: [] });
      expect(before.fingerprints["tracked.txt"]).toMatch(/^[0-9a-f]{64}$/);
      expect(before.fingerprint).toMatch(/^[0-9a-f]{64}$/);

      await writeFile(`${repositoryRoot}/tracked.txt`, "after\n", "utf8");
      await writeFile(`${repositoryRoot}/untracked.txt`, "new\n", "utf8");
      const after = await adapter.captureSnapshot();
      const diff = await adapter.diff(before, after);

      expect(after.status.changed).toEqual(["tracked.txt", "untracked.txt"]);
      expect(after.status.untracked).toEqual(["untracked.txt"]);
      expect(diff.changedFiles).toEqual(["tracked.txt", "untracked.txt"]);
      expect(diff.modifiedFiles).toEqual(["tracked.txt"]);
      expect(diff.addedFiles).toEqual(["untracked.txt"]);
      expect(diff.deletedFiles).toEqual([]);
      expect(diff.statusChanged).toBe(true);
      expect(diff.fingerprintChanged).toBe(true);
    });
  });

  it("preserves dirty and untracked facts in run and pre-Worker baselines", async () => {
    await withTempRepository({ "tracked.txt": "before\n" }, async (repositoryRoot) => {
      await initializeGit(repositoryRoot);
      await writeFile(`${repositoryRoot}/tracked.txt`, "pre-existing change\n", "utf8");
      await writeFile(`${repositoryRoot}/pre-existing.txt`, "user change\n", "utf8");

      const adapter = new GitRepositoryAdapter(repositoryRoot);
      const runBaseline = await adapter.captureSnapshot();
      const trackedBaselineFingerprint = runBaseline.fingerprints["tracked.txt"];
      const untrackedBaselineFingerprint = runBaseline.fingerprints["pre-existing.txt"];

      expect(runBaseline.status).toEqual({
        dirty: true,
        changed: ["pre-existing.txt", "tracked.txt"],
        untracked: ["pre-existing.txt"],
        entries: [
          { path: "pre-existing.txt", index: "?", worktree: "?" },
          { path: "tracked.txt", index: " ", worktree: "M" },
        ],
      });
      expect(trackedBaselineFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(untrackedBaselineFingerprint).toMatch(/^[0-9a-f]{64}$/);

      await writeFile(`${repositoryRoot}/worker-output.txt`, "workflow change\n", "utf8");
      const workerBaseline = await adapter.captureSnapshot({
        paths: ["pre-existing.txt", "tracked.txt"],
      });

      expect(workerBaseline.status).toEqual(runBaseline.status);
      expect(workerBaseline.fingerprints["tracked.txt"]).toBe(trackedBaselineFingerprint);
      expect(workerBaseline.fingerprints["pre-existing.txt"]).toBe(untrackedBaselineFingerprint);
      expect(runBaseline.status.untracked).toEqual(["pre-existing.txt"]);
      expect(runBaseline.status.changed).toEqual(["pre-existing.txt", "tracked.txt"]);
    });
  });

  it("limits status and fingerprints to the requested scope", async () => {
    await withTempRepository(
      { "inside.txt": "inside\n", "outside.txt": "outside\n" },
      async (repositoryRoot) => {
        await initializeGit(repositoryRoot);
        const adapter = new GitRepositoryAdapter(repositoryRoot);
        const before = await adapter.captureSnapshot({ paths: ["inside.txt"] });

        await writeFile(`${repositoryRoot}/outside.txt`, "changed\n", "utf8");
        const after = await adapter.captureSnapshot({ paths: ["inside.txt"] });

        expect(Object.keys(before.fingerprints)).toEqual(["inside.txt"]);
        expect(after.status).toEqual({ dirty: false, changed: [], untracked: [], entries: [] });
        await expect(adapter.diff(before, after)).resolves.toMatchObject({
          changedFiles: [],
          fingerprintChanged: false,
        });
      },
    );
  });

  it("reports a detached HEAD without making a repository decision", async () => {
    await withTempRepository({ "tracked.txt": "content\n" }, async (repositoryRoot) => {
      await initializeGit(repositoryRoot);
      const adapter = new GitRepositoryAdapter(repositoryRoot);

      await git(repositoryRoot, ["checkout", "--quiet", "--detach", "HEAD"]);

      await expect(adapter.getBranch()).resolves.toBeNull();
      await expect(adapter.captureSnapshot()).resolves.toMatchObject({ branch: null });
    });
  });

  it("rejects scope paths outside the repository", async () => {
    await withTempRepository({ "tracked.txt": "content\n" }, async (repositoryRoot) => {
      await initializeGit(repositoryRoot);
      await expect(
        new GitRepositoryAdapter(repositoryRoot).captureSnapshot({ paths: ["../outside"] }),
      ).rejects.toThrow("Invalid repository scope path");
    });
  });
});
