import { lstat as nodeLstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import type { Stats } from "node:fs";
import type { RunId } from "../../domain/primitives/ids.js";
import type { RunRelativeArtifactPath } from "../../ports/artifact-store.js";

export type LstatPath = (path: string) => Promise<Stats>;

const RUN_ID_PATTERN = /^run-\d+$/;
const RESERVED_ARTIFACT_ROOTS = new Set(["events", "runtime", "state"]);
const MUTABLE_STATE_NAME = /(?:^|[-_])(current|failed|passed)(?:[-_]|$)/i;
const CANONICAL_ARTIFACT_PATHS = [
  /^request\.md$/,
  /^effective-config\.yaml$/,
  /^requirements\/requirement-v\d+\.yaml$/,
  /^analysis\/[a-z0-9]+(?:-[a-z0-9]+)*-exec-\d+\.md$/,
  /^research\/[a-z0-9]+(?:-[a-z0-9]+)*-exec-\d+\.md$/,
  /^decisions\/D-\d+-exec-\d+\.md$/,
  /^plans\/execution-plan-v\d+\.md$/,
  /^implementation\/change-set-CS-\d+\.md$/,
  /^implementation\/reconciliation-exec-\d+\.md$/,
  /^verification\/VR-\d+\.md$/,
  /^verification\/evidence\/VR-\d+\/V-\d+\.[A-Za-z0-9]+$/,
  /^reviews\/RR-\d+\.md$/,
  /^failures\/failure-\d+\.md$/,
  /^outcome\.md$/,
];
const ARTIFACT_TYPE_ROOTS = new Map([
  ["analysis", "analysis"],
  ["research", "research"],
  ["decision", "decisions"],
  ["decision-support", "decisions"],
  ["plan", "plans"],
  ["implementation", "implementation"],
  ["change-set", "implementation"],
  ["change_set", "implementation"],
  ["reconciliation", "implementation"],
  ["verification", "verification"],
  ["verification-run", "verification"],
  ["verification-evidence", "verification"],
  ["review", "reviews"],
  ["review-run", "reviews"],
  ["failure", "failures"],
]);

export class ArtifactPathSecurityError extends Error {
  readonly code = "ARTIFACT_PATH_SECURITY";

  constructor(path: string, reason = "must stay within the Run root") {
    super(`Invalid Artifact path ${path}: ${reason}`);
    this.name = "ArtifactPathSecurityError";
  }
}

export class ArtifactAlreadyExistsError extends Error {
  readonly code = "ARTIFACT_ALREADY_EXISTS";

  constructor(path: string) {
    super(`Finalized Artifact already exists: ${path}`);
    this.name = "ArtifactAlreadyExistsError";
  }
}

const defaultLstat: LstatPath = nodeLstat;

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isOutside(base: string, target: string): boolean {
  const path = relative(resolve(base), resolve(target));
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

export function artifactRunDirectory(repositoryRoot: string, runId: RunId): string {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new ArtifactPathSecurityError(String(runId), "must use a valid Run ID");
  }
  return join(resolve(repositoryRoot), ".pi", "runs", runId);
}

export function validateRunRelativeArtifactPath(path: string): readonly string[] {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\u0000") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new ArtifactPathSecurityError(String(path), "must be a relative POSIX path");
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new ArtifactPathSecurityError(path, "must not contain empty, dot, or traversal segments");
  }

  const root = segments[0];
  if (root !== undefined && RESERVED_ARTIFACT_ROOTS.has(root)) {
    throw new ArtifactPathSecurityError(path, `${root}/ is not a semantic Artifact directory`);
  }

  const filename = segments.at(-1);
  const stem = filename?.replace(/\.[^.]+$/, "") ?? "";
  if (MUTABLE_STATE_NAME.test(stem)) {
    throw new ArtifactPathSecurityError(path, "must not encode a mutable state");
  }
  if (!CANONICAL_ARTIFACT_PATHS.some((pattern) => pattern.test(path))) {
    throw new ArtifactPathSecurityError(path, "must use a canonical Artifact path");
  }

  return segments;
}

export function assertArtifactPathType(path: string, artifactType: string): void {
  const expectedRoot = ARTIFACT_TYPE_ROOTS.get(artifactType.toLowerCase());
  if (expectedRoot !== undefined && !path.startsWith(`${expectedRoot}/`)) {
    throw new ArtifactPathSecurityError(path, `must match the ${artifactType} Artifact directory`);
  }
}

export function resolveRunRelativeArtifactPath(
  runDirectory: string,
  path: string,
): Readonly<{ path: string; relativePath: RunRelativeArtifactPath }> {
  const segments = validateRunRelativeArtifactPath(path);
  const target = resolve(runDirectory, ...segments);
  if (isOutside(runDirectory, target)) {
    throw new ArtifactPathSecurityError(path);
  }
  return { path: target, relativePath: segments.join("/") };
}

export async function assertNoSymlinkComponents(
  repositoryRoot: string,
  target: string,
  lstat: LstatPath = defaultLstat,
): Promise<void> {
  const root = resolve(repositoryRoot);
  const resolvedTarget = resolve(target);
  if (isOutside(root, resolvedTarget)) {
    throw new ArtifactPathSecurityError(target);
  }

  try {
    if ((await lstat(root)).isSymbolicLink()) {
      throw new ArtifactPathSecurityError(root, "must not rely on a symlink");
    }
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }

  const targetRelative = relative(root, resolvedTarget);
  if (targetRelative === "") {
    return;
  }

  let current = root;
  for (const segment of targetRelative.split(sep)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new ArtifactPathSecurityError(current, "must not rely on a symlink");
      }
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
  }
}

export async function assertPathDoesNotExist(
  path: string,
  lstat: LstatPath = defaultLstat,
): Promise<void> {
  try {
    await lstat(path);
    throw new ArtifactAlreadyExistsError(path);
  } catch (error) {
    if (error instanceof ArtifactAlreadyExistsError) {
      throw error;
    }
    if (!isNotFound(error)) {
      throw error;
    }
  }
}
