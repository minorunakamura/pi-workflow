import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import type {
  RepositoryAdapter,
  RepositoryDiff,
  RepositoryFileDiff,
  RepositoryFingerprints,
  RepositoryScope,
  RepositorySnapshot,
  RepositoryStatus,
  RepositoryStatusEntry,
} from "../../ports/repository.js";

const execFile = promisify(nodeExecFile);
const MAX_BUFFER = 64 * 1024 * 1024;

type GitCommandResult = Readonly<{
  stdout: string;
  stderr: string;
}>;

export type GitCommand = (args: readonly string[], cwd: string) => Promise<GitCommandResult>;

export type GitRepositoryAdapterOptions = Readonly<{
  execute?: GitCommand;
}>;

const defaultExecute: GitCommand = async (args, cwd) => {
  const result = await execFile("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

function errorCode(error: unknown): number | string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string" ? code : undefined;
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function outputValue(output: string, name: string): string {
  const value = output.trim();
  if (value.length === 0) {
    throw new Error(`Git returned an empty ${name}`);
  }
  return value;
}

function pathOutsideRoot(root: string, path: string): boolean {
  const target = resolve(root, ...path.split("/"));
  const targetRelative = relative(root, target);
  return targetRelative === ".." || targetRelative.startsWith("../") || isAbsolute(targetRelative);
}

function validateScopePath(root: string, path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\u0000") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.split("/").some((segment) => segment === "..") ||
    pathOutsideRoot(root, path)
  ) {
    throw new Error(`Invalid repository scope path: ${String(path)}`);
  }
  return path;
}

function scopePaths(root: string, scope: RepositoryScope | undefined): readonly string[] {
  if (scope === undefined) {
    return [];
  }
  const paths: readonly string[] = Array.isArray(scope)
    ? (scope as readonly string[])
    : ((scope as { paths?: readonly string[] }).paths ?? []);
  return [...new Set(paths.map((path) => validateScopePath(root, path)))];
}

function pathspec(paths: readonly string[]): readonly string[] {
  return paths.length === 0 ? [] : ["--", ...paths];
}

function nulRecords(output: string): string[] {
  return output.split("\u0000").filter((record) => record.length > 0);
}

function parseStatus(output: string): RepositoryStatus {
  const records = nulRecords(output);
  const entries: RepositoryStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4 || record[2] !== " ") {
      throw new Error("Git returned invalid porcelain status output");
    }

    const statusCode = record.slice(0, 2);
    const path = record.slice(3);
    if (path.length === 0) {
      throw new Error("Git returned an empty status path");
    }

    const indexStatus = statusCode[0];
    const worktreeStatus = statusCode[1];
    if (indexStatus === undefined || worktreeStatus === undefined) {
      throw new Error("Git returned invalid porcelain status code");
    }

    let originalPath: string | undefined;
    if (
      indexStatus === "R" ||
      indexStatus === "C" ||
      worktreeStatus === "R" ||
      worktreeStatus === "C"
    ) {
      originalPath = records[index + 1];
      if (originalPath === undefined || originalPath.length === 0) {
        throw new Error("Git returned an incomplete rename or copy status");
      }
      index += 1;
    }

    entries.push({
      path,
      index: indexStatus,
      worktree: worktreeStatus,
      ...(originalPath === undefined ? {} : { originalPath }),
    });
  }

  entries.sort((left, right) => left.path.localeCompare(right.path));
  const changed = entries.map(({ path }) => path);
  const untracked = entries
    .filter(({ index, worktree }) => index === "?" && worktree === "?")
    .map(({ path }) => path);

  return { dirty: entries.length > 0, changed, untracked, entries };
}

