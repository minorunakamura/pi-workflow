import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrateStateDocument } from "../../src/adapters/persistence/read/state-snapshot-files.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("legacy runtime cutover", () => {
  it("exposes only the new runtime as the package /wf-* entry point", () => {
    const manifest = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8")) as {
      pi?: { extensions?: readonly unknown[] };
    };
    const extensions = manifest.pi?.extensions ?? [];

    expect(extensions).toContain("./src/extensions/workflow.ts");
    expect(
      extensions.filter(
        (extension): extension is string =>
          typeof extension === "string" && extension.includes("workflow"),
      ),
    ).toEqual(["./src/extensions/workflow.ts"]);

    const extensionSource = readFileSync(
      resolve(projectRoot, "src/extensions/workflow.ts"),
      "utf8",
    );
    expect(extensionSource).toContain("createWorkflowRuntime");
    expect(extensionSource).toContain("registerWorkflowCommands");
  });

  it("has no legacy workflow-tui runtime left in the package", () => {
    for (const path of [
      "workflow-tui.ts",
      "extensions/workflow-tui.ts",
      "src/extensions/workflow-tui.ts",
      ".pi/extensions/workflow-tui.ts",
    ]) {
      expect(existsSync(resolve(projectRoot, path)), path).toBe(false);
    }
  });

  it("does not migrate a legacy session transcript into State", () => {
    const legacyState = {
      schema_version: 0,
      legacy_session_transcript: "conversation history",
    };

    expect(migrateStateDocument(legacyState, "StateDocument")).toEqual({
      schema_version: 1,
      legacy_session_transcript: "conversation history",
    });
  });
});
