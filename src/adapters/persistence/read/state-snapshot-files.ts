import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ContractValidationError,
  type RuntimeSchema,
} from "../../../contracts/execution/agent-execution.js";
import {
  DecisionsSnapshotV1Schema,
  FindingsSnapshotV1Schema,
  GatesSnapshotV1Schema,
  RequirementSnapshotV1Schema,
  RunYamlV1Schema,
  SnapshotManifestV1Schema,
  StepsSnapshotV1Schema,
  UncertaintiesSnapshotV1Schema,
  type RunYamlV1,
} from "../../../contracts/state/workflow-state.js";
import type { StateSnapshot } from "../../../ports/run-reader.js";

export type ReadTextFile = (path: string) => Promise<string>;

export type StateSchemaMigration = (
  document: Readonly<Record<string, unknown>>,
) => Readonly<Record<string, unknown>>;

export type StateSchemaMigrations = Readonly<Record<number, StateSchemaMigration>>;

export const CURRENT_STATE_SCHEMA_VERSION = 1 as const;

export const DEFAULT_STATE_SCHEMA_MIGRATIONS: StateSchemaMigrations = {
  0: (document) => ({ ...document, schema_version: CURRENT_STATE_SCHEMA_VERSION }),
};

function isStateDocument(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function stateDocument(input: unknown, contract: string): Record<string, unknown> {
  if (!isStateDocument(input)) {
    throw new ContractValidationError(contract, { path: "", expected: "an object" });
  }
  return input;
}

function schemaVersion(input: unknown, contract: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw new ContractValidationError(contract, {
      path: "schema_version",
      expected: "a non-negative schema version",
    });
  }
  return input;
}

export function migrateStateDocument(
  input: unknown,
  contract: string,
  migrations: StateSchemaMigrations = DEFAULT_STATE_SCHEMA_MIGRATIONS,
): Readonly<Record<string, unknown>> {
  let document = stateDocument(input, contract);
  let version = schemaVersion(document.schema_version, contract);

  if (version > CURRENT_STATE_SCHEMA_VERSION) {
    throw new ContractValidationError(contract, {
      path: "schema_version",
      expected: `schema version ${CURRENT_STATE_SCHEMA_VERSION}`,
    });
  }

  while (version < CURRENT_STATE_SCHEMA_VERSION) {
    const migration = migrations[version];
    if (migration === undefined) {
      throw new ContractValidationError(contract, {
        path: "schema_version",
        expected: `a known migration from schema version ${version}`,
      });
    }

    document = stateDocument(migration({ ...document }), contract);
    const nextVersion = schemaVersion(document.schema_version, contract);
    if (nextVersion !== version + 1) {
      throw new ContractValidationError(contract, {
        path: "schema_version",
        expected: `schema version ${version + 1} after migration`,
      });
    }
    version = nextVersion;
  }

  return document;
}

async function readYaml<T>(
  path: string,
  schema: RuntimeSchema<T>,
  readTextFile: ReadTextFile,
  contract: string,
  migrations: StateSchemaMigrations,
): Promise<T> {
  const document = parseYaml(await readTextFile(path));
  return schema.parse(migrateStateDocument(document, contract, migrations));
}

async function readJson<T>(
  path: string,
  schema: RuntimeSchema<T>,
  readTextFile: ReadTextFile,
  contract: string,
  migrations: StateSchemaMigrations,
): Promise<T> {
  const document = JSON.parse(await readTextFile(path)) as unknown;
  return schema.parse(migrateStateDocument(document, contract, migrations));
}

export function readRunYaml(
  path: string,
  readTextFile: ReadTextFile,
  migrations: StateSchemaMigrations = DEFAULT_STATE_SCHEMA_MIGRATIONS,
): Promise<RunYamlV1> {
  return readYaml(path, RunYamlV1Schema, readTextFile, "RunYamlV1", migrations);
}

export function validateRunYaml(input: unknown): RunYamlV1 {
  return RunYamlV1Schema.parse(input);
}

export function validateStateSnapshot(snapshot: StateSnapshot): StateSnapshot {
  return {
    requirement: RequirementSnapshotV1Schema.parse(snapshot.requirement),
    steps: StepsSnapshotV1Schema.parse(snapshot.steps),
    uncertainties: UncertaintiesSnapshotV1Schema.parse(snapshot.uncertainties),
    decisions: DecisionsSnapshotV1Schema.parse(snapshot.decisions),
    gates: GatesSnapshotV1Schema.parse(snapshot.gates),
    findings: FindingsSnapshotV1Schema.parse(snapshot.findings),
    manifest: SnapshotManifestV1Schema.parse(snapshot.manifest),
  };
}

export async function readSnapshotDirectory(
  snapshotDirectory: string,
  readTextFile: ReadTextFile,
  migrations: StateSchemaMigrations = DEFAULT_STATE_SCHEMA_MIGRATIONS,
): Promise<StateSnapshot> {
  const [requirement, steps, uncertainties, decisions, gates, findings, manifest] =
    await Promise.all([
      readYaml(
        join(snapshotDirectory, "requirement.yaml"),
        RequirementSnapshotV1Schema,
        readTextFile,
        "RequirementSnapshotV1",
        migrations,
      ),
      readYaml(
        join(snapshotDirectory, "steps.yaml"),
        StepsSnapshotV1Schema,
        readTextFile,
        "StepsSnapshotV1",
        migrations,
      ),
      readYaml(
        join(snapshotDirectory, "uncertainties.yaml"),
        UncertaintiesSnapshotV1Schema,
        readTextFile,
        "UncertaintiesSnapshotV1",
        migrations,
      ),
      readYaml(
        join(snapshotDirectory, "decisions.yaml"),
        DecisionsSnapshotV1Schema,
        readTextFile,
        "DecisionsSnapshotV1",
        migrations,
      ),
      readYaml(
        join(snapshotDirectory, "gates.yaml"),
        GatesSnapshotV1Schema,
        readTextFile,
        "GatesSnapshotV1",
        migrations,
      ),
      readYaml(
        join(snapshotDirectory, "findings.yaml"),
        FindingsSnapshotV1Schema,
        readTextFile,
        "FindingsSnapshotV1",
        migrations,
      ),
      readJson(
        join(snapshotDirectory, "manifest.json"),
        SnapshotManifestV1Schema,
        readTextFile,
        "SnapshotManifestV1",
        migrations,
      ),
    ]);

  return { requirement, steps, uncertainties, decisions, gates, findings, manifest };
}
