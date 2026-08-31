import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecutionId, RunId } from "../../src/domain/primitives/ids.js";
import {
  ArtifactPathSecurityError,
  ArtifactAlreadyExistsError,
} from "../../src/adapters/persistence/artifact-path.js";
import { FileArtifactStore } from "../../src/adapters/persistence/write/file-artifact-store.js";
import type { ArtifactRef } from "../../src/ports/artifact-store.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const RUN_ID = "run-001" as RunId;
const EXECUTION_ID = "exec-001" as ExecutionId;
const RUN_DIRECTORY = [".pi", "runs", RUN_ID].join("/");

function artifactContents(
  status: "complete" | "partial" = "complete",
  body = "summary",
  type = "analysis",
) {
  return `---
schema_version: 1
run_id: ${RUN_ID}
step_id: step-001
execution_id: ${EXECUTION_ID}
execution_state_revision: 1
agent:
  id: worker
  version: 1
artifact:
  type: ${type}
  status: ${status}
created_at: "2026-08-30T03:02:10.123+09:00"
skills: []
---
${body}`;
}

describe("FileArtifactStore", () => {
  it("stages, validates, redacts, and atomically finalizes an Artifact", async () => {
    await withTempRepository({}, async (repositoryRoot) => {
      const store = new FileArtifactStore(repositoryRoot);
      const staged = await store.stage({
        runId: RUN_ID,
        executionId: EXECUTION_ID,
        contents: artifactContents("complete", "api_key: top-secret\nsummary"),
      });

      expect(staged.status).toBe("draft");
      await expect(readFile(staged.path, "utf8")).resolves.toContain("top-secret");

      const ref = await store.finalize(staged, "analysis/security-exec-001.md");
      expect(ref).toEqual({
        runId: RUN_ID,
        path: "analysis/security-exec-001.md",
        status: "complete",
      });

      await expect(store.read(ref)).resolves.toMatchObject({
        ref,
        frontMatter: { artifact: { status: "complete" } },
        body: "api_key: [REDACTED_SECRET]\nsummary",
      });
      await expect(
        readFile(join(repositoryRoot, RUN_DIRECTORY, ref.path), "utf8"),
      ).resolves.toContain("[REDACTED_SECRET]");
      expect(existsSync(staged.path)).toBe(false);
    });
  });

  it("keeps a finalized partial Artifact distinct from a staging draft", async () => {
    await withTempRepository({}, async (repositoryRoot) => {
      const store = new FileArtifactStore(repositoryRoot);
      const staged = await store.stage({
        runId: RUN_ID,
        executionId: EXECUTION_ID,
        contents: artifactContents("partial", "incomplete", "research"),
      });

      const ref = await store.finalize(staged, "research/incomplete-exec-001.md");

      expect(staged.status).toBe("draft");
      expect(ref.status).toBe("partial");
      await expect(store.read(ref)).resolves.toMatchObject({ body: "incomplete" });
      await expect(
        store.read({
          runId: RUN_ID,
          path: "runtime/staging/exec-001/artifact",
          status: "partial",
        }),
      ).rejects.toBeInstanceOf(ArtifactPathSecurityError);
      await expect(store.read(staged as unknown as ArtifactRef)).rejects.toThrow(
        /finalized status/,
      );
    });
  });

  it("rejects malformed staged content before creating a finalized path", async () => {
    await withTempRepository({}, async (repositoryRoot) => {
      const store = new FileArtifactStore(repositoryRoot);
      const staged = await store.stage({
        runId: RUN_ID,
        executionId: EXECUTION_ID,
        contents: "draft without front matter",
      });

      await expect(store.finalize(staged, "analysis/invalid-exec-001.md")).rejects.toThrow(
        /front matter/,
      );
      expect(
        existsSync(join(repositoryRoot, RUN_DIRECTORY, "analysis", "invalid-exec-001.md")),
      ).toBe(false);
    });
  });

  it("rejects overwriting an existing finalized path and preserves its content", async () => {
    await withTempRepository({}, async (repositoryRoot) => {
      const store = new FileArtifactStore(repositoryRoot);
      const first = await store.finalize(
        await store.stage({
          runId: RUN_ID,
          executionId: EXECUTION_ID,
          contents: artifactContents("complete", "first"),
        }),
        "analysis/immutable-exec-001.md",
      );
      const second = await store.stage({
        runId: RUN_ID,
        executionId: EXECUTION_ID,
        contents: artifactContents("complete", "second"),
      });

      await expect(store.finalize(second, first.path)).rejects.toBeInstanceOf(
        ArtifactAlreadyExistsError,
      );
      await expect(store.read(first)).resolves.toMatchObject({ body: "first" });
    });
  });

  it("rejects traversal and symlink escapes", async () => {
    await withTempRepository({}, async (repositoryRoot) => {
      const store = new FileArtifactStore(repositoryRoot);
      const traversalDraft = await store.stage({
        runId: RUN_ID,
        executionId: EXECUTION_ID,
        contents: artifactContents(),
      });

      await expect(store.finalize(traversalDraft, "../outside.md")).rejects.toBeInstanceOf(
        ArtifactPathSecurityError,
      );

      const analysisDirectory = join(repositoryRoot, RUN_DIRECTORY, "analysis");
      const outsidePath = join(repositoryRoot, "outside.txt");
      await mkdir(analysisDirectory, { recursive: true });
      await writeFile(outsidePath, "outside", "utf8");
      await symlink(outsidePath, join(analysisDirectory, "escape.md"));

      const symlinkDraft = await store.stage({
        runId: RUN_ID,
        executionId: EXECUTION_ID,
        contents: artifactContents(),
      });
      await expect(store.finalize(symlinkDraft, "analysis/escape.md")).rejects.toBeInstanceOf(
        ArtifactPathSecurityError,
      );
      await expect(readFile(outsidePath, "utf8")).resolves.toBe("outside");
    });
  });
});
