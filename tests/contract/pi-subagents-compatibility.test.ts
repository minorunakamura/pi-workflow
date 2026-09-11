import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerWorkflowResource } from "pi-subagents/workflow-resources";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const piSubagentsRoot = `${repoRoot}/node_modules/pi-subagents`;
const piSubagentsPackage = JSON.parse(
  readFileSync(`${piSubagentsRoot}/package.json`, "utf8"),
) as {
  name: string;
  version: string;
  exports: Record<string, string>;
};

function packageSource(path: string): string {
  return readFileSync(`${piSubagentsRoot}/${path}`, "utf8");
}

describe("pi-subagents v0.67.0 compatibility", () => {
  it("keeps the public resource and launch-contract exports", () => {
    expect(piSubagentsPackage).toMatchObject({
      name: "pi-subagents",
      version: "0.67.0",
    });
    expect(registerWorkflowResource).toBeTypeOf("function");
    for (const subpath of [
      "./workflow-resources",
      "./preflight",
      "./capability-ceiling",
      "./child-tool-plan",
      "./agents",
    ]) {
      expect(piSubagentsPackage.exports[subpath], subpath).toBeTypeOf("string");
      expect(
        existsSync(`${piSubagentsRoot}/${piSubagentsPackage.exports[subpath]}`),
        subpath,
      ).toBe(true);
    }
  });

  it("keeps side-effect-free preflight and launch contract v3", () => {
    const source = packageSource("src/api/preflight.ts");
    const launchContract = packageSource("src/shared/launch-contract.ts");

    expect(source).toContain(
      "export const SUBAGENT_LAUNCH_CONTRACT_VERSION = 3 as const",
    );
    expect(source).toContain(
      "export async function resolveSubagentLaunchContract",
    );
    for (const field of [
      "effectiveAllowlist",
      "runtimeExtensions",
      "agent:",
      "context:",
      "modelCandidates",
      "thinking:",
      "launchContractDigest",
    ]) {
      expect(source, field).toContain(field);
    }
    expect(source).toContain("const contractBase");
    expect(launchContract).toContain(
      "export const LAUNCH_BINDING_PROJECTION_VERSION = 2 as const",
    );
  });

  it("keeps Mission state and workflow run primitives", () => {
    const missionState = packageSource("src/missions/workflow-state.ts");
    const workflow = packageSource("src/workflows/scripted-workflow.ts");

    expect(missionState).toContain("MISSION_STATE_MAX_BYTES = 256 * 1024");
    expect(missionState).toContain("get(key: string)");
    expect(missionState).toContain("set(key: string, value: unknown)");
    expect(workflow).toContain("runs.all");
    expect(workflow).toContain("runs.lanes");
    expect(workflow).toContain("async");
  });

  it("keeps strict tool, child-only extension, capability ceiling, and fail-before-turn paths", () => {
    const toolPlan = packageSource("src/runs/shared/child-tool-plan.ts");
    const capabilityCeiling = packageSource("src/api/capability-ceiling.ts");

    expect(toolPlan).toContain("subagentOnlyExtensions");
    expect(toolPlan).toContain("hostAvailableBuiltins");
    expect(toolPlan).toContain("requiredChildTools");
    expect(toolPlan).toContain("tool contract could not be satisfied");
    expect(capabilityCeiling).toContain("registerSubagentCapabilityCeiling");
    expect(capabilityCeiling).toContain("intersectSubagentCapabilityCeilings");
  });
});
