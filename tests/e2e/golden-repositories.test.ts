import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitRepositoryAdapter } from "../../src/adapters/repository/git-repository-adapter.js";
import {
  GOLDEN_PLAYBOOK_IDS,
  goldenRepositoryFixture,
  withGoldenRepository,
} from "../fixtures/golden-repositories.js";

describe("golden repository fixtures", () => {
  for (const playbook of GOLDEN_PLAYBOOK_IDS) {
    it(`${playbook} is reproducible and starts clean`, async () => {
      const fixture = goldenRepositoryFixture(playbook);

      await withGoldenRepository(playbook, {}, async (root) => {
        const snapshot = await new GitRepositoryAdapter(root).captureSnapshot();

        expect(snapshot.status).toEqual({
          dirty: false,
          changed: [],
          untracked: [],
          entries: [],
        });
        for (const [filePath, contents] of Object.entries(fixture)) {
          await expect(readFile(join(root, filePath), "utf8")).resolves.toBe(contents);
        }
      });
    });
  }

  it("provides a reproducible dirty-tree fixture with tracked and untracked changes", async () => {
    await withGoldenRepository("dirty-tree", {}, async (root) => {
      const snapshot = await new GitRepositoryAdapter(root).captureSnapshot();

      expect(snapshot.status).toMatchObject({
        dirty: true,
        changed: ["notes/untracked.txt", "src/target.txt"],
        untracked: ["notes/untracked.txt"],
      });
      await expect(readFile(join(root, "src/target.txt"), "utf8")).resolves.toBe(
        "modified in the working tree\n",
      );
      await expect(readFile(join(root, "notes/untracked.txt"), "utf8")).resolves.toBe(
        "untracked working-tree file\n",
      );
    });
  });
});
