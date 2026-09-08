import { describe, expect, it } from "vitest";
import {
  buildWorkflowKickoff,
  registerWorkflowCommands,
  type WorkflowRequestType,
} from "../../src/commands/workflow";

interface RegisteredCommand {
  name: string;
  handler: (args: string, ctx: CommandContext) => Promise<void>;
}

interface CommandContext {
  ui: { notify: (message: string, type?: string) => void };
}

describe("workflow commands", () => {
  it("registers all four request types", () => {
    const commands: RegisteredCommand[] = [];
    registerWorkflowCommands({
      registerCommand: (name: string, options: RegisteredCommand) =>
        commands.push({ name, handler: options.handler }),
    } as never);

    expect(commands.map((command) => command.name)).toEqual([
      "wf-feature",
      "wf-bug",
      "wf-chore",
      "wf-hotfix",
    ]);
  });

  it.each([
    ["wf-feature", "feature"],
    ["wf-bug", "bug"],
    ["wf-chore", "chore"],
    ["wf-hotfix", "hotfix"],
  ] as const)("maps /%s to request type %s", (name, type) => {
    const sent: string[] = [];
    const commands: RegisteredCommand[] = [];
    registerWorkflowCommands({
      registerCommand: (commandName: string, options: RegisteredCommand) =>
        commands.push({ name: commandName, handler: options.handler }),
      sendUserMessage: (message: string) => sent.push(message),
    } as never);

    const command = commands.find((item) => item.name === name);
    expect(command).toBeDefined();
    void command?.handler("  improve the API  ", {
      ui: { notify: () => undefined },
    });

    expect(sent).toEqual([
      buildWorkflowKickoff(type as WorkflowRequestType, "improve the API"),
    ]);
  });

  it("rejects an empty request without sending a kickoff", async () => {
    const sent: string[] = [];
    const notifications: string[] = [];
    const commands: RegisteredCommand[] = [];
    registerWorkflowCommands({
      registerCommand: (name: string, options: RegisteredCommand) =>
        commands.push({ name, handler: options.handler }),
      sendUserMessage: (message: string) => sent.push(message),
    } as never);

    await commands[0].handler("  \t", {
      ui: { notify: (message) => notifications.push(message) },
    });

    expect(sent).toEqual([]);
    expect(notifications).toEqual(["Usage: /wf-feature <request>"]);
  });
});
