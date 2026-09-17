import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const AGENT_PATH = new URL("../../agents/oracle.md", import.meta.url);

it("uses a fresh package-owned Oracle contract with read-only tools and file output", () => {
  const source = readFileSync(AGENT_PATH, "utf8");
  const tools = source.match(/^tools: (.+)$/mu)?.[1]?.split(", ") ?? [];

  expect(source).toContain("name: oracle");
  expect(source).toContain("defaultContext: fresh");
  expect(source).toContain("output: oracle-report.md");
  expect(source).toContain("outputMode: file-only");
  expect(source).toContain("acceptanceRole: read-only");
  expect(tools).toEqual(["read", "grep", "find", "ls"]);
  expect(tools).not.toContain("bash");
  expect(tools).not.toContain("write");
  expect(tools).not.toContain("edit");
});

it("keeps Oracle advisory and outside implementation authority", () => {
  const source = readFileSync(AGENT_PATH, "utf8");

  expect(source).toContain(
    "Do not edit source, write files, run shell commands",
  );
  expect(source).toContain("no approval or implementation authority");
});
