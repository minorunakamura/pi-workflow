#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PI_CLI = join(
  REPO_ROOT,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);
const EXPECTED_COMMANDS = ["wf-feature", "wf-bug", "wf-chore", "wf-hotfix"];

function fail(message) {
  throw new Error(message);
}

function main() {
  if (!existsSync(PI_CLI)) fail(`Pi CLI bundle is missing: ${PI_CLI}`);

  const root = mkdtempSync(join(tmpdir(), "pi-workflow-native-smoke-"));
  try {
    const output = execFileSync(
      process.execPath,
      [
        PI_CLI,
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--extension",
        join(REPO_ROOT, "src", "index.ts"),
        "--offline",
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          HOME: join(root, "home"),
          PI_CODING_AGENT_DIR: join(root, "agent"),
          PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
          TMPDIR: join(root, "tmp"),
          TMP: join(root, "tmp"),
          TEMP: join(root, "tmp"),
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
        },
        input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    const events = output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const extensionError = events.find(
      (event) => event.type === "extension_error",
    );
    if (extensionError)
      fail(extensionError.error ?? "Pi extension failed to load.");

    const response = events.find(
      (event) => event.type === "response" && event.id === "commands",
    );
    if (!response || response.success !== true)
      fail(response?.error ?? "Pi command inspection failed.");
    const commands = response.data?.commands?.map((item) => item.name) ?? [];
    if (!EXPECTED_COMMANDS.every((name) => commands.includes(name))) {
      fail(
        `Canonical commands were not registered: ${JSON.stringify(commands)}`,
      );
    }
    process.stdout.write("Native Pi smoke: PASS\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write("Native Pi smoke: BLOCKED\n");
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
