import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const AGENT_PATH = new URL("../../agents/scout.md", import.meta.url);
const PACKAGE_PATH = new URL("../../package.json", import.meta.url);

it("uses the package-owned Scout agent with a strict read-only tool allowlist", () => {
  const source = readFileSync(AGENT_PATH, "utf8");
  const tools = source.match(/^tools: (.+)$/mu)?.[1]?.split(", ") ?? [];

  const manifest: unknown = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));

  expect(source).toContain("name: scout");
  expect(source).not.toContain("package: pi-workflow");
  expect(manifest).toMatchObject({
    pi: { subagents: { agents: ["./agents"] } },
  });
  expect(source).toContain("skills: codegraph");
  expect(source).toContain("defaultContext: fresh");
  expect(source).toContain("output: scout-context.md");
  expect(source).toContain("outputMode: file-only");
  expect(source).toContain("acceptanceRole: read-only");
  expect(tools).toEqual(["read", "grep", "find", "ls"]);
  expect(tools).not.toContain("bash");
  expect(tools).not.toContain("write");
  expect(tools).not.toContain("edit");
  expect(tools).not.toContain("contact_supervisor");
});

it("keeps CodeGraph and repository mutation outside the Scout authority", () => {
  const source = readFileSync(AGENT_PATH, "utf8");

  expect(source).toContain("Never initialize or modify CodeGraph");
  expect(source).toContain(
    "Do not edit source, write files, or run shell commands",
  );
  expect(source).not.toContain("pi_workflow_human_decision");
});
