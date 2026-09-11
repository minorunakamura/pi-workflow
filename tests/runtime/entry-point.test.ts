import { describe, expect, it } from "vitest";
import piWorkflow from "../../src";

describe("extension entry point", () => {
  it("preserves commands/tools and registers both session lifecycle handlers", () => {
    const commands: string[] = [];
    const tools: string[] = [];
    const events: string[] = [];

    piWorkflow({
      registerCommand: (name: string) => commands.push(name),
      registerTool: (tool: { name: string }) => tools.push(tool.name),
      on: (event: string) => events.push(event),
    } as never);

    expect(commands).toEqual(["wf-feature", "wf-bug", "wf-chore", "wf-hotfix"]);
    expect(tools).toEqual(["pi_workflow_plan_review"]);
    expect(events).toEqual(["session_start", "session_shutdown"]);
  });
});
