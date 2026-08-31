import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  ArtifactFrontMatterV1Schema,
  type ArtifactFrontMatterV1,
} from "../../contracts/artifacts/artifact.js";

export type ParsedArtifactContents = Readonly<{
  frontMatter: ArtifactFrontMatterV1;
  body: string;
  contents: string;
}>;

export class ArtifactValidationError extends Error {
  readonly code = "ARTIFACT_VALIDATION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "ArtifactValidationError";
  }
}

export function normalizeArtifactContents(contents: string): ParsedArtifactContents {
  if (typeof contents !== "string") {
    throw new ArtifactValidationError("Artifact contents must be text");
  }

  const normalized = contents.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (match === null || match[1] === undefined) {
    throw new ArtifactValidationError("Artifact must start with YAML front matter");
  }

  const frontMatter = ArtifactFrontMatterV1Schema.parse(parseYaml(match[1]));
  const body = normalized.slice(match[0].length);
  const serializedFrontMatter = stringifyYaml(frontMatter).trimEnd();

  return {
    frontMatter,
    body,
    contents: `---\n${serializedFrontMatter}\n---\n${body}`,
  };
}
