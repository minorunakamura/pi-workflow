import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  validateMissionState,
  type MissionStateV1,
} from "../../src/core/state/contracts";
import { validateResourceArgs } from "../../src/core/phases/args";
import {
  validatePlanningDecision,
  type PlanningDecisionV1,
} from "../../src/core/planning/planning-decision";
import { PlanningDecisionSchema } from "../../src/core/planning/planning-decision-schema";
import { WORKFLOW_RESOURCE_DEFINITIONS } from "../../src/runtime/workflow-resources";

type ChildResult = {
  ok: boolean;
  runId?: string;
  output?: string;
  error?: string;
  stopped?: boolean;
  detached?: boolean;
  interrupted?: boolean;
  structuredOutput?: unknown;
};

type HostResult = {
  key: string;
  kind: "command";
  ok: boolean;
  state: "passed" | "failed" | "timed-out" | "stopped";
  outputPath?: string;
  stdout?: string;
  error?: string;
};

type Call = { key: string; params: Record<string, unknown> };
type Execution = {
  result: unknown;
  runCalls: Call[];
  hostCalls: Call[];
  writes: Array<{ key: string; value: unknown }>;
  stateValues: Record<string, unknown>;
};

type PlanningResourceDefinition = {
  name: string;
  resolve: (args: Readonly<Record<string, unknown>>) =>
    | {
        script: string;
        hostCommands?: readonly { key: string; command: string }[];
      }
    | { error: string };
};

const planArtifactScript = fileURLToPath(
  new URL("../../runtime/plan-artifact.mjs", import.meta.url),
);

const validDecision: PlanningDecisionV1 = {
  version: 1,
  requestSummary: "Use the fixture facts in the plan.",
  scope: {
    inScope: ["Planning resource handoff"],
    outOfScope: ["Plan Review"],
  },
  acceptanceCriteria: [
    { id: "ac-plan", text: "The plan includes the fixture facts." },
  ],
  constraints: ["Keep the migration bounded."],
  risks: ["A missing upstream reference must stop planning."],
  verification: [
    {
      id: "verify-plan",
      description: "Planning contract tests pass.",
      command: "pnpm test -- planning-resource",
    },
  ],
  implementation: {
    mode: "single",
    workUnits: [
      {
        id: "unit-plan",
        title: "Implement the planned change",
        objective: "Apply the approved planning scope.",
        dependsOn: [],
        writeScope: ["src/feature.ts"],
        acceptanceCriteriaIds: ["ac-plan"],
        focusedVerificationIds: ["verify-plan"],
      },
    ],
    finalVerificationIds: ["verify-plan"],
  },
  unresolvedDecisions: [],
};

function planningDefinition(): PlanningResourceDefinition {
  const definition = WORKFLOW_RESOURCE_DEFINITIONS.find(
    ({ name }) => name === "pi-workflow.planning",
  );
  if (!definition) throw new Error("missing Planning resource");
  return definition;
}

function planningScript(args: Record<string, unknown> = { round: 1 }): string {
  const resolved = planningDefinition().resolve(args);
  if (!("script" in resolved)) throw new Error(resolved.error);
  return resolved.script;
}

function missionState(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    requestType: "feature",
    request: "Use the Discovery and Research fixture facts.",
    phase: "research",
    discoveryRef: "/tmp/pi-workflow/discovery.md",
    discoveryMeta: {
      version: 1,
      status: "ready",
      externalResearchRequired: true,
      humanClarificationRequired: false,
      uncertainties: [],
      researchQuestions: [],
    },
    researchRef: "/tmp/pi-workflow/research.md",
    researchMeta: {
      version: 1,
      status: "completed",
      unresolvedQuestions: [],
    },
    ...overrides,
  };
}

function planState(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return missionState({
    planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
    planningDecision: validDecision,
    phase: "plan-review",
    ...overrides,
  });
}

function hostResult(overrides: Partial<HostResult> = {}): HostResult {
  return {
    key: "plan-artifact",
    kind: "command",
    ok: true,
    state: "passed",
    outputPath: "/tmp/pi-workflow/plan.md",
    stdout: "plan-artifact-written",
    ...overrides,
  };
}

