export type RepositoryScope =
  | readonly string[]
  | Readonly<{
      paths?: readonly string[];
    }>;

export type RepositoryStatusEntry = Readonly<{
  path: string;
  index: string;
  worktree: string;
  originalPath?: string;
}>;

export type RepositoryStatus = Readonly<{
  dirty: boolean;
  changed: readonly string[];
  untracked: readonly string[];
  entries: readonly RepositoryStatusEntry[];
}>;

export type RepositoryFingerprints = Readonly<Record<string, string | null>>;

export type RepositorySnapshot = Readonly<{
  root: string;
  head: string;
  branch: string | null;
  status: RepositoryStatus;
  fingerprints: RepositoryFingerprints;
  fingerprint: string;
}>;

export type RepositoryFileDiff = Readonly<{
  path: string;
  change: "added" | "modified" | "deleted";
  beforeFingerprint: string | null;
  afterFingerprint: string | null;
  beforeStatus?: RepositoryStatusEntry;
  afterStatus?: RepositoryStatusEntry;
}>;

export type RepositoryDiff = Readonly<{
  before: RepositorySnapshot;
  after: RepositorySnapshot;
  files: readonly RepositoryFileDiff[];
  changedFiles: readonly string[];
  addedFiles: readonly string[];
  modifiedFiles: readonly string[];
  deletedFiles: readonly string[];
  beforeFingerprint: string;
  afterFingerprint: string;
  headChanged: boolean;
  branchChanged: boolean;
  statusChanged: boolean;
  fingerprintChanged: boolean;
}>;

export interface RepositoryAdapter {
  getRoot(): Promise<string>;
  getHead(): Promise<string>;
  getBranch(): Promise<string | null>;
  captureSnapshot(scope?: RepositoryScope): Promise<RepositorySnapshot>;
  diff(before: RepositorySnapshot, after: RepositorySnapshot): Promise<RepositoryDiff>;
}
