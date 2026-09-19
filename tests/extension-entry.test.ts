import { readFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

import extension, { isSubagentChildRuntime } from "../src/index.ts";

type RootExtensionAPI = Pick<
  ExtensionAPI,
  "on" | "appendEntry" | "registerCommand" | "events"
>;

function fakePi(events: string[], commands: string[] = []): RootExtensionAPI {
  return {
    on(event, _handler) {
      events.push(event);
    },
    appendEntry() {},
    registerCommand(name, _options) {
      commands.push(name);
    },
    events: {
      on() {
        return () => {};
      },
      emit() {},
    },
  };
}

it("exports a Pi Extension entry point", () => {
  expect(extension).toEqual(expect.any(Function));
});

it("keeps the Final Diff Inspection tool out of the Root entrypoint", () => {
  const source = readFileSync(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );

  expect(source).not.toContain("pi_workflow_inspect_diff");
  expect(source).not.toContain("final-diff-inspection.ts");
});

it("wires production Code Review as a transient Root bridge", () => {
  const source = readFileSync(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  const lifecycle = readFileSync(
    new URL("../src/events/index.ts", import.meta.url),
    "utf8",
  );

  expect(source).not.toContain("createManagedCodeReviewArtifactWriter");
  expect(lifecycle).toContain("registerCodeReviewRootBridge");
  expect(lifecycle).toContain("intercom: humanDecisionBridge");
  expect(lifecycle).not.toContain("artifactWriter");
});

it("wires production Implementation launch to repository Gate resolution", () => {
  const source = readFileSync(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );

  expect(source).toContain("resolveRepositoryGatesFromPackageScripts");
  expect(source).toContain(
    "repositoryGateResolver: resolveRepositoryGatesFromPackageScripts",
  );
});

it("registers Root commands and session lifecycle only in the normal runtime", () => {
  const events: string[] = [];
  const commands: string[] = [];
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  extension(fakePi(events, commands));
  vi.unstubAllEnvs();

  expect(commands).toEqual(["wf-feature", "wf-bug", "wf-chore", "wf-hotfix"]);
  expect(events).toEqual([
    "session_start",
    "session_before_tree",
    "session_tree",
    "session_shutdown",
  ]);
});

it("does not register Root lifecycle in a pi-subagents child runtime", () => {
  expect(isSubagentChildRuntime("1")).toBe(true);
  expect(isSubagentChildRuntime("0")).toBe(false);

  const events: string[] = [];
  const commands: string[] = [];
  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  extension(fakePi(events, commands));
  vi.unstubAllEnvs();

  expect(events).toEqual([]);
  expect(commands).toEqual([]);
});
