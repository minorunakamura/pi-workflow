import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import {
  createWorkflowResourceLifecycle,
  registerWorkflowResourceLifecycle,
  WORKFLOW_RESOURCE_CONTRACTS,
  WORKFLOW_RESOURCE_DEFINITIONS,
  WORKFLOW_RESOURCE_NAMES,
  type WorkflowResourceRegistrar,
} from "../../src/runtime/workflow-resources";

const EXPECTED_RESOURCE_NAMES = [
  "pi-workflow.discovery",
  "pi-workflow.research",
  "pi-workflow.planning",
  "pi-workflow.implementation",
  "pi-workflow.verification",
  "pi-workflow.verification-fix",
  "pi-workflow.review",
] as const;

function trackingRegistrar(
  disposed: string[],
  registered: string[] = [],
): WorkflowResourceRegistrar {
  return ({ sessionId, definition }) => {
    registered.push(`${sessionId}:${definition.name}`);
    return {
      dispose: () => disposed.push(`${sessionId}:${definition.name}`),
    };
  };
}

describe("named workflow resource contract", () => {
  it("exposes exactly the canonical resources at version 1", () => {
    expect(WORKFLOW_RESOURCE_NAMES).toEqual(EXPECTED_RESOURCE_NAMES);
    expect(WORKFLOW_RESOURCE_DEFINITIONS.map(({ name }) => name)).toEqual(
      EXPECTED_RESOURCE_NAMES,
    );
    expect(new Set(WORKFLOW_RESOURCE_NAMES).size).toBe(7);
    expect(
      WORKFLOW_RESOURCE_DEFINITIONS.every(({ version }) => version === 1),
    ).toBe(true);
    expect(
      WORKFLOW_RESOURCE_NAMES.every((name) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name),
      ),
    ).toBe(true);
  });

  it("encodes resource-owned args, output, and foreground policies", () => {
    expect(Object.keys(WORKFLOW_RESOURCE_CONTRACTS)).toEqual(
      EXPECTED_RESOURCE_NAMES,
    );
    for (const name of EXPECTED_RESOURCE_NAMES) {
      const contract = WORKFLOW_RESOURCE_CONTRACTS[name];
      expect(contract.argsSchema).toMatchObject({
        additionalProperties: false,
      });
      expect(contract.foreground).toEqual({
        main: { async: false },
        runsRun: { async: false },
        runsAll: { async: false },
        runsLanes: { async: false },
      });
    }
    expect(
      WORKFLOW_RESOURCE_CONTRACTS["pi-workflow.discovery"].outputPolicy.artifact
        .outputSchema,
    ).toBe("forbidden");
    expect(
      WORKFLOW_RESOURCE_CONTRACTS["pi-workflow.planning"].outputPolicy.decision
        .outputSchema,
    ).toBe("allowed");
  });

  it("validates bounded args before failing closed for an unmigrated phase", () => {
    const validArgs: Record<
      (typeof EXPECTED_RESOURCE_NAMES)[number],
      Readonly<Record<string, unknown>>
    > = {
      "pi-workflow.discovery": {
        requestType: "feature",
        request: "Inspect the repository.",
      },
      "pi-workflow.research": {},
      "pi-workflow.planning": { round: 1 },
      "pi-workflow.implementation": { mode: "single" },
      "pi-workflow.verification": { round: 0 },
      "pi-workflow.verification-fix": { round: 1 },
      "pi-workflow.review": { wave: 0 },
    };

    for (const definition of WORKFLOW_RESOURCE_DEFINITIONS) {
      expect(Object.keys(definition)).toEqual(["name", "version", "resolve"]);
      const result = definition.resolve(
        validArgs[definition.name as (typeof EXPECTED_RESOURCE_NAMES)[number]],
      );
      expect(result).toMatchObject({
        error: expect.stringContaining(definition.name),
      });
      expect(result).toMatchObject({
        error: expect.stringContaining("not yet migrated"),
      });
    }
  });

  it("rejects invalid args instead of reaching the migration placeholder", () => {
    for (const definition of WORKFLOW_RESOURCE_DEFINITIONS) {
      const result = definition.resolve({
        workflowScript: "caller supplied script",
        outputSchema: { type: "object" },
      });
      expect(result).toMatchObject({
        error: expect.stringContaining("Invalid args"),
      });
      if (!("error" in result)) throw new Error("expected invalid args");
      expect(result.error).not.toContain("not yet migrated");
    }
  });

  it("registers all resources in canonical order and disposes them in reverse order", () => {
    const registered: string[] = [];
    const disposed: string[] = [];
    const lifecycle = createWorkflowResourceLifecycle(
      trackingRegistrar(disposed, registered),
    );

    lifecycle.register("session-a");
    lifecycle.dispose("session-a");

    expect(registered).toEqual(
      EXPECTED_RESOURCE_NAMES.map((name) => `session-a:${name}`),
    );
    expect(disposed).toEqual(
      EXPECTED_RESOURCE_NAMES.toReversed().map((name) => `session-a:${name}`),
    );
  });

  it("rolls back every successful registration when a later registration fails", () => {
    const disposed: string[] = [];
    const registrationError = new Error("third registration failed");
    let attempts = 0;
    const registrar: WorkflowResourceRegistrar = ({ definition }) => {
      attempts += 1;
      if (attempts === 3) throw registrationError;
      return { dispose: () => disposed.push(definition.name) };
    };
    const lifecycle = createWorkflowResourceLifecycle(registrar);

    let thrown: unknown;
    try {
      lifecycle.register("session-a");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(registrationError);
    expect(disposed).toEqual(EXPECTED_RESOURCE_NAMES.slice(0, 2).toReversed());

    lifecycle.dispose("session-a");
    expect(disposed).toEqual(EXPECTED_RESOURCE_NAMES.slice(0, 2).toReversed());
  });

  it("attempts every shutdown disposer and clears the session state", () => {
    const disposed: string[] = [];
    const cleanupError = new Error("second disposer failed");
    const registrar: WorkflowResourceRegistrar = ({
      sessionId,
      definition,
    }) => ({
      dispose: () => {
        disposed.push(`${sessionId}:${definition.name}`);
        if (definition.name === EXPECTED_RESOURCE_NAMES[1]) throw cleanupError;
      },
    });
    const lifecycle = createWorkflowResourceLifecycle(registrar);

    lifecycle.register("session-a");

    let thrown: unknown;
    try {
      lifecycle.dispose("session-a");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) throw thrown;
    expect(thrown.errors).toContain(cleanupError);
    expect(disposed).toEqual(
      EXPECTED_RESOURCE_NAMES.toReversed().map((name) => `session-a:${name}`),
    );

    lifecycle.dispose("session-a");
    expect(disposed).toHaveLength(EXPECTED_RESOURCE_NAMES.length);
  });

  it("uses the public session identity for event-scoped ownership", () => {
    type Handler = (
      event: unknown,
      context: { sessionManager: { getSessionId: () => string } },
    ) => void;
    const handlers = new Map<string, Handler>();
    const disposed: string[] = [];

    registerWorkflowResourceLifecycle(
      {
        on: (event: string, handler: Handler) => handlers.set(event, handler),
      } as never,
      trackingRegistrar(disposed),
    );

    handlers.get("session_start")?.(
      {},
      {
        sessionManager: { getSessionId: () => "session-a" },
      },
    );
    handlers.get("session_start")?.(
      {},
      {
        sessionManager: { getSessionId: () => "session-b" },
      },
    );
    handlers.get("session_shutdown")?.(
      {},
      {
        sessionManager: { getSessionId: () => "session-a" },
      },
    );

    expect(disposed).toEqual(
      EXPECTED_RESOURCE_NAMES.toReversed().map((name) => `session-a:${name}`),
    );

    handlers.get("session_shutdown")?.(
      {},
      {
        sessionManager: { getSessionId: () => "session-b" },
      },
    );
  });

  it("keeps disposer ownership isolated between sessions", () => {
    const disposed: string[] = [];
    const lifecycle = createWorkflowResourceLifecycle(
      trackingRegistrar(disposed),
    );

    lifecycle.register("session-a");
    lifecycle.register("session-b");
    lifecycle.dispose("session-a");

    expect(disposed).toEqual(
      EXPECTED_RESOURCE_NAMES.toReversed().map((name) => `session-a:${name}`),
    );

    lifecycle.dispose("session-b");
    expect(disposed).toEqual([
      ...EXPECTED_RESOURCE_NAMES.toReversed().map(
        (name) => `session-a:${name}`,
      ),
      ...EXPECTED_RESOURCE_NAMES.toReversed().map(
        (name) => `session-b:${name}`,
      ),
    ]);
  });

  it("does not replace an active session registration", () => {
    const disposed: string[] = [];
    const lifecycle = createWorkflowResourceLifecycle(
      trackingRegistrar(disposed),
    );

    lifecycle.register("session-a");
    expect(() => lifecycle.register("session-a")).toThrow(
      /already has active workflow resources/,
    );
    expect(disposed).toEqual([]);

    lifecycle.dispose("session-a");
  });

  it("works through the real v0.66.0 public registration boundary", () => {
    const sessionId = `unit-1-${randomUUID()}`;
    const lifecycle = createWorkflowResourceLifecycle(registerWorkflowResource);

    expect(() => lifecycle.register(sessionId)).not.toThrow();
    expect(() => lifecycle.dispose(sessionId)).not.toThrow();
  });

  it("preserves the original public registration on duplicate names", () => {
    const sessionId = `unit-1-duplicate-${randomUUID()}`;
    const definition = WORKFLOW_RESOURCE_DEFINITIONS[0];
    const first = registerWorkflowResource({ sessionId, definition });

    try {
      expect(() => registerWorkflowResource({ sessionId, definition })).toThrow(
        /already registered in this session/,
      );
    } finally {
      first.dispose();
    }
  });
});
