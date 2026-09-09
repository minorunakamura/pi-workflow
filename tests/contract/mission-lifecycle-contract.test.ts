import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const skill = readFileSync(`${repoRoot}/skills/pi-workflow/SKILL.md`, "utf8");

describe("native Mission lifecycle contract", () => {
  it("uses only v0.66.0 Mission status values", () => {
    expect(skill).toContain(
      "The official `pi-subagents` v0.66.0 Mission statuses",
    );
    for (const status of [
      "planned",
      "active",
      "waiting",
      "needs_decision",
      "completed",
      "failed",
      "cancelled",
    ]) {
      expect(skill).toContain(`\`${status}\``);
    }
    expect(skill).toContain("`paused` is not a Mission status");
    expect(skill).toContain('Do not use or invent `status: "paused"`');
  });

  it("stops without retrying after an explicit native user stop", () => {
    expect(skill).toContain("### Explicit user stop");
    expect(skill).toContain(
      "It is not a semantic-validation failure and is not retryable.",
    );
    expect(skill).toContain("Do not run automatic Planning correction");
    expect(skill).toContain("prepare a new phase");
    expect(skill).toContain("return the exact native stop result");
  });

  it("normalizes phase completion before the next phase", () => {
    expect(skill).toContain('action: "mission.update"');
    expect(skill).toContain('missionUpdate: { status: "active" }');
    expect(skill).toContain("after Discovery, optional Research, and");
    expect(skill).toContain("After a valid Planning workflow returns");
  });

  it("uses waiting only for the Human Plan approval gate", () => {
    expect(skill).toContain('missionUpdate: { status: "waiting" }');
    expect(skill).toContain("Before waiting for Plan Review");
    expect(skill).toContain("restore the current Mission to native `active`");
  });

  it("does not finalize the Mission during Step 2", () => {
    expect(skill).toContain("Step 2 must not call `mission.close`");
    expect(skill).toContain("only the final successful flow");
  });

  it("guards recovery from transient phase completion", () => {
    expect(skill).toContain(
      "`completed` on a phase workflow is not proof that pi-workflow is complete.",
    );
    expect(skill).toContain("continue or recover with the same Mission ID");
    expect(skill).toContain("create a replacement Mission merely because");
  });
});
