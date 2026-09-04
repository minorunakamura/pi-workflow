import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { collectVerificationInspectionEvidence } from "../../src/adapters/repository/verification-inspector.js";
import { GitRepositoryAdapter } from "../../src/adapters/repository/git-repository-adapter.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const execFile = promisify(nodeExecFile);

async function initializeGit(root: string): Promise<void> {
  const git = (args: readonly string[]) => execFile("git", [...args], { cwd: root });
  await git(["init", "--quiet"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Pi Workflow Test"]);
  await git(["config", "commit.gpgSign", "false"]);
  await git(["add", "--", "."]);
  await git(["commit", "--quiet", "-m", "initial"]);
}

const inspectionCheck = {
  name: "依存・変更範囲の検査",
  type: "inspection",
  command: "変更差分を確認する",
  expected: "変更範囲、package.json/lockfile、追加ファイルのnode:test importを確認する",
  required: true,
} as const;

describe("verification repository inspection", () => {
  it("creates passing evidence from the actual repository state without a command", async () => {
    await withTempRepository(
      {
        "package.json": '{"private":true}\n',
        ".gitignore": ".pi/\n",
      },
      async (repositoryRoot) => {
        await initializeGit(repositoryRoot);
        const repository = new GitRepositoryAdapter(repositoryRoot);
        const baseline = await repository.captureSnapshot();
        await mkdir(join(repositoryRoot, "scripts"), { recursive: true });
        await mkdir(join(repositoryRoot, "test"), { recursive: true });
        await writeFile(join(repositoryRoot, "scripts", "greet.mjs"), "console.log('ok');\n");
        await writeFile(
          join(repositoryRoot, "test", "greet.test.mjs"),
          "import { test } from 'node:test'; test('ok', () => {});\n",
        );
        const current = await repository.captureSnapshot();
        const [inspection] = await collectVerificationInspectionEvidence({
          repositoryRoot,
          checks: [inspectionCheck],
          writeScope: ["scripts/greet.mjs", "test/greet.test.mjs"],
          baseline,
          current,
        });

        expect(inspection).toMatchObject({
          check_index: 1,
          type: "inspection",
          required: true,
          status: "passed",
          evidence: {
            source: "repository-inspection",
            inspection_performed: true,
            status: "passed",
            observed: {
              changed_files: ["scripts/greet.mjs", "test/greet.test.mjs"],
              dependency_files_changed: [],
              external_imports: [],
              node_test_import_files: ["test/greet.test.mjs"],
            },
          },
        });
      },
    );
  });

  it("records an actual inspection failure for an out-of-scope external import", async () => {
    await withTempRepository({ ".gitignore": ".pi/\n" }, async (repositoryRoot) => {
      await initializeGit(repositoryRoot);
      const repository = new GitRepositoryAdapter(repositoryRoot);
      const baseline = await repository.captureSnapshot();
      await writeFile(
        join(repositoryRoot, "feature.mjs"),
        "import external from 'not-installed'; console.log(external);\n",
      );
      const current = await repository.captureSnapshot();
      const [inspection] = await collectVerificationInspectionEvidence({
        repositoryRoot,
        checks: [inspectionCheck],
        writeScope: ["scripts/greet.mjs"],
        baseline,
        current,
      });

      expect(inspection).toMatchObject({
        status: "failed",
        evidence: {
          observed: {
            out_of_scope_files: ["feature.mjs"],
            external_imports: ["feature.mjs:not-installed"],
          },
        },
      });
    });
  });
});
