import { describe, expect, it } from "vitest";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  migrateStateDocument,
  type StateSchemaMigrations,
} from "../../src/adapters/persistence/read/state-snapshot-files.js";

describe("state schema migration contracts", () => {
  it("applies known migrations one schema version at a time without mutating input", () => {
    const legacy = { schema_version: 0, value: { preserved: true } };
    const calls: number[] = [];
    const migrations: StateSchemaMigrations = {
      0: (document) => {
        calls.push(0);
        return { ...document, schema_version: CURRENT_STATE_SCHEMA_VERSION };
      },
    };

    const migrated = migrateStateDocument(legacy, "StateDocument", migrations);

    expect(migrated).toEqual({ schema_version: 1, value: { preserved: true } });
    expect(calls).toEqual([0]);
    expect(legacy).toEqual({ schema_version: 0, value: { preserved: true } });
  });

  it("rejects a migration that skips the next schema version", () => {
    expect(() =>
      migrateStateDocument({ schema_version: 0 }, "StateDocument", {
        0: (document) => ({ ...document, schema_version: 2 }),
      }),
    ).toThrow(/schema version 1 after migration/);
  });

  it("rejects an unsupported future schema before migration", () => {
    expect(() => migrateStateDocument({ schema_version: 2 }, "StateDocument")).toThrow(
      /schema version 1/,
    );
  });
});
