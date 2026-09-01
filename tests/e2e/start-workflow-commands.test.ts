import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import workflowExtension from "../../src/extensions/workflow.js";
import {
  START_WORKFLOW_COMMANDS,
  type StartWorkflowCommand,
} from "../../src/application/workflow-command-handler.js";
import { WORKFLOW_COMMANDS } from "../../src/extensions/commands/register-workflow-commands.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];

describe("six workflow start commands", () => {
  it("registers through the Extension entry point and invokes the start use case", async () => {
    const registrations = new Map<string, RegisteredCommand>();
    const starts: Array<readonly [StartWorkflowCommand, string]> = [];
    const pi: Parameters<typeof workflowExtension>[0] = {
      registerCommand(name, options) {
        registrations.set(name, options);
      },
    };

    workflowExtension(pi, {
      startWorkflow: {
        async execute(command, args) {
          starts.push([command, args]);
        },
      },
    });

    expect([...registrations.keys()]).toEqual(WORKFLOW_COMMANDS.map(({ name }) => name));

    for (const command of START_WORKFLOW_COMMANDS) {
      const registered = registrations.get(`wf-${command}`);
      expect(registered).toBeDefined();
      await registered!.handler("implement the requested change", {} as never);
    }

    expect(starts).toEqual(
      START_WORKFLOW_COMMANDS.map((command) => [command, "implement the requested change"]),
    );
  });

  it("keeps Playbook orchestration out of command shims", () => {
    const source = readFileSync(
      resolve(projectRoot, "src/extensions/commands/register-workflow-commands.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/PLAYBOOK_DEFINITIONS|Orchestrator|playbooks[\\/]/);
  });
});
