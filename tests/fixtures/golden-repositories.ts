import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { PlaybookId } from "../../src/playbooks/definitions.js";
import { withTempRepository, type RepositoryFixture } from "./temp-repository.js";

const execFile = promisify(nodeExecFile);

export const GOLDEN_PLAYBOOK_IDS = [
  "feature",
  "bug",
  "hotfix",
  "chore",
  "refactor",
  "investigation",
] as const satisfies readonly PlaybookId[];

export type GoldenRepositoryId = (typeof GOLDEN_PLAYBOOK_IDS)[number] | "dirty-tree";

type FixtureCallback<T> = (root: string) => T | PromiseLike<T>;

const DIRTY_TREE_CHANGES: RepositoryFixture = {
  "src/target.txt": "modified in the working tree\n",
  "notes/untracked.txt": "untracked working-tree file\n",
};

export function goldenRepositoryFixture(id: GoldenRepositoryId): RepositoryFixture {
  if (id === "dirty-tree") {
    return {
      "README.md": "# dirty-tree golden repository\n",
      "src/target.txt": "committed baseline\n",
    };
  }

  return {
    "README.md": `# ${id} golden repository\n`,
    [`src/${id}.txt`]: `${id} baseline\n`,
  };
}

async function git(root: string, args: readonly string[]): Promise<void> {
  await execFile("git", [...args], { cwd: root, encoding: "utf8" });
}

async function initializeGit(root: string): Promise<void> {
  await git(root, ["init", "--quiet"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Pi Workflow Test"]);
  await git(root, ["config", "commit.gpgSign", "false"]);
  await git(root, ["add", "--", "."]);
  await git(root, ["commit", "--quiet", "-m", "golden fixture"]);
  await git(root, ["branch", "-M", "main"]);
}

async function applyDirtyTree(root: string): Promise<void> {
  await Promise.all(
    Object.entries(DIRTY_TREE_CHANGES).map(async ([filePath, contents]) => {
      const target = join(root, filePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    }),
  );
}

export async function withGoldenRepository<T>(
  id: GoldenRepositoryId,
  additionalFiles: RepositoryFixture,
  callback: FixtureCallback<T>,
): Promise<T> {
  return withTempRepository(
    { ...goldenRepositoryFixture(id), ...additionalFiles },
    async (root) => {
      await initializeGit(root);
      if (id === "dirty-tree") {
        await applyDirtyTree(root);
      }
      return callback(root);
    },
  );
}
