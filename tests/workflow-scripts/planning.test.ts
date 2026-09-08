import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderPhase } from "../../src/core/phases/render-phase";
import type { PlanningDecisionV1 } from "../../src/core/planning/planning-decision";

type RunResult = {
  ok: boolean;
  runId?: string;
  outputReference?: string;
  output?: string;
  error?: string;
  structuredOutput?: unknown;
};

type RunCall = {
  key: string;
  params: Record<string, unknown>;
};

type Runs = {
  run: (key: string, params: Record<string, unknown>) => Promise<RunResult>;
};

type State = {
  set: (key: string, value: unknown) => Promise<void>;
};

const validDecision: PlanningDecisionV1 = {
  version: 1,
  requestSummary: "Add a search endpoint.",
  scope: { inScope: ["Search endpoint"], outOfScope: ["UI changes"] },
  acceptanceCriteria: [{ id: "ac-search", text: "Searches records." }],
  constraints: ["Keep the API compatible."],
  risks: ["Large result sets may be slow."],
  verification: [
    {
      id: "verify-search",
      description: "Search tests pass.",
      command: "pnpm test",
    },
  ],
  implementation: {
    mode: "single",
    workUnits: [
      {
        id: "search-api",
        title: "Implement search",
        objective: "Add the endpoint.",
        dependsOn: [],
        writeScope: ["src/api/search.ts"],
        acceptanceCriteriaIds: ["ac-search"],
        focusedVerificationIds: ["verify-search"],
      },
    ],
    finalVerificationIds: ["verify-search"],
  },
  unresolvedDecisions: [],
};

function invalidDecision(): PlanningDecisionV1 {
  const decision = structuredClone(validDecision);
  decision.implementation.workUnits[0].dependsOn = ["なし"];
  return decision;
}

function executePlanning(results: RunResult[]) {
  const prepared = renderPhase("planning", {
    task: "Plan the requested change.",
    outputSchema: { type: "object", additionalProperties: false },
  });
  const calls: RunCall[] = [];
  const stateWrites: Array<{ key: string; value: unknown }> = [];
  const queued = [...results];
  const runs: Runs = {
    run: async (key, params) => {
      calls.push({ key, params });
      const result = queued.shift();
      if (!result) throw new Error("test ran out of child results");
      return result;
    },
  };
  const state: State = {
    set: async (key, value) => {
      stateWrites.push({ key, value });
    },
  };
  const context = createContext({ runs, state });
  const runScript = new Script(
    `(async () => {\n${prepared.workflowScript}\n})()`,
  );

  return Promise.resolve(runScript.runInContext(context)).then((result) => ({
    result,
    calls,
    stateWrites,
  }));
}

function childResult(runId: string, decision: unknown): RunResult {
  return { ok: true, runId, structuredOutput: decision };
}

describe("planning workflow semantic validation", () => {
  it("passes schema and semantic validation without correction for a valid result", async () => {
    const execution = await executePlanning([
      childResult("planning-1", validDecision),
    ]);

    expect(execution.calls).toHaveLength(1);
    expect(execution.calls[0]?.key).toBe("planning");
    expect(execution.calls[0]?.params.outputSchema).toEqual({
      type: "object",
      additionalProperties: false,
    });
    expect(execution.result).toMatchObject({
      planningDecision: validDecision,
      planningCorrectionCount: 0,
    });
    expect(execution.stateWrites).toContainEqual({
      key: "planningCorrectionCount",
      value: 0,
    });
  });

  it("returns semantic validation errors to one automatic correction", async () => {
    const corrected = structuredClone(validDecision);
    const execution = await executePlanning([
      childResult("planning-1", invalidDecision()),
      childResult("planning-correction-1", corrected),
    ]);

    expect(execution.calls.map((call) => call.key)).toEqual([
      "planning",
      "planning-correction",
    ]);
    expect(execution.calls[1]?.params.task).toEqual(
      expect.stringContaining("dependsOn: []"),
    );
    expect(execution.calls[1]?.params.task).toEqual(
      expect.stringContaining("/implementation/workUnits/0/dependsOn/0"),
    );
    expect(execution.calls[1]?.params.outputSchema).toEqual(
      execution.calls[0]?.params.outputSchema,
    );
    expect(execution.result).toMatchObject({
      planningDecision: corrected,
      planningCorrectionCount: 1,
    });
    expect(execution.stateWrites).toContainEqual({
      key: "phase",
      value: "plan-review",
    });
  });

  it("stops as planning-invalid when the one correction is still invalid", async () => {
    const execution = executePlanning([
      childResult("planning-1", invalidDecision()),
      childResult("planning-correction-1", invalidDecision()),
      childResult("unexpected-third-run", validDecision),
    ]);
    await expect(execution).rejects.toThrow(
      "semantic validation still failed after one automatic correction",
    );
  });
});
