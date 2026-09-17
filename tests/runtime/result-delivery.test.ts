import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { registerCommands } from "../../src/commands/index.ts";
import {
  SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
  SUBAGENT_RESULT_INTERCOM_EVENT,
  type ResultDeliveryStatus,
  preflightResultDelivery,
  registerResultDeliveryObservation,
} from "../../src/runtime/result-delivery.ts";
import { RootWorkflowRegistry } from "../../src/runtime/root-lifecycle.ts";
import type { SubagentRpcEventBus } from "../../src/runtime/subagents-rpc.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

class FakeEventBus implements SubagentRpcEventBus {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  public on(event: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(event);
    };
  }

  public emit(event: string, data: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(data);
  }

  public listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

function resultEvent(
  requestId = "delivery-request",
  runId = "coordinator-run",
) {
  return {
    requestId,
    runId,
    to: "root-session",
    message: "managed result only",
  };
}

function completionEvent(runId = "coordinator-run") {
  return {
    runId,
    sessionId: "session-1",
    state: "complete",
    success: true,
    intercomDelivered: true,
  };
}

function commandContext(
  notifications: Array<{ message: string; type: string }>,
): ExtensionCommandContext {
  return Object.assign(Object.create(null), {
    cwd: "/repo",
    ui: {
      notify(message: string, type: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
    },
  });
}

it("preflights the global host config without modifying it", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-result-delivery-"));
  const configPath = join(root, "config.json");
  const config = JSON.stringify({
    intercomBridge: { mode: "always", resultDelivery: true },
  });
  writeFileSync(configPath, config, "utf8");

  try {
    expect(preflightResultDelivery({ configPath })).toMatchObject({
      ready: true,
      configPath,
    });
    expect(readFileSync(configPath, "utf8")).toBe(config);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects missing, malformed, and incomplete host prerequisites", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-result-delivery-"));
  const missingPath = join(root, "missing.json");
  const malformedPath = join(root, "malformed.json");
  const incompletePath = join(root, "incomplete.json");
  writeFileSync(malformedPath, "{", "utf8");
  writeFileSync(
    incompletePath,
    JSON.stringify({
      intercomBridge: { mode: "always", resultDelivery: false },
    }),
    "utf8",
  );

  try {
    for (const configPath of [missingPath, malformedPath, incompletePath]) {
      expect(preflightResultDelivery({ configPath }).ready).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("refuses workflow start before state creation when the host prerequisite is unavailable", async () => {
  const registry = new RootWorkflowRegistry(() => undefined);
  const notifications: Array<{ message: string; type: string }> = [];
  const { commands } = (() => {
    const registered = new Map<
      string,
      {
        handler: (
          args: string,
          context: ExtensionCommandContext,
        ) => Promise<void>;
      }
    >();
    registerCommands(
      {
        registerCommand(name, options) {
          registered.set(name, { handler: options.handler });
        },
      },
      registry,
      {
        preflightResultDelivery: () => ({
          ready: false as const,
          configPath: "/missing/config.json",
          reason: "MISSING_CONFIG" as const,
        }),
        async spawnPlanningCoordinator() {
          throw new Error("must not spawn");
        },
        async stop() {},
      },
    );
    return { commands: registered };
  })();

  await commands
    .get("wf-feature")
    ?.handler("implement the feature", commandContext(notifications));

  expect(registry.getState()).toBeUndefined();
  expect(notifications).toEqual([
    {
      message:
        "pi-subagents resultDelivery host prerequisite is not configured.",
      type: "error",
    },
  ]);
});

it("accepts only a matching acknowledged result delivery", () => {
  const events = new FakeEventBus();
  const failures: Array<{ runId: string; status: ResultDeliveryStatus }> = [];
  const observation = registerResultDeliveryObservation(events, {
    sessionId: "session-1",
    isRelevantRun: (runId) => runId === "coordinator-run",
    onUntrustedCompletion: (runId, status) => failures.push({ runId, status }),
  });

  events.emit(SUBAGENT_RESULT_INTERCOM_EVENT, resultEvent());
  events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
    requestId: "foreign-request",
    delivered: true,
  });
  expect(observation.statusFor("coordinator-run")).toBe("missing");

  events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
    requestId: "delivery-request",
    delivered: true,
  });
  expect(observation.statusFor("coordinator-run")).toBe("delivered");
  events.emit("subagent:async-complete", completionEvent());

  expect(failures).toEqual([]);
  expect(observation.isCompletionTrusted("coordinator-run")).toBe(true);
  observation.dispose();
});

it("fails closed once for a negative or conflicting acknowledgement", () => {
  const events = new FakeEventBus();
  const failures: Array<{ runId: string; status: ResultDeliveryStatus }> = [];
  const observation = registerResultDeliveryObservation(events, {
    isRelevantRun: () => true,
    onAckFailure: (runId, status) => failures.push({ runId, status }),
  });

  events.emit(SUBAGENT_RESULT_INTERCOM_EVENT, resultEvent());
  events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
    requestId: "delivery-request",
    delivered: false,
  });
  events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
    requestId: "delivery-request",
    delivered: false,
  });
  expect(observation.statusFor("coordinator-run")).toBe("failed");
  expect(failures).toEqual([{ runId: "coordinator-run", status: "failed" }]);

  events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
    requestId: "delivery-request",
    delivered: true,
  });
  expect(observation.statusFor("coordinator-run")).toBe("conflict");
  expect(failures).toEqual([
    { runId: "coordinator-run", status: "failed" },
    { runId: "coordinator-run", status: "conflict" },
  ]);
  observation.dispose();
});

it("fails a completion with missing acknowledgement and disposes on reload", () => {
  const events = new FakeEventBus();
  const failures: Array<{ runId: string; status: ResultDeliveryStatus }> = [];
  const observation = registerResultDeliveryObservation(events, {
    sessionId: "session-1",
    isRelevantRun: () => true,
    onUntrustedCompletion: (runId, status) => failures.push({ runId, status }),
  });

  events.emit("subagent:async-complete", completionEvent());
  expect(failures).toEqual([{ runId: "coordinator-run", status: "missing" }]);

  observation.dispose();
  expect(events.listenerCount(SUBAGENT_RESULT_INTERCOM_EVENT)).toBe(0);
  expect(events.listenerCount(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT)).toBe(0);
  events.emit(
    SUBAGENT_RESULT_INTERCOM_EVENT,
    resultEvent("late-request", "coordinator-run"),
  );
  events.emit(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, {
    requestId: "late-request",
    delivered: true,
  });
  expect(observation.statusFor("coordinator-run")).toBe("missing");
});
