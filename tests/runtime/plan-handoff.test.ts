import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  REQUIRED_PLAN_HEADINGS,
  createWorkflowId,
  hashPlan,
} from "../../src/core/index.ts";
import {
  PLAN_HANDOFF_TOOL_NAME,
  default as planningHandoffChildExtension,
  writePlanningHandoffArtifact,
  type PlanHandoffToolInput,
} from "../../src/runtime/plan-handoff.ts";

const WORKFLOW_ID = createWorkflowId("00000000-0000-4000-8000-000000000002");
const PLAN = `${REQUIRED_PLAN_HEADINGS.join("\n")}\n\nBounded plan.\n`;
const roots: string[] = [];

function input(): PlanHandoffToolInput {
  return {
    workflowId: WORKFLOW_ID,
    planArtifactRef: {
      kind: "managed",
      path: "artifacts/implementation-plan.md",
      mediaType: "text/markdown",
    },
    planningHandoffRef: {
      kind: "managed",
      path: "artifacts/planning-handoff.json",
      mediaType: "application/json",
    },
    tddMode: "required",
    testStrategy: {
      kind: "unit",
      required: true,
      summary: "Run focused tests.",
    },
    testSeams: ["core validator"],
    constraints: ["No source writes."],
    nonGoals: ["No implementation."],
    planningRunId: "planning-run-1",
  };
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-plan-"));
  roots.push(root);
  mkdirSync(join(root, "artifacts"));
  writeFileSync(join(root, "artifacts/implementation-plan.md"), PLAN);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("creates one immutable-schema Handoff beside the managed Plan", async () => {
  const root = makeRoot();
  const details = await writePlanningHandoffArtifact(input(), root);
  const persisted: unknown = JSON.parse(
    readFileSync(join(root, "artifacts/planning-handoff.json"), "utf8"),
  );

  expect(details.planHash).toEqual(hashPlan(PLAN));
  expect(persisted).toMatchObject({
    schemaVersion: 1,
    kind: "pi-workflow.planning-handoff",
    workflowId: WORKFLOW_ID,
    planArtifact: {
      path: "implementation-plan.md",
      mediaType: "text/markdown",
    },
  });
  expect(persisted).not.toHaveProperty("approval");
  expect(persisted).not.toHaveProperty("reviewId");
  expect(persisted).not.toHaveProperty("approvedPlanHash");
});

it("does not overwrite an existing Handoff or accept a non-template Plan", async () => {
  const root = makeRoot();
  await writePlanningHandoffArtifact(input(), root);
  await expect(writePlanningHandoffArtifact(input(), root)).rejects.toThrow(
    /EEXIST|already exists/u,
  );

  const invalidRoot = mkdtempSync(join(tmpdir(), "pi-workflow-plan-invalid-"));
  roots.push(invalidRoot);
  mkdirSync(join(invalidRoot, "artifacts"));
  writeFileSync(
    join(invalidRoot, "artifacts/implementation-plan.md"),
    "# Implementation Plan\n## Goal\n",
  );
  await expect(
    writePlanningHandoffArtifact(input(), invalidRoot),
  ).rejects.toThrow(/missing headings/u);
});

it("registers the Handoff writer only as the child-only tool", () => {
  const registered: string[] = [];
  const pi = {
    registerTool(tool: { name: string }) {
      registered.push(tool.name);
    },
  };

  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  planningHandoffChildExtension(pi);
  expect(registered).toEqual([]);

  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  planningHandoffChildExtension(pi);
  vi.unstubAllEnvs();
  expect(registered).toEqual([PLAN_HANDOFF_TOOL_NAME]);
});
