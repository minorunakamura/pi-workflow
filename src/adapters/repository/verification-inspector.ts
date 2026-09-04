import { readFile, realpath } from "node:fs/promises";
import { builtinModules } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  JsonObject,
  JsonValue,
  VerificationInspectionEvidenceV1,
} from "../../contracts/execution/agent-execution.js";
import type { RepositorySnapshot } from "../../ports/repository.js";

const DEPENDENCY_FILES = new Set([
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const SOURCE_FILE = /\.(?:cjs|js|mjs|cts|ts|mts|tsx)$/u;
const IMPORT_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/gu,
  /\bimport\s*["']([^"']+)["']/gu,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
] as const;
const INSPECTION_INTENT = /(?:dependency|dependenc|依存)/iu;
const SCOPE_INTENT = /(?:scope|diff|変更|差分|範囲)/iu;
const NODE_TEST_INTENT = /node:test/iu;

type InspectionInput = Readonly<{
  repositoryRoot: string;
  checks: readonly JsonValue[];
  writeScope: readonly string[];
  baseline?: RepositorySnapshot;
  current: RepositorySnapshot;
  preExistingPaths?: readonly string[];
}>;

type InspectionCheck = Readonly<{
  index: number;
  type: "inspection" | "manual";
  required: boolean;
  description: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function inspectionCheck(value: JsonValue, index: number): InspectionCheck | undefined {
  if (!isRecord(value)) return undefined;
  const description = [value.name, value.check, value.command, value.expected]
    .map(stringValue)
    .filter((entry): entry is string => entry !== undefined)
    .join(" ");
  const type =
    value.type === "manual"
      ? "manual"
      : value.type === "inspection" ||
          (value.type === undefined &&
            /(?:inspection|inspect|diff|dependency|依存|変更|差分|ファイル内容|package|lockfile|import|scope)/iu.test(
              description,
            ))
        ? "inspection"
        : undefined;
  if (type === undefined) return undefined;
  const required = typeof value.required === "boolean" ? value.required : true;
  return { index: index + 1, type, required, description };
}

function safePath(root: string, path: string): string | undefined {
  if (path.length === 0 || path.includes("\u0000") || path.includes("\\") || isAbsolute(path)) {
    return undefined;
  }
  const target = resolve(root, ...path.split("/"));
  const within = relative(resolve(root), target);
  return within === "" || within === ".." || within.startsWith("../") || isAbsolute(within)
    ? undefined
    : target;
}

function statusSignature(
  value: RepositorySnapshot["status"]["entries"][number] | undefined,
): string {
  return value === undefined
    ? ""
    : `${value.index}${value.worktree}\u0000${value.originalPath ?? ""}`;
}

function changedFiles(
  baseline: RepositorySnapshot,
  current: RepositorySnapshot,
): readonly string[] {
  const beforeStatus = new Map(baseline.status.entries.map((entry) => [entry.path, entry]));
  const afterStatus = new Map(current.status.entries.map((entry) => [entry.path, entry]));
  const paths = new Set([
    ...Object.keys(baseline.fingerprints),
    ...Object.keys(current.fingerprints),
    ...baseline.status.changed,
    ...current.status.changed,
  ]);
  return [...paths]
    .filter((path) => path !== ".pi" && !path.startsWith(".pi/"))
    .filter(
      (path) =>
        (baseline.fingerprints[path] ?? null) !== (current.fingerprints[path] ?? null) ||
        statusSignature(beforeStatus.get(path)) !== statusSignature(afterStatus.get(path)),
    )
    .sort((left, right) => left.localeCompare(right));
}

function dependencyFile(path: string): boolean {
  return DEPENDENCY_FILES.has(path.split("/").at(-1) ?? "");
}

function importsIn(contents: string): readonly string[] {
  const imports = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of contents.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) imports.add(specifier);
    }
  }
  return [...imports].sort((left, right) => left.localeCompare(right));
}

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || builtinModules.includes(specifier);
}

function externalImports(specifiers: readonly string[]): readonly string[] {
  return specifiers.filter(
    (specifier) =>
      !specifier.startsWith(".") && !specifier.startsWith("/") && !isBuiltin(specifier),
  );
}

