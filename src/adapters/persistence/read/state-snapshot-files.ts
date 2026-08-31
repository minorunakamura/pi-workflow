import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { type RuntimeSchema } from "../../../contracts/execution/agent-execution.js";
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

async function readYaml<T>(
  path: string,
  schema: RuntimeSchema<T>,
  readTextFile: ReadTextFile,
): Promise<T> {
  return schema.parse(parseYaml(await readTextFile(path)));
}

async function readJson<T>(
  path: string,
  schema: RuntimeSchema<T>,
  readTextFile: ReadTextFile,
): Promise<T> {
  return schema.parse(JSON.parse(await readTextFile(path)) as unknown);
}

export function readRunYaml(path: string, readTextFile: ReadTextFile): Promise<RunYamlV1> {
  return readYaml(path, RunYamlV1Schema, readTextFile);
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
): Promise<StateSnapshot> {
  const [requirement, steps, uncertainties, decisions, gates, findings, manifest] =
    await Promise.all([
      readYaml(
        join(snapshotDirectory, "requirement.yaml"),
        RequirementSnapshotV1Schema,
        readTextFile,
      ),
      readYaml(join(snapshotDirectory, "steps.yaml"), StepsSnapshotV1Schema, readTextFile),
      readYaml(
        join(snapshotDirectory, "uncertainties.yaml"),
        UncertaintiesSnapshotV1Schema,
        readTextFile,
      ),
      readYaml(join(snapshotDirectory, "decisions.yaml"), DecisionsSnapshotV1Schema, readTextFile),
      readYaml(join(snapshotDirectory, "gates.yaml"), GatesSnapshotV1Schema, readTextFile),
      readYaml(join(snapshotDirectory, "findings.yaml"), FindingsSnapshotV1Schema, readTextFile),
      readJson(join(snapshotDirectory, "manifest.json"), SnapshotManifestV1Schema, readTextFile),
    ]);

  return { requirement, steps, uncertainties, decisions, gates, findings, manifest };
}
