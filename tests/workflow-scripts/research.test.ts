import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  MAX_MISSION_STATE_BYTES,
  validateHumanInputs,
  validateMissionState,
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

function researchDefinition() {
  const definition = WORKFLOW_RESOURCE_DEFINITIONS.find(
    ({ name }) => name === "pi-workflow.research",
  );
  if (!definition) throw new Error("missing Research resource");
  return definition;
}

function researchScript(): string {
  const resolved = researchDefinition().resolve({});
  if (!("script" in resolved)) throw new Error(resolved.error);
  return resolved.script;
}

function missionState(externalResearchRequired = true) {
  return {
    version: 1,
    requestType: "feature",
    request: "Research the fixture.",
    phase: "discovery",
    missionStatus: "active",
    discoveryRef: "/tmp/pi-workflow-unit4/discovery.md",
    discoveryMeta: {
      version: 1,
      status: "ready",
      externalResearchRequired,
      humanClarificationRequired: false,
      uncertainties: [],
      researchQuestions: ["Which source defines DISCOVERY_RESEARCH_FACT?"],
    },
  };
}

async function executeResearch(
  results: ChildResult[],
  initialState: Record<string, unknown> = missionState(),
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
  const runScript = new Script(`(async () => {\n${researchScript()}\n})()`);
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

function successfulResearch(
  outputReference = "/tmp/pi-workflow-unit4/research.md",
) {
  return [
    {
      ok: true,
      runId: "research-run-1",
      outputReference,
      output: "saved to the managed artifact",
    },
  ];
}

describe("Research resource args and ownership", () => {
  it("accepts minimal args and rejects caller-owned fields", () => {
    expect(researchDefinition().resolve({})).toMatchObject({
      script: expect.any(String),
    });

    for (const args of [
      { unknown: true },
      { workflowScript: "caller script" },
      { outputSchema: { type: "object" } },
      { outputPath: "caller.md" },
      { discoveryReport: "full report" },
      { discoveryRef: "caller-ref" },
      { researchQuestions: ["caller question"] },
    ]) {
      expect(researchDefinition().resolve(args)).toMatchObject({
        error: expect.stringContaining("Invalid args"),
      });
    }
  });

  it("keeps full Research file-only without outputSchema", async () => {
    const execution = await executeResearch(successfulResearch());
    const params = execution.calls[0]?.params;

    expect(execution.calls.map(({ key }) => key)).toEqual(["research"]);
    expect(params).toMatchObject({
      agent: "pi-ketch.researcher",
      context: "fresh",
      async: false,
      output: "research.md",
      outputMode: "file-only",
    });
    expect(params).not.toHaveProperty("outputSchema");
    expect(params?.task).toEqual(
      expect.stringContaining("/tmp/pi-workflow-unit4/discovery.md"),
    );
  });
});

describe("Research resource Mission prerequisites", () => {
  it.each(["discoveryRef", "discoveryMeta"])(
    "fails closed when %s is missing before child launch",
    async (key) => {
      const state = missionState();
      delete state[key as keyof typeof state];
      const execution = executeResearch([], state);

      await expect(execution).rejects.toThrow();
      await execution.catch((error: Error & { calls: RunCall[] }) => {
        expect(error.calls).toHaveLength(0);
      });
    },
  );

  it("does not use another Mission's Discovery as a fallback", async () => {
    const otherMission = missionState();
    const missionWithoutDiscovery = {
      version: 1,
      requestType: "feature",
      request: "Research the fixture.",
      latestDiscoveryRef: otherMission.discoveryRef,
    };
    const execution = executeResearch(
      successfulResearch(),
      missionWithoutDiscovery,
    );

    await expect(execution).rejects.toThrow(/discoveryRef/);
    await execution.catch((error: Error & { calls: RunCall[] }) => {
      expect(error.calls).toHaveLength(0);
    });
  });

  it("keeps Research state isolated between Missions", async () => {
    const missionA = await executeResearch(
      successfulResearch("/tmp/pi-workflow-unit4/mission-a-research.md"),
      missionState(true),
    );
    const missionBState = {
      ...missionState(true),
      discoveryRef: "/tmp/pi-workflow-unit4/mission-b-discovery.md",
    };
    const missionB = await executeResearch(
      successfulResearch("/tmp/pi-workflow-unit4/mission-b-research.md"),
      missionBState,
    );

    expect(missionA.stateValues.researchRef).toBe(
      "/tmp/pi-workflow-unit4/mission-a-research.md",
    );
    expect(missionB.stateValues.researchRef).toBe(
      "/tmp/pi-workflow-unit4/mission-b-research.md",
    );
    expect(missionA.stateValues.researchRef).not.toBe(
      missionB.stateValues.researchRef,
    );
  });

  it("preserves same-Mission Discovery state while recording an explicit skip", async () => {
    const execution = await executeResearch([], missionState(false));

    expect(execution.calls).toHaveLength(0);
    expect(execution.result).toEqual({
      status: "skipped",
      researchMeta: {
        version: 1,
        status: "skipped",
        unresolvedQuestions: [],
      },
    });
    expect(execution.stateValues).toMatchObject({
      discoveryRef: "/tmp/pi-workflow-unit4/discovery.md",
      discoveryMeta: missionState(false).discoveryMeta,
      researchMeta: {
        version: 1,
        status: "skipped",
        unresolvedQuestions: [],
      },
      phase: "research",
    });
    expect(execution.stateValues).not.toHaveProperty("researchRef");
    const stateValidation = validateMissionState(
      JSON.parse(JSON.stringify(execution.stateValues)),
    );
    expect(stateValidation.ok, JSON.stringify(stateValidation)).toBe(true);
  });

  it("requires external research before launching the researcher", async () => {
    const execution = await executeResearch(
      successfulResearch(),
      missionState(true),
    );

    expect(execution.calls).toHaveLength(1);
    expect(execution.stateValues).toMatchObject({
      researchRef: "/tmp/pi-workflow-unit4/research.md",
      researchMeta: {
        version: 1,
        status: "completed",
        unresolvedQuestions: [],
      },
      phase: "research",
    });
    expect(execution.stateValues).not.toHaveProperty("research");
    expect(execution.result).toEqual({
      status: "completed",
      runId: "research-run-1",
      researchRef: "/tmp/pi-workflow-unit4/research.md",
      researchMeta: {
        version: 1,
        status: "completed",
        unresolvedQuestions: [],
      },
    });
    const stateValidation = validateMissionState(
      JSON.parse(JSON.stringify(execution.stateValues)),
    );
    expect(stateValidation.ok, JSON.stringify(stateValidation)).toBe(true);
  });
});

describe("Research resource failure behavior", () => {
  it.each([
    ["researcher unavailable", [{ ok: false, error: "agent unavailable" }]],
    ["child failure", [{ ok: false, error: "research failed" }]],
    ["missing Artifact", [{ ok: true, runId: "research-run-1" }]],
    [
      "oversized researchRef",
      [
        {
          ok: true,
          runId: "research-run-1",
          outputReference: "r".repeat(MAX_REFERENCE_BYTES),
        },
      ],
    ],
    [
      "large structured output",
      [
        {
          ok: true,
          runId: "research-run-1",
          outputReference: "/tmp/research.md",
          structuredOutput: { report: "large" },
        },
      ],
    ],
  ])("fails closed for %s", async (_label, results) => {
    const execution = executeResearch(results);

    await expect(execution).rejects.toThrow();
    await execution.catch(
      (error: Error & { stateValues: Record<string, unknown> }) => {
        expect(error.stateValues).not.toHaveProperty("researchMeta");
      },
    );
  });

  it("does not write completed metadata when state.set fails", async () => {
    const execution = executeResearch(
      successfulResearch(),
      missionState(),
      "researchMeta",
    );

    await expect(execution).rejects.toThrow("state.set failed");
    await execution.catch(
      (error: Error & { stateValues: Record<string, unknown> }) => {
        expect(error.stateValues).not.toHaveProperty("researchMeta");
      },
    );
  });

  it("rejects an oversized Mission state before child launch", async () => {
    const execution = executeResearch([], {
      ...missionState(),
      reviewDecision: "x".repeat(MAX_MISSION_STATE_BYTES),
    });

    await expect(execution).rejects.toThrow();
    await execution.catch((error: Error & { calls: RunCall[] }) => {
      expect(error.calls).toHaveLength(0);
    });
  });
});

describe("Main-only Human boundary contract", () => {
  it("keeps Human interaction out of the Research resource", () => {
    expect(researchScript()).not.toContain("ask_user_question");
    expect(researchScript()).not.toContain("Plannotator");
  });

  it("accepts bounded Human decisions and rejects oversize or excess input", () => {
    expect(
      validateHumanInputs(
        Array.from({ length: 8 }, (_, index) => ({
          id: `decision-${index}`,
          value: "answer",
        })),
      ).ok,
    ).toBe(true);
    expect(
      validateHumanInputs(
        Array.from({ length: 9 }, (_, index) => ({
          id: `decision-${index}`,
          value: "answer",
        })),
      ).ok,
    ).toBe(false);
    expect(
      validateHumanInputs([{ id: "decision", value: "あ".repeat(683) }]).ok,
    ).toBe(false);
  });
});
