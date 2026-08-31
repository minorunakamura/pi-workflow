import { describe, expect, it } from "vitest";
import { PLAYBOOK_DEFINITIONS } from "../../src/playbooks/definitions.js";

describe("playbook base graphs", () => {
  it("keeps every dependency unique and earlier in its base graph", () => {
    for (const playbook of PLAYBOOK_DEFINITIONS) {
      const stepIds = playbook.baseGraph.map(({ id }) => id);

      expect(new Set(stepIds).size).toBe(stepIds.length);
      for (const [index, step] of playbook.baseGraph.entries()) {
        for (const dependency of step.dependsOn) {
          expect(stepIds.slice(0, index)).toContain(dependency);
        }
      }
    }
  });

  it("keeps conditional investigation work read-only", () => {
    const investigation = PLAYBOOK_DEFINITIONS.find(({ id }) => id === "investigation");
    const investigate = investigation?.baseGraph.find(({ id }) => id === "investigate");

    expect(investigate).toMatchObject({ allowedAgents: ["researcher", "oracle"], required: true });
  });
});
