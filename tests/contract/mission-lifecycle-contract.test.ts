import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const skill = readFileSync(`${repoRoot}/skills/pi-workflow/SKILL.md`, "utf8");

const nativeStatuses = [
  "planned",
  "active",
  "waiting",
  "needs_decision",
  "completed",
  "failed",
  "cancelled",
];

describe("native Mission lifecycle contract", () => {
  it("keeps Mission status native and phase state Planning-only", () => {
    expect(skill).toContain("Native Mission status is authoritative");
    expect(skill).toContain(
      "version, requestType, request, phase, humanDecisions",
    );
    expect(skill).toContain(
      "discoveryRef, discoveryMeta, researchRef, researchMeta",
    );
    expect(skill).toContain("planRef, planningDecision, planReview");
    expect(skill).toContain('missionStatus: "active"');
    for (const phase of ["discovery", "research", "planning", "plan-review"]) {
      expect(skill).toContain(`\`${phase}\``);
    }
    for (const status of nativeStatuses)
      expect(skill).toContain(`\`${status}\``);
  });

  it("does not normalize active between machine phases", () => {
    expect(skill).toContain(
      'Do not issue an explicit `mission.update({ status: "active" })`',
    );
    expect(skill).not.toContain('missionUpdate: { status: "active" }');
    expect(skill).toContain("same Mission ID");
  });

  it("retains only Human, decision, and final close transitions", () => {
    expect(skill).toContain("set native Mission status to");
    expect(skill).toContain("`waiting`");
    expect(skill).toContain("native `needs_decision`");
    expect(skill).toContain(
      'mission.close", missionId, missionStatus: "completed"',
    );
    expect(skill).toContain(
      "record-review(approved) → mission.close(completed) → STOP",
    );
    expect(skill).not.toContain("close the Mission as success in this flow");
  });
});
