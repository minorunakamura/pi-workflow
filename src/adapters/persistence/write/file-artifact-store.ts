import {
  link as nodeLink,
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  mkdtemp as nodeMkdtemp,
  readFile as nodeReadFile,
  rm as nodeRm,
  writeFile as nodeWriteFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExecutionId, RunId } from "../../../domain/primitives/ids.js";
import type {
  ArtifactContent,
  ArtifactDraft,
  ArtifactReader,
  ArtifactRedactor,
  ArtifactRef,
  ArtifactStore,
  RunRelativeArtifactPath,
  StagedArtifact,
} from "../../../ports/artifact-store.js";
import {
  artifactRunDirectory,
  assertArtifactPathType,
  assertNoSymlinkComponents,
  assertPathDoesNotExist,
  ArtifactAlreadyExistsError,
  ArtifactPathSecurityError,
  type LstatPath,
  resolveRunRelativeArtifactPath,
} from "../artifact-path.js";
import { ArtifactValidationError, normalizeArtifactContents } from "../artifact-content.js";
import { FileArtifactReader } from "../read/file-artifact-reader.js";
import type { ReadTextFile } from "../read/state-snapshot-files.js";
import { redactSecrets } from "../../../telemetry/redaction.js";

export type WriteTextFile = (path: string, contents: string) => Promise<void>;
export type MakeDirectory = (path: string) => Promise<void>;
export type MakeTempDirectory = (prefix: string) => Promise<string>;
export type RemovePath = (path: string) => Promise<void>;
export type LinkPath = (source: string, destination: string) => Promise<void>;

export type FileArtifactStoreOptions = Readonly<{
  readFile?: ReadTextFile;
  writeFile?: WriteTextFile;
  mkdir?: MakeDirectory;
  mkdtemp?: MakeTempDirectory;
  rm?: RemovePath;
  lstat?: LstatPath;
  link?: LinkPath;
  redact?: ArtifactRedactor;
}>;

const EXECUTION_ID_PATTERN = /^exec-\d+$/;
const defaultReadTextFile: ReadTextFile = (path) => nodeReadFile(path, "utf8");
const defaultWriteTextFile: WriteTextFile = (path, contents) =>
  nodeWriteFile(path, contents, "utf8");
const defaultMakeDirectory: MakeDirectory = async (path) => {
  await nodeMkdir(path, { recursive: true });
};
const defaultMakeTempDirectory: MakeTempDirectory = nodeMkdtemp;
const defaultRemovePath: RemovePath = (path) => nodeRm(path, { force: true, recursive: true });
const defaultLink: LinkPath = nodeLink;

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function validExecutionId(value: unknown): ExecutionId {
  if (typeof value !== "string" || !EXECUTION_ID_PATTERN.test(value)) {
    throw new ArtifactPathSecurityError(String(value), "must use a valid Execution ID");
  }
  return value as ExecutionId;
}

function validRunId(value: unknown): RunId {
  if (typeof value !== "string" || !/^run-\d+$/.test(value)) {
    throw new ArtifactPathSecurityError(String(value), "must use a valid Run ID");
  }
  return value as RunId;
}

function stagedValues(staged: StagedArtifact): Readonly<{
  runId: RunId;
  executionId: ExecutionId;
  path: string;
}> {
  if (typeof staged !== "object" || staged === null) {
    throw new ArtifactValidationError("Staged Artifact must be an object");
  }
  if (staged.status !== "draft") {
    throw new ArtifactValidationError("Only a staging draft can be finalized");
  }
  if (typeof staged.path !== "string" || !isAbsolute(staged.path)) {
    throw new ArtifactPathSecurityError(String(staged.path), "must be an absolute staging path");
  }
  return {
    runId: validRunId(staged.runId),
    executionId: validExecutionId(staged.executionId),
    path: staged.path,
  };
}

function stagedPath(runDirectory: string, executionId: ExecutionId, path: string): string {
  const stagingDirectory = join(runDirectory, "runtime", "staging", executionId);
  const resolvedPath = resolve(path);
  const pathRelativeToStaging = relative(stagingDirectory, resolvedPath);
  if (
    pathRelativeToStaging === "" ||
    pathRelativeToStaging === ".." ||
    pathRelativeToStaging.startsWith(`..${sep}`) ||
    isAbsolute(pathRelativeToStaging)
  ) {
    throw new ArtifactPathSecurityError(path, "must stay under runtime/staging/<execution-id>");
  }
  return resolvedPath;
}

async function cleanup(removePath: RemovePath, path: string): Promise<void> {
  try {
    await removePath(path);
  } catch {
    // A finalized file is already durable; crash-left staging is not promoted automatically.
  }
}

export class FileArtifactStore implements ArtifactStore {
  private readonly repositoryRoot: string;
  private readonly readTextFile: ReadTextFile;
  private readonly writeTextFile: WriteTextFile;
  private readonly makeDirectory: MakeDirectory;
  private readonly makeTempDirectory: MakeTempDirectory;
  private readonly removePath: RemovePath;
  private readonly lstatPath: LstatPath;
  private readonly linkPath: LinkPath;
  private readonly redactContents: ArtifactRedactor;
  private readonly reader: ArtifactReader;

