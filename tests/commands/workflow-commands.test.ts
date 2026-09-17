import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

import { registerCommands } from "../../src/commands/index.ts";
import { registerWfBugCommand } from "../../src/commands/wf-bug.ts";
import { registerWfChoreCommand } from "../../src/commands/wf-chore.ts";
import { registerWfFeatureCommand } from "../../src/commands/wf-feature.ts";
import { registerWfHotfixCommand } from "../../src/commands/wf-hotfix.ts";
import { createRunId, type WorkflowType } from "../../src/core/index.ts";
import type { PlanningCoordinatorLaunchResult } from "../../src/runtime/subagents-rpc.ts";
import { startWorkflow } from "../../src/runtime/start-workflow.ts";
import { RootWorkflowRegistry } from "../../src/runtime/root-lifecycle.ts";

type RegisteredCommand = {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

type Registration = Pick<ExtensionAPI, "registerCommand">;

type Notification = {
  message: string;
  type: "info" | "warning" | "error" | undefined;
};

function commandRegistration(): {
  pi: Registration;
  commands: Map<string, RegisteredCommand>;
} {
  const commands = new Map<string, RegisteredCommand>();
  return {
    commands,
    pi: {
      registerCommand(name, options) {
        commands.set(name, { handler: options.handler });
      },
    },
  };
}

function context(
  cwd: string,
  notifications: Notification[],
): ExtensionCommandContext {
  return Object.assign(Object.create(null), {
    cwd,
    ui: {
      notify(message: string, type: Notification["type"]) {
        notifications.push({ message, type });
      },
    },
  });
}

it("registers each command with its explicit Workflow Type", async () => {
  const registrations = [
    ["wf-feature", "feature", registerWfFeatureCommand],
    ["wf-bug", "bug", registerWfBugCommand],
    ["wf-chore", "chore", registerWfChoreCommand],
    ["wf-hotfix", "hotfix", registerWfHotfixCommand],
  ] as const;
  const seen: Array<{ type: WorkflowType; request: string; cwd: string }> = [];

  for (const [name, workflowType, register] of registrations) {
    const { pi, commands } = commandRegistration();
    register(pi, (type, request, commandContext) => {
      seen.push({ type, request, cwd: commandContext.cwd });
    });
    const handler = commands.get(name)?.handler;
    expect(handler).toBeDefined();
    if (handler === undefined) return;

    await handler(
      "  implement the request  ",
      context(`/tmp/${workflowType}`, []),
    );
  }

  expect(seen).toEqual([
    { type: "feature", request: "implement the request", cwd: "/tmp/feature" },
    { type: "bug", request: "implement the request", cwd: "/tmp/bug" },
    { type: "chore", request: "implement the request", cwd: "/tmp/chore" },
    { type: "hotfix", request: "implement the request", cwd: "/tmp/hotfix" },
  ]);
});

it("rejects an empty request without delegating or creating state", async () => {
  const { pi, commands } = commandRegistration();
  const notifications: Notification[] = [];
  let delegated = false;
  registerWfFeatureCommand(pi, () => {
    delegated = true;
  });

  await commands
    .get("wf-feature")
    ?.handler(" \t\n ", context("/repo", notifications));

  expect(delegated).toBe(false);
  expect(notifications).toEqual([
    { message: "Workflow request is required.", type: "error" },
  ]);
});

it("starts the Root workflow with the trimmed request and command cwd", () => {
  const registry = new RootWorkflowRegistry(() => undefined);
  const notifications: Notification[] = [];

  const result = startWorkflow(
    registry,
    "bug",
    "reproduce the regression",
    context("/repo/project", notifications),
  );

  expect(result.started).toBe(true);
  if (!result.started) return;
  expect(result.request).toMatchObject({
    workflowType: "bug",
    request: "reproduce the regression",
    cwd: "/repo/project",
  });
  expect(result.state).toMatchObject({
    workflowId: expect.stringMatching(/^wf-/u),
    workflowType: "bug",
    phase: "PLANNING",
  });
  expect(notifications).toEqual([
    { message: "Started /wf-bug workflow.", type: "info" },
  ]);
});

it("starts the public planning Coordinator and records its opaque run ID", async () => {
  const registry = new RootWorkflowRegistry(() => undefined);
  const { pi, commands } = commandRegistration();
  const notifications: Notification[] = [];
  let receivedRequest: string | undefined;
  const launch: PlanningCoordinatorLaunchResult = {
    requestId: "rpc-request-1",
    runId: createRunId("planning-run-1"),
  };
  registerCommands(pi, registry, {
    async spawnPlanningCoordinator(request) {
      receivedRequest = request.request;
      return launch;
    },
  });

  await commands
    .get("wf-feature")
    ?.handler("  add the feature  ", context("/repo", notifications));

  expect(receivedRequest).toBe("add the feature");
  expect(registry.getState()).toMatchObject({
    phase: "PLANNING",
    planningStatus: "RUNNING",
    planningRunId: "planning-run-1",
  });
  expect(notifications).toEqual([
    { message: "Started /wf-feature workflow.", type: "info" },
  ]);
});

it("rejects a second active command in the same Root session", async () => {
  const registry = new RootWorkflowRegistry(() => undefined);
  const { pi, commands } = commandRegistration();
  const notifications: Notification[] = [];
  const commandContext = context("/repo", notifications);
  registerWfFeatureCommand(pi, (type, request, ctx) => {
    startWorkflow(registry, type, request, ctx);
  });

  await commands.get("wf-feature")?.handler("first request", commandContext);
  await commands.get("wf-feature")?.handler("second request", commandContext);

  expect(registry.getState()).toMatchObject({
    phase: "PLANNING",
    workflowType: "feature",
  });
  expect(notifications).toEqual([
    { message: "Started /wf-feature workflow.", type: "info" },
    {
      message: "A workflow is already active in this Root session.",
      type: "error",
    },
  ]);
});
