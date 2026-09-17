import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

import extension, { isSubagentChildRuntime } from "../src/index.ts";

type RootExtensionAPI = Pick<ExtensionAPI, "on" | "appendEntry">;

function fakePi(events: string[]): RootExtensionAPI {
  return {
    on(event, _handler) {
      events.push(event);
    },
    appendEntry() {},
  };
}

it("exports a Pi Extension entry point", () => {
  expect(extension).toEqual(expect.any(Function));
});

it("registers Root session lifecycle only in the normal runtime", () => {
  const events: string[] = [];
  vi.stubEnv("PI_SUBAGENT_CHILD", "0");
  extension(fakePi(events));
  vi.unstubAllEnvs();

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
  vi.stubEnv("PI_SUBAGENT_CHILD", "1");
  extension(fakePi(events));
  vi.unstubAllEnvs();

  expect(events).toEqual([]);
});
