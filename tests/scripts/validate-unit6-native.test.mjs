import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stageState } from "../../scripts/validate-unit6-native.mjs";

const missionId = "mission-1";
const planRef = "/tmp/plan.md";
const reviewId = "review-1";

function messagePair(id, name, argumentsValue) {
  return [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id, name, arguments: argumentsValue }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: id,
        isError: false,
        content: [],
      },
    },
  ];
}

async function evidenceLayout() {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-unit6-evidence-"));
  const layout = {
    home: join(root, "home"),
    missions: join(root, "missions"),
    sessions: join(root, "sessions"),
  };
  await Promise.all(Object.values(layout).map((directory) => mkdir(directory)));
  await mkdir(join(layout.missions, missionId));

  await writeFile(
    join(layout.missions, `${missionId}.json`),
    JSON.stringify({
      id: missionId,
      status: "active",
      workflowChildren: [
        { key: "discovery-artifact", status: "completed", agent: "scout" },
        { key: "discovery-metadata", status: "completed", agent: "scout" },
        {
          key: "research",
          status: "completed",
          agent: "pi-workflow.researcher",
        },
        { key: "planning", status: "completed", agent: "reviewer" },
      ],
    }),
  );
  await writeFile(
    join(layout.missions, missionId, "state.json"),
    JSON.stringify({
      phase: "plan-review",
      discoveryRef: "/tmp/discovery.md",
      discoveryMeta: {
        externalResearchRequired: true,
        humanClarificationRequired: false,
      },
      researchRef: "/tmp/research.md",
      researchMeta: { status: "completed" },
      planRef,
      planningDecision: { unresolvedDecisions: [] },
      planReview: {
        status: "approved",
        round: 1,
        planRef,
        reviewId,
      },
    }),
  );

  const calls = [
    ...messagePair("prepare", "subagent", {
      workflow: "pi-workflow.planning",
      args: { operation: "prepare-review", round: 1, planRef },
      missionId,
      async: false,
    }),
    ...messagePair("plan-review", "pi_workflow_plan_review", {
      missionId,
      round: 1,
      planRef,
    }),
    ...messagePair("record", "subagent", {
      workflow: "pi-workflow.planning",
      args: {
        operation: "record-review",
        round: 1,
        planRef,
        reviewId,
        status: "approved",
      },
      missionId,
      async: false,
    }),
    ...messagePair("status", "subagent", {
      workflow: "pi-workflow.planning",
      args: { operation: "review-status", round: 1, planRef },
      missionId,
      async: false,
    }),
  ];
  await writeFile(
    join(layout.sessions, "session.jsonl"),
    `${calls.map(JSON.stringify).join("\n")}\n`,
  );
  return { root, layout };
}

describe("Unit 6 native evidence completion", () => {
  it("recognizes terminal control calls and closes the approved gate", async () => {
    const { root, layout } = await evidenceLayout();
    try {
      const stages = Array.from({ length: 8 }, () => ({
        status: "started",
        startedAt: new Date().toISOString(),
      }));

      stageState(layout, stages);

      expect(stages.every(({ status }) => status === "completed")).toBe(true);
      expect(stages.map(({ runKey }) => runKey)).toEqual([
        "unit6-native",
        "discovery-artifact / discovery-metadata",
        "research",
        "planning",
        "prepare-review",
        "pi_workflow_plan_review",
        "record-review",
        "review-status",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
