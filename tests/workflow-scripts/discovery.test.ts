import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  DiscoveryMetadataSchema,
  MAX_MISSION_STATE_BYTES,
  MISSION_STATE_KEYS,
} from "../../src/core/state/contracts";
import { MAX_REFERENCE_BYTES } from "../../src/core/state/references";
import { WORKFLOW_RESOURCE_DEFINITIONS } from "../../src/runtime/workflow-resources";

type ChildResult = {
  ok: boolean;
  runId?: string;
  outputReference?: string;
  output?: string;
  structuredOutput?: unknown;
  error?: string;
  stopped?: boolean;
  detached?: boolean;
  interrupted?: boolean;
};

type RunCall = {
  key: string;
  params: Record<string, unknown>;
};

const readyMetadata = {
  version: 1 as const,
  status: "ready" as const,
  externalResearchRequired: true,
  humanClarificationRequired: false,
  uncertainties: [
    {
      id: "uncertainty-1",
      question: "Which external API version is authoritative?",
      material: true,
    },
  ],
  researchQuestions: ["Which external API version is authoritative?"],
};

function discoveryScript(): string {
  const definition = WORKFLOW_RESOURCE_DEFINITIONS.find(
    ({ name }) => name === "pi-workflow.discovery",
  );
  if (!definition) throw new Error("missing Discovery resource");
  const resolved = definition.resolve({
    requestType: "feature",
    request: "Inspect the fixture.",
  });
  if (!("script" in resolved)) throw new Error(resolved.error);
  return resolved.script;
}

async function executeDiscovery(
  results: ChildResult[],
  initialState: Record<string, unknown> = {},
  failSetKey?: string,
) {
  const calls: RunCall[] = [];
  const writes: Array<{ key: string; value: unknown }> = [];
  const stateValues = { ...initialState };
  const queued = [...results];
  const runs = {
    run: async (key: string, params: Record<string, unknown>) => {
      calls.push({ key, params });
      const result = queued.shift();
      if (!result) throw new Error("test ran out of child results");
      return result;
    },
  };
  const state = {
    get: async (key: string) => stateValues[key],
    set: async (key: string, value: unknown) => {
      writes.push({ key, value });
      if (key === failSetKey) throw new Error(`state.set failed for ${key}`);
      stateValues[key] = value;
    },
  };
  const context = createContext({ runs, state });
  const runScript = new Script(`(async () => {\n${discoveryScript()}\n})()`);
  try {
    const result = await runScript.runInContext(context);
    return { result, calls, writes, stateValues };
  } catch (error) {
    if (error && typeof error === "object") {
      Object.assign(error, { calls, writes, stateValues });
    }
    throw error;
  }
}

function successfulChildren(metadata: unknown = readyMetadata): ChildResult[] {
  return [
    {
      ok: true,
      runId: "scout-artifact-1",
      outputReference: "/tmp/pi-workflow-unit3/discovery.md",
      output: "Output saved to the managed artifact.",
    },
    {
      ok: true,
      runId: "scout-metadata-1",
      structuredOutput: metadata,
    },
  ];
}

