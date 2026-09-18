import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function input(managedRoot: string): PlanHandoffToolInput {
  const managedPlan = join(managedRoot, "implementation-plan.md");
  return {
    workflowId: WORKFLOW_ID,
    planArtifactRef: {
      kind: "managed",
      path: "implementation-plan.md",
      mediaType: "text/markdown",
    },
    planningHandoffRef: {
      kind: "managed",
      path: "planning-handoff.json",
      mediaType: "application/json",
    },
    managedPlanOutput: {
      outputReference: managedPlan,
      outputPathMapping: {
        requestedPath: "implementation-plan.md",
        savedPath: managedPlan,
      },
      artifactPaths: { outputPath: managedPlan },
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

function makeRoots(): { projectRoot: string; managedRoot: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), "pi-workflow-project-"));
  const managedRoot = mkdtempSync(join(tmpdir(), "pi-workflow-managed-"));
  roots.push(projectRoot, managedRoot);
  writeFileSync(join(managedRoot, "implementation-plan.md"), PLAN);
  return { projectRoot, managedRoot };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("creates one immutable-schema Handoff beside the managed Plan", async () => {
  const { projectRoot, managedRoot } = makeRoots();
  const details = await writePlanningHandoffArtifact(input(managedRoot));
  const persisted: unknown = JSON.parse(
    readFileSync(join(managedRoot, "planning-handoff.json"), "utf8"),
  );

  expect(projectRoot).not.toBe(managedRoot);
  expect(
    readFileSync(join(managedRoot, "implementation-plan.md"), "utf8"),
  ).toBe(PLAN);

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
  const { managedRoot } = makeRoots();
  await writePlanningHandoffArtifact(input(managedRoot));
  await expect(
    writePlanningHandoffArtifact(input(managedRoot)),
  ).rejects.toThrow(/EEXIST|already exists/u);

  const invalidRoot = mkdtempSync(join(tmpdir(), "pi-workflow-plan-invalid-"));
  roots.push(invalidRoot);
  writeFileSync(
    join(invalidRoot, "implementation-plan.md"),
    "# Implementation Plan\n## Goal\n",
  );
  await expect(
    writePlanningHandoffArtifact(input(invalidRoot)),
  ).rejects.toThrow(/missing headings/u);

  await expect(
    writePlanningHandoffArtifact({
      ...input(invalidRoot),
      managedPlanOutput: { outputReference: "implementation-plan.md" },
    }),
  ).rejects.toThrow(/public reference|outputReference/u);
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
