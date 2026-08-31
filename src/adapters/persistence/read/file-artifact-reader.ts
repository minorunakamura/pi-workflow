import { lstat as nodeLstat, readFile as nodeReadFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ArtifactStatus } from "../../../contracts/artifacts/artifact.js";
import { ARTIFACT_STATUSES } from "../../../contracts/artifacts/artifact.js";
import type { RunId } from "../../../domain/primitives/ids.js";
import type {
  ArtifactContent,
  ArtifactReader,
  ArtifactRef,
} from "../../../ports/artifact-store.js";
import {
  artifactRunDirectory,
  assertArtifactPathType,
  assertNoSymlinkComponents,
  type LstatPath,
  resolveRunRelativeArtifactPath,
} from "../artifact-path.js";
import { normalizeArtifactContents, ArtifactValidationError } from "../artifact-content.js";
import type { ReadTextFile } from "./state-snapshot-files.js";

export type FileArtifactReaderOptions = Readonly<{
  readFile?: ReadTextFile;
  lstat?: LstatPath;
}>;

const defaultReadTextFile: ReadTextFile = (path) => nodeReadFile(path, "utf8");
const defaultLstat: LstatPath = nodeLstat;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRunId(value: unknown): RunId {
  if (typeof value !== "string" || !/^run-\d+$/.test(value)) {
    throw new ArtifactValidationError("Artifact reference must contain a valid Run ID");
  }
  return value as RunId;
}

function validStatus(value: unknown): ArtifactStatus {
  if (typeof value !== "string" || !(ARTIFACT_STATUSES as readonly string[]).includes(value)) {
    throw new ArtifactValidationError("Artifact reference must contain a finalized status");
  }
  return value as ArtifactStatus;
}

function referenceValues(ref: unknown): Readonly<{
  runId: RunId;
  path: string;
  status: ArtifactStatus;
}> {
  if (!isRecord(ref)) {
    throw new ArtifactValidationError("Artifact reference must be an object");
  }
  const runId = validRunId(ref.runId);
  const path = ref.path;
  if (typeof path !== "string") {
    throw new ArtifactValidationError("Artifact reference must contain a path");
  }
  const status = validStatus(ref.status);
  return { runId, path, status };
}

export class FileArtifactReader implements ArtifactReader {
  private readonly repositoryRoot: string;
  private readonly readTextFile: ReadTextFile;
  private readonly lstatPath: LstatPath;

  constructor(repositoryRoot: string, options: FileArtifactReaderOptions = {}) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.readTextFile = options.readFile ?? defaultReadTextFile;
    this.lstatPath = options.lstat ?? defaultLstat;
  }

  async read(ref: ArtifactRef): Promise<ArtifactContent> {
    const values = referenceValues(ref);
    const runDirectory = artifactRunDirectory(this.repositoryRoot, values.runId);
    const resolved = resolveRunRelativeArtifactPath(runDirectory, values.path);

    await assertNoSymlinkComponents(this.repositoryRoot, resolved.path, this.lstatPath);
    const stats = await this.lstatPath(resolved.path);
    if (!stats.isFile()) {
      throw new ArtifactValidationError(`Artifact path is not a regular file: ${values.path}`);
    }

    const contents = await this.readTextFile(resolved.path);
    const parsed = normalizeArtifactContents(contents);
    assertArtifactPathType(resolved.relativePath, parsed.frontMatter.artifact.type);
    if (parsed.frontMatter.run_id !== values.runId) {
      throw new ArtifactValidationError(`Artifact Run ID does not match ${values.runId}`);
    }
    if (parsed.frontMatter.artifact.status !== values.status) {
      throw new ArtifactValidationError("Artifact reference status does not match front matter");
    }

    return {
      ref: { runId: values.runId, path: resolved.relativePath, status: values.status },
      frontMatter: parsed.frontMatter,
      body: parsed.body,
      contents,
    };
  }
}