  constructor(repositoryRoot: string, options: FileArtifactStoreOptions = {}) {
    this.repositoryRoot = resolve(repositoryRoot);
    this.readTextFile = options.readFile ?? defaultReadTextFile;
    this.writeTextFile = options.writeFile ?? defaultWriteTextFile;
    this.makeDirectory = options.mkdir ?? defaultMakeDirectory;
    this.makeTempDirectory = options.mkdtemp ?? defaultMakeTempDirectory;
    this.removePath = options.rm ?? defaultRemovePath;
    this.lstatPath = options.lstat ?? nodeLstat;
    this.linkPath = options.link ?? defaultLink;
    this.redactContents = options.redact ?? redactSecrets;
    this.reader = new FileArtifactReader(this.repositoryRoot, {
      readFile: this.readTextFile,
      lstat: this.lstatPath,
    });
  }

  async stage(draft: ArtifactDraft): Promise<StagedArtifact> {
    const runId = validRunId(draft.runId);
    const executionId = validExecutionId(draft.executionId);
    if (typeof draft.contents !== "string") {
      throw new ArtifactValidationError("Artifact draft contents must be text");
    }

    const runDirectory = artifactRunDirectory(this.repositoryRoot, runId);
    await assertNoSymlinkComponents(this.repositoryRoot, runDirectory, this.lstatPath);
    const stagingDirectory = join(runDirectory, "runtime", "staging", executionId);
    await assertNoSymlinkComponents(this.repositoryRoot, stagingDirectory, this.lstatPath);
    await this.makeDirectory(stagingDirectory);
    await assertNoSymlinkComponents(this.repositoryRoot, stagingDirectory, this.lstatPath);

    const draftDirectory = await this.makeTempDirectory(join(stagingDirectory, ".draft-"));
    const path = join(draftDirectory, "artifact");
    try {
      await assertNoSymlinkComponents(this.repositoryRoot, draftDirectory, this.lstatPath);
      await this.writeTextFile(path, draft.contents);
      await assertNoSymlinkComponents(this.repositoryRoot, path, this.lstatPath);
      return { runId, executionId, path, status: "draft" };
    } catch (error) {
      await cleanup(this.removePath, draftDirectory);
      throw error;
    }
  }

  async finalize(
    staged: StagedArtifact,
    destination: RunRelativeArtifactPath,
  ): Promise<ArtifactRef> {
    const values = stagedValues(staged);
    const runDirectory = artifactRunDirectory(this.repositoryRoot, values.runId);
    const draftPath = stagedPath(runDirectory, values.executionId, values.path);
    await assertNoSymlinkComponents(this.repositoryRoot, draftPath, this.lstatPath);

    const draftContents = await this.readTextFile(draftPath);
    const redactedContents = await this.redactContents(draftContents);
    if (typeof redactedContents !== "string") {
      throw new ArtifactValidationError("Artifact redactor must return text");
    }
    const normalized = normalizeArtifactContents(redactedContents);
    if (normalized.frontMatter.run_id !== values.runId) {
      throw new ArtifactValidationError(`Artifact Run ID does not match ${values.runId}`);
    }
    if (normalized.frontMatter.execution_id !== values.executionId) {
      throw new ArtifactValidationError(
        `Artifact Execution ID does not match ${values.executionId}`,
      );
    }

    const resolvedDestination = resolveRunRelativeArtifactPath(runDirectory, destination);
    assertArtifactPathType(resolvedDestination.relativePath, normalized.frontMatter.artifact.type);
    await assertNoSymlinkComponents(this.repositoryRoot, resolvedDestination.path, this.lstatPath);
    await assertPathDoesNotExist(resolvedDestination.path, this.lstatPath);
    await this.makeDirectory(dirname(resolvedDestination.path));
    await assertNoSymlinkComponents(this.repositoryRoot, resolvedDestination.path, this.lstatPath);
    await assertPathDoesNotExist(resolvedDestination.path, this.lstatPath);

    const finalizeDirectory = await this.makeTempDirectory(join(dirname(draftPath), ".finalize-"));
    const finalizedContentsPath = join(finalizeDirectory, "artifact");
    let published = false;
    try {
      await this.writeTextFile(finalizedContentsPath, normalized.contents);
      await assertNoSymlinkComponents(this.repositoryRoot, finalizedContentsPath, this.lstatPath);
      try {
        await this.linkPath(finalizedContentsPath, resolvedDestination.path);
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new ArtifactAlreadyExistsError(resolvedDestination.relativePath);
        }
        throw error;
      }
      published = true;
      return {
        runId: values.runId,
        path: resolvedDestination.relativePath,
        status: normalized.frontMatter.artifact.status,
      };
    } finally {
      await cleanup(this.removePath, finalizeDirectory);
      if (published) {
        await cleanup(this.removePath, dirname(draftPath));
      }
    }
  }

  read(ref: ArtifactRef): Promise<ArtifactContent> {
    return this.reader.read(ref);
  }
}
