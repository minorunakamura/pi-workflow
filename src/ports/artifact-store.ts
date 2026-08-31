import type { ArtifactFrontMatterV1, ArtifactStatus } from "../contracts/artifacts/artifact.js";
import type { ExecutionId, RunId } from "../domain/primitives/ids.js";

export type RunRelativeArtifactPath = string;

export type ArtifactDraft = Readonly<{
  runId: RunId;
  executionId: ExecutionId;
  contents: string;
}>;

export type StagedArtifact = Readonly<{
  runId: RunId;
  executionId: ExecutionId;
  path: string;
  status: "draft";
}>;

export type ArtifactRef = Readonly<{
  runId: RunId;
  path: RunRelativeArtifactPath;
  status: ArtifactStatus;
}>;

export type ArtifactContent = Readonly<{
  ref: ArtifactRef;
  frontMatter: ArtifactFrontMatterV1;
  body: string;
  contents: string;
}>;

export type ArtifactRedactor = (contents: string) => string | Promise<string>;

export interface ArtifactStore {
  stage(draft: ArtifactDraft): Promise<StagedArtifact>;
  finalize(staged: StagedArtifact, destination: RunRelativeArtifactPath): Promise<ArtifactRef>;
}

export interface ArtifactReader {
  read(ref: ArtifactRef): Promise<ArtifactContent>;
}
