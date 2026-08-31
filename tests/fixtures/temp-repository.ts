import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type RepositoryFixture = Readonly<Record<string, string>>;

type FixtureCallback<T> = (root: string) => T | PromiseLike<T>;

function resolveFixturePath(root: string, filePath: string): string {
  const target = resolve(root, filePath);
  const relativeTarget = relative(root, target);

  if (
    isAbsolute(filePath) ||
    relativeTarget === "" ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`)
  ) {
    throw new Error(`Fixture file must stay inside the temporary repository: ${filePath}`);
  }

  return target;
}

export async function withTempRepository<T>(
  files: RepositoryFixture,
  callback: FixtureCallback<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-test-"));

  try {
    await Promise.all(
      Object.entries(files).map(async ([filePath, contents]) => {
        const target = resolveFixturePath(root, filePath);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, contents, "utf8");
      }),
    );

    return await callback(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