describe("Discovery named resource workflow", () => {
  it("runs one full file-only scout and one fresh bounded metadata normalizer", async () => {
    const execution = await executeDiscovery(successfulChildren());

    expect(execution.calls.map(({ key }) => key)).toEqual([
      "discovery-artifact",
      "discovery-metadata",
    ]);
    expect(execution.calls[0]?.params).toMatchObject({
      agent: "scout",
      context: "fresh",
      async: false,
      output: "discovery.md",
      outputMode: "file-only",
    });
    expect(execution.calls[0]?.params).not.toHaveProperty("outputSchema");
    expect(execution.calls[1]?.params).toMatchObject({
      agent: "scout",
      context: "fresh",
      async: false,
      output: "discovery-metadata.json",
      outputMode: "file-only",
      outputSchema: DiscoveryMetadataSchema,
    });
    expect(execution.calls[1]?.params.task).toEqual(
      expect.stringContaining("/tmp/pi-workflow-unit3/discovery.md"),
    );

    expect(execution.writes.map(({ key }) => key)).toEqual([
      "version",
      "requestType",
      "request",
      "discoveryRef",
      "discoveryMeta",
      "phase",
    ]);
    expect(execution.stateValues).toMatchObject({
      discoveryRef: "/tmp/pi-workflow-unit3/discovery.md",
      discoveryMeta: readyMetadata,
      phase: "discovery",
    });
    expect(execution.result).toEqual({
      status: "completed",
      runId: "scout-artifact-1",
      discoveryRef: "/tmp/pi-workflow-unit3/discovery.md",
      discoveryMeta: readyMetadata,
    });
    expect(execution.result).not.toHaveProperty("output");
    expect(JSON.stringify(execution.result)).not.toContain(
      "full Discovery report",
    );
  });

  it("preserves existing allowed Human decisions", async () => {
    const execution = await executeDiscovery(successfulChildren(), {
      version: 1,
      requestType: "feature",
      request: "Inspect the fixture.",
      humanDecisions: [{ id: "decision-1", value: "keep" }],
    });

    expect(execution.stateValues).toMatchObject({
      humanDecisions: [{ id: "decision-1", value: "keep" }],
      discoveryRef: "/tmp/pi-workflow-unit3/discovery.md",
    });
  });

  it.each([
    ["child failure", [{ ok: false, error: "scout failed" }]],
    ["missing output reference", [{ ok: true, runId: "scout-artifact-1" }]],
  ])("fails closed for %s", async (_label, results) => {
    const execution = executeDiscovery(results);
    await expect(execution).rejects.toThrow();
    await execution.catch((error: Error & { writes: unknown[] }) => {
      expect(error.writes).toHaveLength(0);
    });
  });

  it("fails closed for an invalid metadata result", async () => {
    await expect(
      executeDiscovery(successfulChildren({ ...readyMetadata, unknown: true })),
    ).rejects.toThrow();
  });

  it("fails closed for an oversized ReferenceValue", async () => {
    await expect(
      executeDiscovery([
        {
          ok: true,
          runId: "scout-artifact-1",
          outputReference: "r".repeat(MAX_REFERENCE_BYTES),
        },
      ]),
    ).rejects.toThrow();
  });

  it("fails closed when the Mission state handoff fails", async () => {
    const execution = executeDiscovery(
      successfulChildren(),
      {},
      "discoveryMeta",
    );

    await expect(execution).rejects.toThrow("state.set failed");
    await expect(execution).rejects.not.toThrow("Discovery succeeded");
    await execution.catch(
      (error: Error & { stateValues: Record<string, unknown> }) => {
        expect(error.stateValues).not.toHaveProperty("discoveryMeta");
        expect(error.stateValues).not.toHaveProperty("phase");
      },
    );
  });

  it("fails before launching when the existing aggregate state is oversized", async () => {
    const execution = await executeDiscovery([], {
      planningDecision: "x".repeat(MAX_MISSION_STATE_BYTES),
    }).catch((error: unknown) => ({ error }));

    expect(execution).toHaveProperty("error");
  });

  it("does not use another Mission's state as a fallback", async () => {
    const missionA = await executeDiscovery(successfulChildren());
    const missionB = await executeDiscovery(successfulChildren());

    expect(missionA.stateValues.discoveryRef).not.toBeUndefined();
    expect(missionB.stateValues.discoveryRef).toBe(
      "/tmp/pi-workflow-unit3/discovery.md",
    );
    expect(missionB.stateValues).not.toHaveProperty(
      "foreignMissionDiscoveryRef",
    );
  });

  it("keeps the resource state key inventory package-owned", () => {
    expect(MISSION_STATE_KEYS).toContain("discoveryRef");
    expect(MISSION_STATE_KEYS).toContain("discoveryMeta");
    expect(MISSION_STATE_KEYS).not.toContain("discovery");
  });
});
