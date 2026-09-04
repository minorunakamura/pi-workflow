import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import workflowExtension from "../../src/extensions/workflow.js";
import { WORKFLOW_COMMANDS } from "../../src/extensions/commands/register-workflow-commands.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const coreSkills = [
  "how",
  "why",
  "blast-radius",
  "architect",
  "tdd",
  "interrogate",
  "figure-it-out",
  "show-me-your-work",
  "reflect",
];
const moduleDirectories = [
  "src/extensions",
  "src/extensions/commands",
  "src/domain",
  "src/contracts",
  "src/application",
  "src/ports",
  "src/adapters",
  "src/agents",
  "src/playbooks",
  "src/telemetry",
  "src/evaluation",
  "src/read-model",
  "src/bootstrap",
  "src/monitor",
  "src/monitor/backend",
  "src/monitor/indexer",
  "src/monitor/frontend",
];
const authoredSource = [
  "src/application/workflow-command-handler.ts",
  "src/bootstrap/create-workflow-runtime.ts",
  "src/extensions/commands/register-workflow-commands.ts",
  "src/extensions/workflow.ts",
];

describe("runtime module skeleton", () => {
  it("declares one Pi Extension and the package Skill root", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(resolve(projectRoot, "package.json"), "utf8"),
    );
    const settings = JSON.parse(
      readFileSync(resolve(projectRoot, ".pi/settings.json"), "utf8"),
    ) as { packages?: unknown[] };

    expect(manifest).toEqual(
      expect.objectContaining({
        pi: expect.objectContaining({
          extensions: expect.arrayContaining([
            "./src/extensions/workflow.ts",
            "./node_modules/pi-subagents/index.ts",
          ]),
          skills: ["./skills"],
        }),
        bundledDependencies: expect.arrayContaining(["pi-subagents"]),
        dependencies: expect.objectContaining({ "pi-subagents": ">=0.49.0 <0.65.0" }),
      }),
    );
    expect(settings.packages).toContainEqual({
      source: "npm:pi-subagents",
      autoload: false,
      extensions: ["!index.ts"],
    });
    expect(existsSync(resolve(projectRoot, "src/extensions/workflow.ts"))).toBe(true);
  });

  it("keeps all Core Skills under the declared package resource", () => {
    for (const skill of coreSkills) {
      expect(existsSync(resolve(projectRoot, "skills", skill, "SKILL.md"))).toBe(true);
    }
  });

  it("keeps runtime responsibilities in separate module directories", () => {
    for (const directory of moduleDirectories) {
      expect(existsSync(resolve(projectRoot, directory))).toBe(true);
    }

    expect(existsSync(resolve(projectRoot, "src/utils"))).toBe(false);
    expect(existsSync(resolve(projectRoot, "src/common"))).toBe(false);
  });

  it("registers the specified commands through the single Extension entry point", () => {
    const registrations: string[] = [];
    const pi: Parameters<typeof workflowExtension>[0] = {
      registerCommand(name: string): void {
        registrations.push(name);
      },
    };

    workflowExtension(pi);

    expect(registrations).toEqual(WORKFLOW_COMMANDS.map(({ name }) => name));
  });

  it("does not couple authored runtime source to Pi project state directories", () => {
    for (const file of authoredSource) {
      const source = readFileSync(resolve(projectRoot, file), "utf8");
      expect(source).not.toContain(".pi/agent/skills/");
      expect(source).not.toContain(".pi/workflows/");
    }
  });
});