async function readRepositoryFile(root: string, path: string): Promise<string> {
  const target = safePath(root, path);
  if (target === undefined) throw new Error("repository path is outside the approved root");
  const actual = await realpath(target);
  const within = relative(await realpath(root), actual);
  if (within === ".." || within.startsWith("../") || isAbsolute(within)) {
    throw new Error("repository path resolves outside the approved root");
  }
  return readFile(actual, "utf8");
}

function evidence(
  check: InspectionCheck,
  status: VerificationInspectionEvidenceV1["status"],
  observed: JsonObject,
  refs: readonly string[],
  reason?: string,
): VerificationInspectionEvidenceV1 {
  return {
    check_index: check.index,
    type: check.type,
    required: check.required,
    status,
    evidence: {
      source: "repository-inspection",
      inspection_performed: true,
      status,
      evidence_refs: refs,
      ...(check.description.length === 0 ? {} : { expected: check.description }),
      observed,
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

/** Collects deterministic repository evidence for inspection/manual Plan checks. */
export async function collectVerificationInspectionEvidence(
  input: InspectionInput,
): Promise<readonly VerificationInspectionEvidenceV1[]> {
  const checks = input.checks
    .map(inspectionCheck)
    .filter((check): check is InspectionCheck => check !== undefined);
  if (checks.length === 0) return [];

  const baseline = input.baseline;
  const preExisting = new Set(input.preExistingPaths ?? []);
  const refs = ["repository baseline snapshot", "repository current snapshot"];
  if (baseline === undefined) {
    return checks.map((check) =>
      evidence(
        check,
        "unavailable",
        { changed_files: [] },
        refs,
        "repository baseline snapshot unavailable",
      ),
    );
  }

  const changed = changedFiles(baseline, input.current);
  const workflowChanged = changed.filter((path) => !preExisting.has(path));
  const outOfScope = workflowChanged.filter(
    (path) =>
      !input.writeScope.some(
        (allowed) => allowed === "." || path === allowed || path.startsWith(`${allowed}/`),
      ),
  );
  const dependencyFilesChanged = workflowChanged.filter(dependencyFile);
  const sourceFiles = workflowChanged.filter((path) => SOURCE_FILE.test(path));
  const importsByFile: Record<string, JsonValue> = {};
  const external: string[] = [];
  const unreadable: string[] = [];

  for (const path of sourceFiles) {
    try {
      const imports = importsIn(await readRepositoryFile(input.repositoryRoot, path));
      importsByFile[path] = imports;
      for (const specifier of externalImports(imports)) {
        external.push(`${path}:${specifier}`);
      }
    } catch {
      unreadable.push(path);
    }
  }

  const description = checks.map(({ description }) => description).join(" ");
  const expectsNodeTest = NODE_TEST_INTENT.test(description);
  const nodeTestFiles = Object.entries(importsByFile)
    .filter(([, imports]) => Array.isArray(imports) && imports.includes("node:test"))
    .map(([path]) => path);
  const observed: JsonObject = {
    changed_files: workflowChanged,
    write_scope: [...input.writeScope],
    pre_existing_files: [...preExisting].sort((left, right) => left.localeCompare(right)),
    out_of_scope_files: outOfScope,
    dependency_files_changed: dependencyFilesChanged,
    imports_by_file: importsByFile,
    external_imports: [...new Set(external)].sort((left, right) => left.localeCompare(right)),
    node_test_import_files: nodeTestFiles,
    baseline_fingerprint: baseline.fingerprint,
    current_fingerprint: input.current.fingerprint,
  };

  return checks.map((check) => {
    if (check.type === "manual") {
      return evidence(
        check,
        "unavailable",
        observed,
        refs,
        "manual inspection requires observation",
      );
    }
    if (!INSPECTION_INTENT.test(check.description) || !SCOPE_INTENT.test(check.description)) {
      return evidence(check, "unavailable", observed, refs, "inspection intent is unsupported");
    }
    if (unreadable.length > 0) {
      return evidence(check, "unavailable", { ...observed, unreadable_files: unreadable }, refs);
    }
    const failed =
      outOfScope.length > 0 ||
      dependencyFilesChanged.length > 0 ||
      external.length > 0 ||
      (expectsNodeTest && nodeTestFiles.length === 0);
    return evidence(check, failed ? "failed" : "passed", observed, [...refs, ...sourceFiles]);
  });
}