async function executePlanning(
  results: ChildResult[],
  initialState = missionState(),
  args: Record<string, unknown> = { round: 1 },
  artifactResult = hostResult(),
  failSetKey?: string,
): Promise<Execution> {
  const runCalls: Call[] = [];
  const hostCalls: Call[] = [];
  const writes: Array<{ key: string; value: unknown }> = [];
  const stateValues = structuredClone(initialState);
  const queued = [...results];
  const runs = {
    run: async (key: string, params: Record<string, unknown>) => {
      runCalls.push({ key, params });
      const result = queued.shift();
      if (!result) throw new Error("test ran out of child results");
      return result;
    },
    host: async (key: string, params: Record<string, unknown>) => {
      hostCalls.push({ key, params });
      return artifactResult;
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
  const script = new Script(`(async () => {\n${planningScript(args)}\n})()`);

  try {
    const result = await script.runInContext(context);
    return { result, runCalls, hostCalls, writes, stateValues };
  } catch (error) {
    if (error && typeof error === "object") {
      Object.assign(error, { runCalls, hostCalls, writes, stateValues });
    }
    throw error;
  }
}

function childResult(
  runId: string,
  structuredOutput: unknown = validDecision,
): ChildResult {
  return { ok: true, runId, structuredOutput };
}

async function rejectedExecution(
  results: ChildResult[],
  initialState = missionState(),
  args: Record<string, unknown> = { round: 1 },
  artifactResult = hostResult(),
  failSetKey?: string,
): Promise<Error & Partial<Execution>> {
  try {
    await executePlanning(
      results,
      initialState,
      args,
      artifactResult,
      failSetKey,
    );
  } catch (error) {
    return error as Error & Partial<Execution>;
  }
  throw new Error("expected Planning to fail");
}

describe("Planning named resource contract", () => {
  it("activates only through bounded args and owns schema, child, and artifact policy", () => {
    const definition = planningDefinition();
    const resolved = definition.resolve({ round: 1 });

    expect(resolved).toMatchObject({
      script: expect.any(String),
      hostCommands: [{ key: "plan-artifact", command: expect.any(String) }],
    });
    if (!("script" in resolved)) throw new Error(resolved.error);
    expect(resolved.script).toContain('agent: "reviewer"');
    expect(resolved.script).toContain('skill: "pi-planning"');
    expect(resolved.script).toContain('context: "fresh"');
    expect(resolved.script).toContain("async: false");
    expect(resolved.script).toContain("input.planningDecisionSchema");
    expect(resolved.script).toContain('runs.host("plan-artifact"');
    expect(resolved.script).not.toContain("input.outputSchema");
    expect(resolved.script).not.toContain("input.outputPath");
    expect(resolved.script).not.toContain("input.discoveryRef");
    expect(resolved.script).not.toContain("input.researchRef");
    expect(resolved.script).not.toContain("Plannotator");

    for (const args of [
      { round: 0 },
      { round: 4 },
      { round: 1, task: "Discovery body" },
      { round: 1, discoveryRef: "caller-ref" },
      { round: 1, researchRef: "caller-ref" },
      { round: 1, discoveryReport: "full report" },
      { round: 1, researchReport: "full report" },
      { round: 1, planningDecision: validDecision },
      { round: 1, plan: "full plan" },
      { round: 1, outputSchema: PlanningDecisionSchema },
      { round: 1, outputPath: "caller.md" },
      { round: 1, workflowScript: "caller script" },
    ]) {
      expect(definition.resolve(args)).toMatchObject({
        error: expect.stringContaining("Invalid args"),
      });
    }
  });

  it("uses same-Mission upstream refs and returns a compact artifact reference", async () => {
    const execution = await executePlanning([childResult("planning-run-1")]);
    const child = execution.runCalls[0];

    expect(execution.runCalls).toHaveLength(1);
    expect(child?.key).toBe("planning");
    expect(child?.params).toMatchObject({
      agent: "reviewer",
      skill: "pi-planning",
      context: "fresh",
      async: false,
      outputSchema: PlanningDecisionSchema,
      outputMode: "file-only",
    });
    expect(child?.params.output).toEqual(
      expect.stringContaining("planning-decision-"),
    );
    expect(child?.params.task).toEqual(
      expect.stringContaining("Planning round: 1"),
    );
    expect(child?.params.task).toEqual(expect.stringContaining("discovery.md"));
    expect(child?.params.task).toEqual(expect.stringContaining("research.md"));
    expect(child?.params.task).not.toContain("DISCOVERY_BODY");
    expect(child?.params.task).not.toContain("RESEARCH_BODY");

    expect(execution.hostCalls).toEqual([
      {
        key: "plan-artifact",
        params: {
          kind: "command",
          command: expect.any(String),
          timeoutMs: 120_000,
        },
      },
    ]);
    expect(execution.result).toEqual({
      status: "completed",
      runId: "planning-run-1",
      planRef: expect.stringMatching(/\/pi-workflow\/plan-[0-9a-f-]+\.md$/),
      planningCorrectionCount: 0,
    });
    expect(execution.result).not.toHaveProperty("planningDecision");
    expect(execution.result).not.toHaveProperty("output");
    expect(JSON.stringify(execution.result)).not.toContain(
      "DISCOVERY_PLAN_FACT",
    );
    expect(execution.stateValues).toMatchObject({
      discoveryRef: "/tmp/pi-workflow/discovery.md",
      researchRef: "/tmp/pi-workflow/research.md",
      planningDecision: validDecision,
      planRef: expect.stringMatching(/\/pi-workflow\/plan-[0-9a-f-]+\.md$/),
      phase: "plan-review",
    });
    expect(execution.stateValues).not.toHaveProperty("plan");
    expect(execution.stateValues).not.toHaveProperty("planBody");
    expect(
      validateMissionState(execution.stateValues as MissionStateV1),
    ).toMatchObject({
      ok: true,
    });
  });

  it("accepts absent Research state when Discovery says it is unnecessary", async () => {
    const state = missionState({
      discoveryMeta: {
        version: 1,
        status: "ready",
        externalResearchRequired: false,
        humanClarificationRequired: false,
        uncertainties: [],
        researchQuestions: [],
      },
    });
    delete state.researchRef;
    delete state.researchMeta;
    const execution = await executePlanning(
      [childResult("planning-skipped")],
      state,
    );

    expect(execution.runCalls[0]?.params.task).toEqual(
      expect.stringContaining(
        "External Research: not required. No Research Artifact exists.",
      ),
    );
    expect(execution.runCalls[0]?.params.task).not.toContain("research.md");
    expect(execution.result).toMatchObject({
      status: "completed",
      planRef: expect.any(String),
    });
    expect(execution.stateValues).not.toHaveProperty("researchRef");
    expect(execution.stateValues).not.toHaveProperty("researchMeta");
  });
});

describe("Plan Review control operations", () => {
  it("prepares a review without launching any child", async () => {
    const execution = await executePlanning([], planState(), {
      operation: "prepare-review",
      round: 1,
      planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
    });

    expect(execution.runCalls).toHaveLength(0);
    expect(execution.hostCalls).toHaveLength(0);
    expect(execution.result).toEqual({
      status: "ready",
      round: 1,
      planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
    });
    expect(execution.stateValues.planReview).toEqual({
      version: 1,
      status: "pending",
      round: 1,
      planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
    });
  });

  it("records a terminal approval or rejection once without children", async () => {
    const prepared = planState({
      planReview: {
        version: 1,
        status: "pending",
        round: 1,
        planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
      },
    });
    const approved = await executePlanning([], prepared, {
      operation: "record-review",
      round: 1,
      planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
      reviewId: "review-1",
      status: "approved",
    });
    expect(approved.runCalls).toHaveLength(0);
    expect(approved.writes.map(({ key }) => key)).toEqual(["planReview"]);
    expect(approved.result).toMatchObject({ status: "approved" });

    const rejected = await executePlanning([], prepared, {
      operation: "record-review",
      round: 1,
      planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
      reviewId: "review-1",
      status: "rejected",
      feedbackRef: "/tmp/pi-workflow/plan-review/feedback-r1.md",
    });
    expect(rejected.runCalls).toHaveLength(0);
    expect(rejected.writes.map(({ key }) => key)).toEqual(["planReview"]);
    expect(rejected.result).toMatchObject({
      status: "rejected",
      feedbackRef: "/tmp/pi-workflow/plan-review/feedback-r1.md",
    });
  });

  it("returns compact Mission-bound recovery metadata", async () => {
    const execution = await executePlanning(
      [],
      planState({
        planReview: {
          version: 1,
          status: "pending",
          round: 1,
          planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
          reviewId: "review-recovery",
        },
      }),
      {
        operation: "review-status",
        round: 1,
        planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
      },
    );

    expect(execution.runCalls).toHaveLength(0);
    expect(execution.result).toEqual({
      status: "pending",
      round: 1,
      planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
      reviewId: "review-recovery",
    });
    expect(JSON.stringify(execution.result)).not.toContain("requestSummary");
  });

  it.each([
    [
      "planRef mismatch",
      {
        operation: "prepare-review",
        round: 1,
        planRef: "/tmp/pi-workflow/plan-review/other.md",
      },
    ],
    [
      "wrong round",
      {
        operation: "prepare-review",
        round: 2,
        planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
      },
    ],
    [
      "unresolved decisions",
      {
        operation: "prepare-review",
        round: 1,
        planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
      },
    ],
  ] as const)("fails closed for %s before a child", async (label, args) => {
    const state =
      label === "unresolved decisions"
        ? planState({
            planningDecision: {
              ...validDecision,
              unresolvedDecisions: [
                { id: "decision", question: "Choose.", reason: "Unknown." },
              ],
            },
          })
        : label === "wrong round"
          ? planState({
              planReview: {
                version: 1,
                status: "pending",
                round: 1,
                planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
                reviewId: "review-current",
              },
            })
          : planState();
    const error = await rejectedExecution([], state, args);
    expect(error.runCalls).toHaveLength(0);
    expect(error.hostCalls).toHaveLength(0);
  });

  it("rejects stale review IDs, invalid transitions, and missing rejection feedback", async () => {
    const state = planState({
      planReview: {
        version: 1,
        status: "pending",
        round: 1,
        planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
        reviewId: "review-current",
      },
    });
    for (const args of [
      {
        operation: "record-review",
        round: 1,
        planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
        reviewId: "review-old",
        status: "approved",
      },
      {
        operation: "record-review",
        round: 1,
        planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
        reviewId: "review-current",
        status: "rejected",
      },
    ] as const) {
      const error = await rejectedExecution([], state, args);
      expect(error.runCalls).toHaveLength(0);
    }

    const terminal = await executePlanning([], state, {
      operation: "record-review",
      round: 1,
      planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
      reviewId: "review-current",
      status: "approved",
    });
    const transition = await rejectedExecution([], terminal.stateValues, {
      operation: "record-review",
      round: 1,
      planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
      reviewId: "review-current",
      status: "rejected",
      feedbackRef: "/tmp/pi-workflow/plan-review/feedback-r1.md",
    });
    expect(transition.runCalls).toHaveLength(0);
    expect(transition.writes).toHaveLength(0);
  });

  it("fails closed when control state persistence fails", async () => {
    const error = await rejectedExecution(
      [],
      planState(),
      {
        operation: "prepare-review",
        round: 1,
        planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
      },
      hostResult(),
      "planReview",
    );
    expect(error.runCalls).toHaveLength(0);
  });

  it("fails closed for an incomplete start/persistence binding", async () => {
    const error = await rejectedExecution(
      [],
      planState({
        planReview: {
          version: 1,
          status: "pending",
          round: 1,
          planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
        },
      }),
      {
        operation: "review-status",
        round: 1,
        planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
      },
    );
    expect(error.message).toContain("reviewId");
    expect(error.runCalls).toHaveLength(0);
  });

  it("prevents starting a second review for an existing pending binding", async () => {
    const execution = await executePlanning(
      [],
      planState({
        planReview: {
          version: 1,
          status: "pending",
          round: 1,
          planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
          reviewId: "review-existing",
        },
      }),
      {
        operation: "prepare-review",
        round: 1,
        planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
      },
    );
    expect(execution.runCalls).toHaveLength(0);
    expect(execution.result).toEqual({
      status: "pending",
      round: 1,
      planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
      reviewId: "review-existing",
    });
  });

  it("reuses Planning for rounds two and three but never accepts round four", async () => {
    const rejectedRound1 = planState({
      planReview: {
        version: 1,
        status: "rejected",
        round: 1,
        planRef: "/tmp/pi-workflow/plan-review/plan-r1.md",
        reviewId: "review-1",
        feedbackRef: "/tmp/pi-workflow/plan-review/feedback-r1.md",
      },
    });
    const round2 = await executePlanning(
      [childResult("planning-round-2")],
      rejectedRound1,
      { round: 2, feedbackRef: "/tmp/pi-workflow/plan-review/feedback-r1.md" },
    );
    expect(round2.runCalls).toHaveLength(1);

    const preparedRound2 = await executePlanning([], round2.stateValues, {
      operation: "prepare-review",
      round: 2,
      planRef: round2.stateValues.planRef as string,
    });
    expect(preparedRound2.result).toMatchObject({ status: "ready", round: 2 });
    const rejectedRound2 = await executePlanning(
      [],
      preparedRound2.stateValues,
      {
        operation: "record-review",
        round: 2,
        planRef: preparedRound2.stateValues.planRef,
        reviewId: "review-2",
        status: "rejected",
        feedbackRef: "/tmp/pi-workflow/plan-review/feedback-r2.md",
      },
    );
    const round3 = await executePlanning(
      [childResult("planning-round-3")],
      rejectedRound2.stateValues,
      { round: 3, feedbackRef: "/tmp/pi-workflow/plan-review/feedback-r2.md" },
    );
    expect(round3.runCalls).toHaveLength(1);
    expect(
      validateResourceArgs("planning", {
        round: 4,
        feedbackRef: "/tmp/pi-workflow/plan-review/feedback-r3.md",
      }).ok,
    ).toBe(false);
  });
});

describe("Planning prerequisites", () => {
  it.each(["discoveryRef", "discoveryMeta", "researchMeta"])(
    "fails closed before child launch when %s is missing",
    async (key) => {
      const state = missionState();
      delete state[key];
      const error = await rejectedExecution([], state);
      expect(error.runCalls).toHaveLength(0);
      expect(error.hostCalls).toHaveLength(0);
    },
  );

  it("does not treat a blocked or absent Research decision as skipped", async () => {
    const blocked = await rejectedExecution(
      [],
      missionState({
        researchMeta: {
          version: 1,
          status: "blocked",
          unresolvedQuestions: [],
        },
      }),
    );
    expect(blocked.runCalls).toHaveLength(0);

    const absent = await rejectedExecution(
      [],
      missionState({
        researchMeta: undefined,
        researchRef: undefined,
      }),
    );
    expect(absent.message).toContain("completed Research");
    expect(absent.runCalls).toHaveLength(0);
  });

  it("requires a completed Research reference and rejects inconsistent skipped state", async () => {
    const missingRef = await rejectedExecution(
      [],
      missionState({ researchRef: undefined }),
    );
    expect(missingRef.message).toContain("researchRef");
    expect(missingRef.runCalls).toHaveLength(0);

    const skippedWithRef = await rejectedExecution(
      [],
      missionState({
        discoveryMeta: {
          version: 1,
          status: "ready",
          externalResearchRequired: false,
          humanClarificationRequired: false,
          uncertainties: [],
          researchQuestions: [],
        },
        researchMeta: {
          version: 1,
          status: "completed",
          unresolvedQuestions: [],
        },
      }),
    );
    expect(skippedWithRef.message).toContain("Research state to be absent");
    expect(skippedWithRef.runCalls).toHaveLength(0);
  });

  it("requires valid bounded Human decisions when clarification is required", async () => {
    const state = missionState({
      discoveryMeta: {
        version: 1,
        status: "ready",
        externalResearchRequired: true,
        humanClarificationRequired: true,
        uncertainties: [
          { id: "choice", question: "Choose one.", material: true },
        ],
        researchQuestions: [],
      },
    });
    const missing = await rejectedExecution([], state);
    expect(missing.message).toContain("humanDecisions");
    expect(missing.runCalls).toHaveLength(0);

    const withInput = await executePlanning(
      [childResult("planning-human")],
      state,
      {
        round: 1,
        humanInputs: [{ id: "choice", value: "Use the existing API." }],
      },
    );
    expect(withInput.stateValues.humanDecisions).toEqual([
      { id: "choice", value: "Use the existing API." },
    ]);
    expect(withInput.runCalls[0]?.params.task).toEqual(
      expect.stringContaining("Use the existing API."),
    );
  });

  it("requires feedback from the previous rejected Plan Review", async () => {
    const previous = {
      version: 1,
      status: "rejected",
      round: 1,
      planRef: "/tmp/mission-a/plan.md",
      reviewId: "review-a",
      feedbackRef: "/tmp/mission-a/feedback.md",
    };
    const state = missionState({
      planRef: "/tmp/mission-a/plan.md",
      planReview: previous,
    });

    const foreign = await rejectedExecution([], state, {
      round: 2,
      feedbackRef: "/tmp/mission-b/feedback.md",
    });
    expect(foreign.message).toContain("same Mission");
    expect(foreign.runCalls).toHaveLength(0);

    const accepted = await executePlanning(
      [childResult("planning-feedback")],
      state,
      { round: 2, feedbackRef: "/tmp/mission-a/feedback.md" },
    );
    expect(accepted.runCalls[0]?.params.task).toEqual(
      expect.stringContaining("/tmp/mission-a/feedback.md"),
    );
  });
});

describe("Planning decision validation and correction", () => {
  it("runs one bounded correction inside the resource for semantic errors", async () => {
    const invalid = structuredClone(validDecision);
    invalid.implementation.workUnits[0].dependsOn = ["none"];
    const execution = await executePlanning([
      childResult("planning-invalid", invalid),
      childResult("planning-correction", validDecision),
    ]);

    expect(execution.runCalls.map(({ key }) => key)).toEqual([
      "planning",
      "planning-correction",
    ]);
    expect(execution.runCalls[1]?.params).toMatchObject({
      agent: "reviewer",
      skill: "pi-planning",
      context: "fresh",
      async: false,
      outputSchema: PlanningDecisionSchema,
    });
    expect(execution.runCalls[1]?.params.output).not.toBe(
      execution.runCalls[0]?.params.output,
    );
    expect(execution.runCalls[1]?.params.task).toEqual(
      expect.stringContaining("/implementation/workUnits/0/dependsOn/0"),
    );
    expect(execution.result).toMatchObject({
      status: "completed",
      planningCorrectionCount: 1,
    });
    expect(execution.hostCalls).toHaveLength(1);
  });

  it("fails closed for schema-invalid, oversized, and correction-exhausted results", async () => {
    const schemaInvalid = { ...validDecision, unexpected: true };
    const schemaError = await rejectedExecution([
      childResult("planning-schema-invalid", schemaInvalid),
    ]);
    expect(schemaError.message).toContain("schema validation");
    expect(schemaError.runCalls).toHaveLength(1);
    expect(schemaError.hostCalls).toHaveLength(0);

    const oversized = structuredClone(validDecision);
    oversized.requestSummary = `${"あ".repeat(342)}`;
    const oversizedError = await rejectedExecution([
      childResult("planning-oversized", oversized),
      childResult("planning-oversized-correction", oversized),
    ]);
    expect(oversizedError.message).toContain("after one automatic correction");
    expect(oversizedError.runCalls).toHaveLength(2);
    expect(oversizedError.hostCalls).toHaveLength(0);

    const invalid = structuredClone(validDecision);
    invalid.implementation.workUnits[0].writeScope = [];
    const exhausted = await rejectedExecution([
      childResult("planning-invalid", invalid),
      childResult("planning-correction-invalid", invalid),
    ]);
    expect(exhausted.message).toContain("after one automatic correction");
    expect(exhausted.runCalls).toHaveLength(2);
    expect(exhausted.hostCalls).toHaveLength(0);
    expect(exhausted.stateValues).not.toHaveProperty("planningDecision");
    expect(exhausted.stateValues).not.toHaveProperty("planRef");
    expect(exhausted.stateValues).not.toHaveProperty("phase", "plan-review");
  });

  it("rejects missing structured output without correction", async () => {
    const error = await rejectedExecution([
      { ok: true, runId: "planning-no-output" },
    ]);
    expect(error.message).toContain("did not return structured output");
    expect(error.runCalls).toHaveLength(1);
    expect(error.hostCalls).toHaveLength(0);
  });
});

describe("Plan Artifact and Mission state failure semantics", () => {
  it("does not update state when Artifact generation fails or is empty", async () => {
    for (const artifact of [
      hostResult({ ok: false, state: "failed", error: "renderer failed" }),
      hostResult({ stdout: "" }),
    ]) {
      const error = await rejectedExecution(
        [childResult("planning-run")],
        missionState(),
        { round: 1 },
        artifact,
      );
      expect(error.message).toMatch(/Plan Artifact generation/);
      expect(error.hostCalls).toHaveLength(1);
      expect(error.stateValues).not.toHaveProperty("planningDecision");
      expect(error.stateValues).not.toHaveProperty("planRef");
      expect(error.stateValues).not.toHaveProperty("phase", "plan-review");
    }
  });

  it("writes planningDecision and planRef before the final phase marker", async () => {
    const execution = await executePlanning([childResult("planning-run")]);
    expect(execution.writes.map(({ key }) => key)).toEqual([
      "planningDecision",
      "planRef",
      "phase",
    ]);
  });

  it("fails closed when state.set cannot commit the Plan handoff", async () => {
    const execution = executePlanning(
      [childResult("planning-run")],
      missionState(),
      { round: 1 },
      hostResult(),
      "planRef",
    );
    await expect(execution).rejects.toThrow("state.set failed for planRef");
    await execution.catch((error: Error & Partial<Execution>) => {
      expect(error.stateValues).toHaveProperty(
        "planningDecision",
        validDecision,
      );
      expect(error.stateValues).not.toHaveProperty("planRef");
      expect(error.stateValues).not.toHaveProperty("phase", "plan-review");
    });
  });

  it("keeps Plan prose out of state and workflow.value while preserving upstream state", async () => {
    const execution = await executePlanning([childResult("planning-run")]);
    const state = execution.stateValues as MissionStateV1;
    expect(state.discoveryRef).toBe("/tmp/pi-workflow/discovery.md");
    expect(state.researchRef).toBe("/tmp/pi-workflow/research.md");
    expect(state).not.toHaveProperty("planBody");
    expect(state).not.toHaveProperty("report");
    expect(JSON.stringify(execution.result)).not.toContain("# Plan");
    expect(validatePlanningDecision(state.planningDecision).ok).toBe(true);
  });

  it("writes the deterministic canonical Plan Artifact without returning its body", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-workflow-plan-artifact-"));
    const firstPath = join(directory, "first.json");
    const secondPath = join(directory, "second.json");
    const outputPath = join(directory, "plan.md");
    const second = {
      ...structuredClone(validDecision),
      requestSummary: "second",
    };
    try {
      writeFileSync(firstPath, JSON.stringify(validDecision));
      writeFileSync(secondPath, JSON.stringify(second));
      const marker = execFileSync(
        process.execPath,
        [planArtifactScript, "--output", outputPath, firstPath, secondPath],
        { encoding: "utf8" },
      );

      expect(marker).toBe("plan-artifact-written");
      expect(readFileSync(outputPath, "utf8")).toBe(
        execFileSync(process.execPath, [planArtifactScript, secondPath], {
          encoding: "utf8",
        }),
      );
      expect(readFileSync(outputPath, "utf8")).not.toBe(JSON.stringify(second));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