async function fileFingerprint(path: string): Promise<string | null> {
  try {
    const stats = await lstat(path);
    const contents = stats.isSymbolicLink()
      ? Buffer.from(`symlink:${await readlink(path)}`)
      : stats.isFile()
        ? await readFile(path)
        : undefined;
    return contents === undefined ? null : createHash("sha256").update(contents).digest("hex");
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

function aggregateFingerprint(fingerprints: RepositoryFingerprints): string {
  const hash = createHash("sha256");
  for (const [path, fingerprint] of Object.entries(fingerprints).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash
      .update(path)
      .update("\u0000")
      .update(fingerprint ?? "<missing>")
      .update("\u0000");
  }
  return hash.digest("hex");
}

function statusMap(status: RepositoryStatus): ReadonlyMap<string, RepositoryStatusEntry> {
  return new Map(status.entries.map((entry) => [entry.path, entry]));
}

function statusSignature(entry: RepositoryStatusEntry | undefined): string {
  return entry === undefined
    ? ""
    : `${entry.index}${entry.worktree}\u0000${entry.originalPath ?? ""}`;
}

function fileChange(
  before: string | null | undefined,
  after: string | null | undefined,
): RepositoryFileDiff["change"] {
  if ((before === null || before === undefined) && after !== null && after !== undefined) {
    return "added";
  }
  if (before !== null && before !== undefined && (after === null || after === undefined)) {
    return "deleted";
  }
  return "modified";
}

export class GitRepositoryAdapter implements RepositoryAdapter {
  private readonly cwd: string;
  private readonly execute: GitCommand;

  constructor(repositoryRoot = process.cwd(), options: GitRepositoryAdapterOptions = {}) {
    if (repositoryRoot.trim().length === 0) {
      throw new Error("GitRepositoryAdapter repository root must not be empty");
    }
    this.cwd = resolve(repositoryRoot);
    this.execute = options.execute ?? defaultExecute;
  }

  async getRoot(): Promise<string> {
    return resolve(
      outputValue(await this.git(["rev-parse", "--show-toplevel"]), "repository root"),
    );
  }

  async getHead(): Promise<string> {
    return outputValue(await this.git(["rev-parse", "HEAD"]), "HEAD");
  }

  async getBranch(): Promise<string | null> {
    try {
      const branch = (await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
      return branch.length === 0 ? null : branch;
    } catch (error) {
      if (errorCode(error) === 1 || errorCode(error) === "1") {
        return null;
      }
      throw error;
    }
  }

  async captureSnapshot(scope?: RepositoryScope): Promise<RepositorySnapshot> {
    const root = await this.getRoot();
    const paths = scopePaths(root, scope);
    const args = pathspec(paths);
    const [head, branch, status, fingerprints] = await Promise.all([
      this.getHead(),
      this.getBranch(),
      this.captureStatus(root, args),
      this.captureFingerprints(root, args),
    ]);

    return {
      root,
      head,
      branch,
      status,
      fingerprints,
      fingerprint: aggregateFingerprint(fingerprints),
    };
  }

  async diff(before: RepositorySnapshot, after: RepositorySnapshot): Promise<RepositoryDiff> {
    if (resolve(before.root) !== resolve(after.root)) {
      throw new Error("Repository snapshots must have the same root");
    }

    const beforeStatuses = statusMap(before.status);
    const afterStatuses = statusMap(after.status);
    const paths = new Set([
      ...Object.keys(before.fingerprints),
      ...Object.keys(after.fingerprints),
      ...before.status.changed,
      ...after.status.changed,
    ]);
    const files = [...paths]
      .sort((left, right) => left.localeCompare(right))
      .flatMap((path): RepositoryFileDiff[] => {
        const beforeFingerprint = before.fingerprints[path];
        const afterFingerprint = after.fingerprints[path];
        const beforeStatus = beforeStatuses.get(path);
        const afterStatus = afterStatuses.get(path);
        if (
          beforeFingerprint === afterFingerprint &&
          statusSignature(beforeStatus) === statusSignature(afterStatus)
        ) {
          return [];
        }

        return [
          {
            path,
            change: fileChange(beforeFingerprint, afterFingerprint),
            beforeFingerprint: beforeFingerprint ?? null,
            afterFingerprint: afterFingerprint ?? null,
            ...(beforeStatus === undefined ? {} : { beforeStatus }),
            ...(afterStatus === undefined ? {} : { afterStatus }),
          },
        ];
      });

    const changedFiles = files.map(({ path }) => path);
    return {
      before,
      after,
      files,
      changedFiles,
      addedFiles: files.filter(({ change }) => change === "added").map(({ path }) => path),
      modifiedFiles: files.filter(({ change }) => change === "modified").map(({ path }) => path),
      deletedFiles: files.filter(({ change }) => change === "deleted").map(({ path }) => path),
      beforeFingerprint: before.fingerprint,
      afterFingerprint: after.fingerprint,
      headChanged: before.head !== after.head,
      branchChanged: before.branch !== after.branch,
      statusChanged:
        before.status.dirty !== after.status.dirty ||
        files.some(
          ({ beforeStatus, afterStatus }) =>
            statusSignature(beforeStatus) !== statusSignature(afterStatus),
        ),
      fingerprintChanged: before.fingerprint !== after.fingerprint,
    };
  }

  private async git(args: readonly string[], cwd = this.cwd): Promise<string> {
    return (await this.execute(args, cwd)).stdout;
  }

  private async captureStatus(root: string, args: readonly string[]): Promise<RepositoryStatus> {
    return parseStatus(
      await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all", ...args], root),
    );
  }

  private async captureFingerprints(
    root: string,
    args: readonly string[],
  ): Promise<RepositoryFingerprints> {
    const output = await this.git(
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z", ...args],
      root,
    );
    const paths = [...new Set(nulRecords(output))].sort((left, right) => left.localeCompare(right));
    const entries = await Promise.all(
      paths.map(async (path) => {
        const target = resolve(root, ...path.split("/"));
        if (pathOutsideRoot(root, path)) {
          throw new Error(`Git returned a path outside the repository: ${path}`);
        }
        return [path, await fileFingerprint(target)] as const;
      }),
    );
    return Object.fromEntries(entries);
  }
}
