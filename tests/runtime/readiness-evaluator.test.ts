import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

import {
  REQUIRED_PLAN_HEADINGS,
  createFindingId,
  createPlanningHandoff,
  createWorkflowId,
  hashPlan,
  type TrustedGate,
} from "../../src/core/index.ts";
import {
  READINESS_EVALUATOR_TOOL_NAME,
  READINESS_EVALUATOR_TOOL_PARAMETERS,
  default as readinessEvaluatorChildExtension,
  evaluateReadinessFromAuthoritativeInput,
  type ReadinessEvaluatorToolInput,
} from "../../src/runtime/readiness-evaluator.ts";

const WORKFLOW_ID = createWorkflowId("00000000-0000-4000-8000-000000000051");
const REVIEW_ID = "plan-review-51";
const REQUIRED_GATE_MARKER =
  '<!-- pi-workflow-trusted-gates: [{"name":"package-check","command":"pnpm check","requirement":"required","source":"package-script"}] -->';
const OPTIONAL_GATE_MARKER =
  '<!-- pi-workflow-trusted-gates: [{"name":"docs-check","command":"pnpm docs","requirement":"optional","source":"package-script"}] -->';
function planWithGateMarker(marker: string): string {
  return `${REQUIRED_PLAN_HEADINGS.join("\n").replace(
    "## Trusted Gate expectations",
    `## Trusted Gate expectations\n\n${marker}`,
  )}\n`;
}
const PLAN = planWithGateMarker(REQUIRED_GATE_MARKER);
const OPTIONAL_PLAN = planWithGateMarker(OPTIONAL_GATE_MARKER);
const roots: string[] = [];

function gate(
  status: TrustedGate["status"],
  requirement: TrustedGate["requirement"] = "required",
  name = "package-check",
  command = "pnpm check",
): TrustedGate {
  return {
    name,
    command,
    requirement,
    status,
    source: "package-script",
    ...(status === "PASS"
      ? {
          evidence: {
            kind: "managed",
            path: "/managed/gates/package-check.log",
            mediaType: "text/plain",
          },
        }
      : { reason: `${status} evidence` }),
  };
}

function setup(plan = PLAN): {
  cwd: string;
  input: ReadinessEvaluatorToolInput;
} {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflow-readiness-"));
  roots.push(cwd);
  const planPath = join(cwd, "implementation-plan.md");
  const handoffPath = join(cwd, "planning-handoff.json");
  writeFileSync(planPath, plan);
  const handoff = createPlanningHandoff({
    workflowId: WORKFLOW_ID,
    planContent: plan,
    tddMode: "not-applicable",
    testStrategy: {
      kind: "unit",
      required: true,
      summary: "Run the package check.",
    },
    testSeams: ["readiness adapter"],
    constraints: ["Use the core evaluator."],
    nonGoals: ["Do not merge."],
  });
  if (!handoff.valid) throw new Error(handoff.errors.join("; "));
  writeFileSync(handoffPath, `${JSON.stringify(handoff.value)}\n`);

  const planHash = hashPlan(plan).value;
  const input: ReadinessEvaluatorToolInput = {
    workflowId: WORKFLOW_ID,
    planArtifactRef: {
      kind: "managed",
      path: planPath,
      mediaType: "text/markdown",
    },
    planningHandoffRef: {
      kind: "managed",
      path: handoffPath,
      mediaType: "application/json",
    },
    approval: {
      approvedPlanHash: planHash,
      reviewId: REVIEW_ID,
      approval: true,
    },
    implementationComplete: true,
    gates: [gate("PASS")],
    repositoryGates: [gate("UNKNOWN")],
    findings: [],
    fixWave: null,
    focusedReReview: null,
    finalDiffInspection: "PASS",
    codeReview: { status: "approved", approved: true },
  };
  return { cwd, input };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it("registers the readiness evaluator only as a child-only tool", () => {
  const registered: string[] = [];
  const pi = {
    registerTool(tool: { name: string }) {
      registered.push(tool.name);
    },
  };

  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  readinessEvaluatorChildExtension(pi);
  expect(registered).toEqual([]);

  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  readinessEvaluatorChildExtension(pi);
  vi.unstubAllEnvs();
  expect(registered).toEqual([READINESS_EVALUATOR_TOOL_NAME]);
  expect(READINESS_EVALUATOR_TOOL_PARAMETERS.properties).not.toHaveProperty(
    "approvedGates",
  );
  expect(READINESS_EVALUATOR_TOOL_PARAMETERS.properties).not.toHaveProperty(
    "requiredGateKeys",
  );
});

it("uses the core evaluator for authoritative Plan identity and returns seven checks", async () => {
  const { cwd, input } = setup();
  const result = await evaluateReadinessFromAuthoritativeInput(input, cwd);

  expect(result.ready).toBe(true);
  expect(result.status).toBe("READY_FOR_MERGE");
  expect(result.checks).toHaveLength(7);
  expect(result.blockers).toEqual([]);
  expect(result.checks).toContainEqual(
    expect.objectContaining({ id: "required-gates", status: "PASS" }),
  );
});

it("does not trust a caller's desired ready value when a required Gate fails", async () => {
  const { cwd, input } = setup();
  const result = await evaluateReadinessFromAuthoritativeInput(
    {
      ...input,
      gates: [gate("FAIL")],
    },
    cwd,
  );

  expect(result.ready).toBe(false);
  expect(result.status).toBe("BLOCKED");
  expect(result.checks).toContainEqual(
    expect.objectContaining({ id: "required-gates", status: "FAIL" }),
  );
});

it("keeps optional SKIPPED Gates non-blocking", async () => {
  const { cwd, input } = setup(OPTIONAL_PLAN);
  const result = await evaluateReadinessFromAuthoritativeInput(
    {
      ...input,
      gates: [gate("SKIPPED", "optional", "docs-check", "pnpm docs")],
      repositoryGates: undefined,
    },
    cwd,
  );

  expect(result.ready).toBe(true);
});

it("cannot remove a Plan-derived required Gate by omitting the final Gate", async () => {
  const { cwd, input } = setup();
  const result = await evaluateReadinessFromAuthoritativeInput(
    { ...input, gates: [], repositoryGates: [] },
    cwd,
  );

  expect(result.ready).toBe(false);
  expect(result.checks).toContainEqual(
    expect.objectContaining({ id: "required-gates" }),
  );
});

it("blocks Plan-derived required Gate FAIL, UNKNOWN, and SKIPPED outcomes", async () => {
  for (const status of ["FAIL", "UNKNOWN", "SKIPPED"] as const) {
    const { cwd, input } = setup();
    const result = await evaluateReadinessFromAuthoritativeInput(
      { ...input, gates: [gate(status)] },
      cwd,
    );
    expect(result.ready).toBe(false);
  }
});

it("fails closed when the Plan Gate declaration is not machine-readable", async () => {
  const invalidPlan = planWithGateMarker(
    "<!-- pi-workflow-trusted-gates: { -->",
  );
  const { cwd, input } = setup(invalidPlan);

  await expect(
    evaluateReadinessFromAuthoritativeInput(input, cwd),
  ).rejects.toThrow(/Trusted Gate expectations|valid JSON|machine-readable/u);
});

it("fails closed for unresolved findings, missing focused review, bad diff, and rejected review", async () => {
  const { cwd, input } = setup();
  const findingId = createFindingId("00000000-0000-4000-8000-000000000052");
  const result = await evaluateReadinessFromAuthoritativeInput(
    {
      ...input,
      findings: [
        {
          findingId,
          disposition: "FIX_NOW",
          resolved: false,
          reason: "Must be fixed.",
        },
      ],
      fixWave: { waveNumber: 1, acceptedFindingIds: [findingId] },
      focusedReReview: null,
      finalDiffInspection: "UNKNOWN",
      codeReview: { status: "rejected", approved: false },
    },
    cwd,
  );

  expect(result.ready).toBe(false);
  expect(result.blockers.map(({ code }) => code)).toEqual(
    expect.arrayContaining([
      "accepted-findings",
      "focused-re-review",
      "final-diff-inspection",
      "code-review",
    ]),
  );
});

it("requires a resolved fresh Focused Re-review after a Fix Wave", async () => {
  const { cwd, input } = setup();
  const findingId = createFindingId("00000000-0000-4000-8000-000000000053");
  const result = await evaluateReadinessFromAuthoritativeInput(
    {
      ...input,
      findings: [
        {
          findingId,
          disposition: "FIX_NOW",
          resolved: true,
          reason: "Fixed in the bounded wave.",
        },
      ],
      fixWave: { waveNumber: 1, acceptedFindingIds: [findingId] },
      focusedReReview: {
        status: "STILL_PRESENT",
        fresh: true,
        readOnly: true,
      },
    },
    cwd,
  );

  expect(result.ready).toBe(false);
  expect(result.checks).toContainEqual(
    expect.objectContaining({ id: "focused-re-review", status: "FAIL" }),
  );
});

it("blocks every non-pass Final Diff and Code Review outcome", async () => {
  for (const finalDiffInspection of ["FAIL", "UNKNOWN", "MISSING"] as const) {
    const { cwd, input } = setup();
    const result = await evaluateReadinessFromAuthoritativeInput(
      { ...input, finalDiffInspection },
      cwd,
    );
    expect(result.ready).toBe(false);
  }

  for (const status of [
    "rejected",
    "unavailable",
    "timeout",
    "failed",
  ] as const) {
    const { cwd, input } = setup();
    const result = await evaluateReadinessFromAuthoritativeInput(
      { ...input, codeReview: { status, approved: false } },
      cwd,
    );
    expect(result.ready).toBe(false);
  }
});

it("returns blocked readiness when the current Plan Artifact does not match the Handoff", async () => {
  const { cwd, input } = setup();
  writeFileSync(join(cwd, "implementation-plan.md"), `${PLAN}changed\n`);

  const result = await evaluateReadinessFromAuthoritativeInput(input, cwd);

  expect(result.ready).toBe(false);
  expect(result.checks).toContainEqual(
    expect.objectContaining({ id: "approved-plan-identity" }),
  );
});

it("keeps the adapter thin and delegates the decision to the core evaluator", () => {
  const source = readFileSync(
    new URL("../../src/runtime/readiness-evaluator.ts", import.meta.url),
    "utf8",
  );

  expect(source).toContain("evaluateReadyForMerge(");
  expect(source).not.toContain('id: "required-gates"');
  expect(source).not.toContain('id: "accepted-findings"');
  expect(source).not.toContain('id: "focused-re-review"');
});
