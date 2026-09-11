#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PI_VERSION = "0.85.1";
const PI_SUBAGENTS_VERSION = "0.67.0";
const PONYTAIL_VERSION = "4.9.0";
const PI_SUBAGENTS_BIN = "install.mjs";
const RESOURCE_NAMES = [
  "pi-workflow.discovery",
  "pi-workflow.research",
  "pi-workflow.planning",
];
const CLEAR_INHERITED_KEYS = new Set([
  "AI_AGENT",
  "APPDATA",
  "HOME",
  "INIT_CWD",
  "LOCALAPPDATA",
  "OLDPWD",
  "PI_CODING_AGENT",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_PACKAGE_ROOT",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_MODEL",
  "PI_PACKAGE_DIR",
  "PI_PROVIDER",
  "PI_REASONING_LEVEL",
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  "PI_SUBAGENT_CHILD",
  "PI_SUBAGENT_PARENT_SESSION",
  "PI_SUBAGENT_PI_BINARY",
  "PI_SUBAGENTS_TEMP_ROOT",
  "PI_SUBAGENTS_WORKTREE_DIR",
  "TMP",
  "TEMP",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function packageMetadata(packageRoot, expectedName, expectedVersion) {
  const packageJsonPath = join(packageRoot, "package.json");
  const packageJson = readJson(packageJsonPath);
  if (packageJson.name !== expectedName) {
    fail(`${packageJsonPath} is not ${expectedName}.`);
  }
  if (packageJson.version !== expectedVersion) {
    fail(
      `${expectedName} version is ${String(packageJson.version)}; expected ${expectedVersion}.`,
    );
  }
  return { packageRoot: resolve(packageRoot), packageJsonPath, packageJson };
}

function findExecutable(command) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  try {
    const output = execFileSync(locator, [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const first = output.split(/\r?\n/u)[0]?.trim();
    if (first) return first;
  } catch {
    // Report a useful blocker below instead of invoking a guessed executable.
  }
  return fail(
    `Could not resolve executable '${command}' without invoking a shell.`,
  );
}

function findPackageRoot(startPath, packageName) {
  let current = resolve(startPath);
  try {
    current = realpathSync(current);
  } catch {
    // Keep the resolved path when the executable is not a real file.
  }
  if (!existsSync(current) || !lstatSync(current).isFile())
    current = dirname(current);
  while (true) {
    const packageJsonPath = join(current, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = readJson(packageJsonPath);
        if (packageJson.name === packageName) {
          return { root: current, packageJsonPath, packageJson };
        }
      } catch {
        // Continue walking; an unrelated package.json may be malformed.
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function packageRootFromBinary(binary) {
  const resolvedBinary = resolve(
    binary.includes(sep) ? binary : findExecutable(binary),
  );
  if (!existsSync(resolvedBinary))
    fail(`Pi executable does not exist: ${resolvedBinary}.`);
  const packageInfo = findPackageRoot(
    resolvedBinary,
    "@earendil-works/pi-coding-agent",
  );
  if (!packageInfo) {
    fail(
      `Could not find @earendil-works/pi-coding-agent/package.json next to '${resolvedBinary}'.`,
    );
  }
  if (packageInfo.packageJson.version !== PI_VERSION) {
    fail(
      `Pi binary package version is ${String(packageInfo.packageJson.version)}; expected ${PI_VERSION}.`,
    );
  }
  return { binary: resolvedBinary, ...packageInfo };
}

function canonicalPath(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return resolve(filePath);
  }
}

function isWithin(root, candidate) {
  if (typeof root !== "string" || typeof candidate !== "string") return false;
  const rootPath = canonicalPath(root);
  const candidatePath = canonicalPath(candidate);
  const difference = relative(rootPath, candidatePath);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) && difference !== "..")
  );
}

function hashFile(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function shouldHash(root, filePath) {
  const rootName = root.endsWith(sep) ? root : `${root}${sep}`;
  return filePath === root || filePath.startsWith(rootName);
}

function snapshotTree(root, options = {}) {
  const entries = {};
  const excluded = new Set((options.exclude ?? []).map(canonicalPath));
  const hash = options.hash === true;

  function visit(current) {
    const resolvedCurrent = resolve(current);
    if (excluded.has(canonicalPath(resolvedCurrent))) return;

    let stat;
    try {
      stat = lstatSync(resolvedCurrent);
    } catch (error) {
      if (error?.code === "ENOENT") {
        entries[resolvedCurrent] = { type: "missing" };
        return;
      }
      throw error;
    }

    const record = {
      type: stat.isDirectory()
        ? "directory"
        : stat.isSymbolicLink()
          ? "symlink"
          : stat.isFile()
            ? "file"
            : "other",
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino,
    };
    if (stat.isSymbolicLink()) record.target = readlinkSync(resolvedCurrent);
    if (hash && stat.isFile() && shouldHash(root, resolvedCurrent)) {
      record.sha256 = hashFile(resolvedCurrent);
    }
    entries[resolvedCurrent] = record;

    if (!stat.isDirectory()) return;
    for (const name of readdirSync(resolvedCurrent).toSorted((left, right) =>
      left.localeCompare(right),
    )) {
      visit(join(resolvedCurrent, name));
    }
  }

  visit(root);
  return entries;
}

function protectedPiSnapshot(realHome) {
  const agent = join(realHome, ".pi", "agent");
  const sessions = join(agent, "sessions");
  const currentSession = process.env.PI_SESSION_FILE
    ? canonicalPath(process.env.PI_SESSION_FILE)
    : undefined;
  const sessionExclude =
    currentSession && isWithin(sessions, currentSession)
      ? [currentSession]
      : [];
  return {
    piRoot: snapshotTree(join(realHome, ".pi")),
    agentRoot: snapshotTree(agent),
    settings: snapshotTree(join(agent, "settings.json"), { hash: true }),
    extensions: snapshotTree(join(agent, "extensions"), { hash: true }),
    missions: snapshotTree(join(agent, "missions"), { hash: true }),
    npm: snapshotTree(join(agent, "npm")),
    git: snapshotTree(join(agent, "git")),
    sessions: snapshotTree(sessions, { exclude: sessionExclude }),
    excludedCurrentSession: currentSession ?? null,
  };
}

function snapshotDiff(before, after) {
  const differences = [];
  for (const key of Object.keys(before)) {
    if (key === "excludedCurrentSession") continue;
    const left = before[key] ?? {};
    const right = after[key] ?? {};
    const paths = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const path of Array.from(paths).toSorted((a, b) =>
      a.localeCompare(b),
    )) {
      if (JSON.stringify(left[path]) !== JSON.stringify(right[path])) {
        differences.push({
          scope: key,
          path,
          before: left[path] ?? null,
          after: right[path] ?? null,
        });
      }
    }
  }
  return differences;
}

function copyWithoutRuntimeState(source, destination) {
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: (sourcePath) => {
      const relativePath = relative(source, sourcePath);
      if (!relativePath) return true;
      const first = relativePath.split(sep)[0];
      return first !== ".git" && first !== "node_modules" && first !== ".pi";
    },
  });
}

function createLayout() {
  const root = resolve(
    mkdtempSync(join(tmpdir(), "pi-workflow-unit5-isolated-")),
  );
  const layout = {
    root,
    home: join(root, "home"),
    agent: join(root, "pi-agent"),
    sessions: join(root, "sessions"),
    childSessions: join(root, "child-sessions"),
    runtime: join(root, "runtime"),
    outputs: join(root, "outputs"),
    tmp: join(root, "tmp"),
    fixture: join(root, "fixture"),
    packages: join(root, "packages"),
    missions: join(root, "missions"),
  };
  for (const directory of Object.values(layout)) {
    if (directory !== root)
      mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return layout;
}

function copyCredentialFixture(layout, realHome) {
  for (const name of ["auth.json", "models.json"]) {
    const source = join(realHome, ".pi", "agent", name);
    if (!existsSync(source)) continue;
    const destination = join(layout.agent, name);
    cpSync(source, destination);
    chmodSync(destination, 0o600);
  }
}

function copyExternalPackage(layout, realHome, pathParts, name, version) {
  const source = join(realHome, ".pi", "agent", "git", ...pathParts);
  if (!existsSync(join(source, "package.json"))) {
    fail(`Required ${name} package fixture is absent at ${source}.`);
  }
  const destination = join(layout.packages, name.replaceAll("/", "-"));
  copyWithoutRuntimeState(source, destination);
  packageMetadata(destination, name, version);
  return destination;
}

function prepareFixture(layout, researchMode, realHome) {
  copyWithoutRuntimeState(REPO_ROOT, layout.fixture);
  copyCredentialFixture(layout, realHome);

  const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(layout.root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (args) =>
    execFileSync("git", args, {
      cwd: layout.fixture,
      env: gitEnvironment,
      stdio: "pipe",
    });
  git(["init", "-q"]);
  git(["add", "-A"]);
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgSign=false",
      "-c",
      "user.name=pi-workflow-unit5",
      "-c",
      "user.email=unit5@invalid.example",
      "commit",
      "--no-gpg-sign",
      "-q",
      "-m",
      "isolated fixture",
    ],
    { cwd: layout.fixture, env: gitEnvironment, stdio: "pipe" },
  );
  const status = git([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]).toString();
  if (status.trim())
    fail("Temporary validation fixture is not clean after setup.");

  const packages = [
    copyExternalPackage(
      layout,
      realHome,
      ["github.com", "DietrichGebert", "ponytail"],
      "@dietrichgebert/ponytail",
      PONYTAIL_VERSION,
    ),
  ];
  if (researchMode === "completed") {
    packages.push(
      copyExternalPackage(
        layout,
        realHome,
        ["github.com", "minorunakamura", "pi-ketch"],
        "pi-ketch",
        readJson(
          join(
            realHome,
            ".pi",
            "agent",
            "git",
            "github.com",
            "minorunakamura",
            "pi-ketch",
            "package.json",
          ),
        ).version,
      ),
    );
  }
  return packages;
}

function buildEnvironment(layout) {
  const environment = { ...process.env };
  for (const key of [...Object.keys(environment), ...CLEAR_INHERITED_KEYS]) {
    if (CLEAR_INHERITED_KEYS.has(key) || key.startsWith("PI_SUBAGENT"))
      delete environment[key];
  }
  environment.HOME = layout.home;
  environment.USERPROFILE = layout.home;
  environment.TMPDIR = layout.tmp;
  environment.TMP = layout.tmp;
  environment.TEMP = layout.tmp;
  environment.XDG_CONFIG_HOME = join(layout.home, ".config");
  environment.XDG_DATA_HOME = join(layout.home, ".local", "share");
  environment.XDG_CACHE_HOME = join(layout.home, ".cache");
  environment.APPDATA = join(layout.home, "AppData", "Roaming");
  environment.LOCALAPPDATA = join(layout.home, "AppData", "Local");
  environment.PI_CODING_AGENT_DIR = layout.agent;
  environment.PI_CODING_AGENT_SESSION_DIR = layout.sessions;
  environment.PI_SUBAGENTS_TEMP_ROOT = layout.runtime;
  environment.PI_OFFLINE = "1";
  environment.PI_SKIP_VERSION_CHECK = "1";
  environment.PWD = layout.fixture;
  return environment;
}

function writeTemporarySettings(layout, piSubagentsRoot, packageRoots) {
  const packages = [REPO_ROOT, piSubagentsRoot, ...packageRoots];
  writeFileSync(
    join(layout.agent, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.6-luna",
        defaultThinkingLevel: "max",
        quietStartup: true,
        enableInstallTelemetry: false,
        defaultProjectTrust: "always",
        packages,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const subagentConfigDirectory = join(layout.agent, "extensions", "subagent");
  mkdirSync(subagentConfigDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(subagentConfigDirectory, "config.json"),
    `${JSON.stringify(
      {
        artifactDir: "temp",
        defaultSessionDir: layout.childSessions,
        singleRunOutputBaseDir: layout.outputs,
        missions: { directory: layout.missions, globalIndex: false },
        asyncByDefault: false,
        timeoutMs: 1_200_000,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function promptFor(researchMode) {
  const researchInstruction =
    researchMode === "completed"
      ? "The request intentionally needs current Pi 0.85.1 and pi-subagents 0.67.0 facts, so require and complete the named Research resource."
      : "The request needs no external facts; set externalResearchRequired false, leave researchQuestions empty, use the named Research resource's canonical skipped path, and do not invoke a researcher.";
  const requestFocus =
    researchMode === "completed"
      ? "validating Pi 0.85.1 / pi-subagents 0.67.0 root isolation"
      : "validating repository-local root isolation without external facts";
  const discoveryInstruction =
    researchMode === "completed"
      ? "For this no-human validation, Discovery metadata must be status ready with humanClarificationRequired false; put external facts in Research questions instead of blocking on clarification. Do not mark Discovery blocked."
      : "For this no-human validation, Discovery metadata must be status ready with humanClarificationRequired false and externalResearchRequired false; leave researchQuestions empty and do not mark Discovery blocked.";
  return [
    "Execute exactly the current pi-workflow Unit 5 native planning-flow proof in this disposable fixture.",
    "Do not edit any fixture or source files.",
    "Do not run pnpm, npm, npx, pnpm dlx, pi install, any installer, or any package executable for version checking.",
    "Use only the authoritative named workflow resources and native pi-subagents Mission flow.",
    "",
    `Use this Main Session sequence: mission.list, capability check, clean git check, one fresh active native Mission; invoke pi-workflow.discovery with requestType chore and a unique bounded request about ${requestFocus}; normalize the Mission;`,
    researchInstruction,
    discoveryInstruction,
    "normalize again; invoke named pi-workflow.planning round 1; after Planning succeeds, make one separate mandatory mission.update with status active and do not close the Mission; only then stop with the fresh planRef and Plan Artifact.",
    "Keep every named phase invocation foreground with async:false.",
    "Do not invoke Plan Review, Implementation, Verification, Review, or Unit 6.",
    "If human clarification is unexpectedly required, stop rather than invent an answer.",
    "Report only compact evidence and identifiers, not full Artifact bodies.",
  ].join("\n");
}

function endStream(stream) {
  return new Promise((resolveStream) => stream.end(resolveStream));
}

function resolvePiInvocation() {
  const packageInfo = packageMetadata(
    resolve(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent"),
    "@earendil-works/pi-coding-agent",
    PI_VERSION,
  );
  if (process.env.PI_WORKFLOW_PI_BINARY) {
    const binary = packageRootFromBinary(process.env.PI_WORKFLOW_PI_BINARY);
    return {
      binary: binary.binary,
      args: [],
      package: binary,
    };
  }
  const cli = join(packageInfo.packageRoot, "dist", "bundle", "cli.js");
  if (!existsSync(cli)) fail(`Pi CLI bundle is missing: ${cli}.`);
  return { binary: process.execPath, args: [cli], package: packageInfo };
}

function runPiRpc({
  layout,
  environment,
  piInvocation,
  researchMode,
  timeoutMs,
}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      piInvocation.binary,
      [...piInvocation.args, "--mode", "rpc", "--session-dir", layout.sessions],
      {
        cwd: layout.fixture,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const output = createWriteStream(join(layout.root, "rpc.jsonl"), {
      encoding: "utf8",
      mode: 0o600,
    });
    const errorOutput = createWriteStream(join(layout.root, "stderr.log"), {
      encoding: "utf8",
      mode: 0o600,
    });
    child.stderr.pipe(errorOutput);

    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let settled = false;
    let endedInput = false;
    let timedOut = false;
    let sawSpawnError = false;
    const responses = new Set();
    let dialogRequests = 0;

    function send(command) {
      if (!child.stdin.destroyed && !endedInput)
        child.stdin.write(`${JSON.stringify(command)}\n`);
    }

    function maybeCloseInput() {
      if (
        settled &&
        responses.has("entries") &&
        responses.has("state") &&
        !endedInput
      ) {
        endedInput = true;
        setTimeout(() => child.stdin.end(), 25);
      }
    }

    function handleLine(line) {
      if (!line) return;
      output.write(`${line}\n`);
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (
        event.type === "extension_ui_request" &&
        DIALOG_METHODS.has(event.method)
      ) {
        dialogRequests += 1;
        send({ type: "extension_ui_response", id: event.id, cancelled: true });
      }
      if (event.type === "agent_settled" && !settled) {
        settled = true;
        send({ id: "entries", type: "get_entries" });
        send({ id: "state", type: "get_state" });
      }
      if (
        event.type === "response" &&
        (event.id === "entries" || event.id === "state")
      ) {
        responses.add(event.id);
        maybeCloseInput();
      }
    }

    child.stdout.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        handleLine(line);
      }
    });
    child.stdout.on("end", () => {
      buffer += decoder.end();
      if (buffer)
        handleLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    });
    child.on("error", (error) => {
      sawSpawnError = true;
      rejectRun(error);
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timeout);
      await Promise.all([endStream(output), endStream(errorOutput)]);
      resolveRun({
        code,
        signal,
        settled,
        timedOut,
        sawSpawnError,
        dialogRequests,
      });
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5_000).unref();
    }, timeoutMs);
    timeout.unref();
    send({ id: "prompt", type: "prompt", message: promptFor(researchMode) });
  });
}

function walkFiles(root) {
  const files = [];
  if (!existsSync(root)) return files;
  function visit(current) {
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(current).toSorted((left, right) =>
        left.localeCompare(right),
      )) {
        visit(join(current, name));
      }
    } else if (stat.isFile()) {
      files.push(current);
    }
  }
  visit(root);
  return files;
}

function collectRuntimeEvents(layout) {
  const calls = new Map();
  const results = new Map();
  const allToolCalls = [];
  const eventTypes = {};
  const sourceFiles = [
    join(layout.root, "rpc.jsonl"),
    ...walkFiles(layout.root).filter((file) => file.endsWith(".jsonl")),
  ];
  const seenFiles = new Set(sourceFiles);

  function addToolCall(toolCall, source) {
    if (
      !toolCall ||
      typeof toolCall !== "object" ||
      toolCall.type !== "toolCall"
    )
      return;
    const record = {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      source,
    };
    allToolCalls.push(record);
    if (typeof toolCall.id === "string" && !calls.has(toolCall.id))
      calls.set(toolCall.id, record);
  }

  function visit(value, source) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, source);
      return;
    }
    if (typeof value.type === "string")
      eventTypes[value.type] = (eventTypes[value.type] ?? 0) + 1;
    if (
      value.role === "toolResult" &&
      typeof value.toolCallId === "string" &&
      !results.has(value.toolCallId)
    ) {
      results.set(value.toolCallId, value);
    }
    if (value.role === "assistant" && Array.isArray(value.content)) {
      for (const part of value.content) addToolCall(part, source);
    }
    if (value.type === "tool_execution_start") {
      allToolCalls.push({
        id: value.toolCallId,
        name: value.toolName,
        arguments: value.args,
        source,
      });
    }
    for (const child of Object.values(value)) visit(child, source);
  }

  for (const file of seenFiles) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        visit(JSON.parse(line), file);
      } catch {
        // A partial final line is not runtime evidence.
      }
    }
  }
  return { calls, results, allToolCalls, eventTypes };
}

function commandViolations(events, realAgent) {
  const violations = [];
  for (const call of events.allToolCalls) {
    if (call.name !== "bash" && call.name !== "powershell") continue;
    const command = call.arguments?.command;
    if (typeof command !== "string") continue;
    const normalized = command.replaceAll("\\", "/");
    if (/\b(?:pnpm|npm|npx)\b/i.test(normalized)) {
      violations.push({
        source: call.source,
        command: normalized.slice(0, 512),
        reason: "package-manager command",
      });
    }
    if (/\bpi\s+(?:install|remove|uninstall|update)\b/i.test(normalized)) {
      violations.push({
        source: call.source,
        command: normalized.slice(0, 512),
        reason: "Pi package mutation command",
      });
    }
    if (/\bpi-subagents\b[^\n]*--version\b/i.test(normalized)) {
      violations.push({
        source: call.source,
        command: normalized.slice(0, 512),
        reason: "package bin used as version CLI",
      });
    }
    if (
      normalized.includes("~/.pi") ||
      normalized.includes(realAgent.replaceAll("\\", "/"))
    ) {
      if (
        /\b(?:mkdir|touch|install|clone|write|rm|mv|cp|remove|uninstall|add)\b/i.test(
          normalized,
        )
      ) {
        violations.push({
          source: call.source,
          command: normalized.slice(0, 512),
          reason: "real Pi home mutation command",
        });
      }
    }
  }
  return violations;
}

function workflowCalls(events) {
  return [...events.calls.values()].filter((call) =>
    RESOURCE_NAMES.includes(call.arguments?.workflow),
  );
}

function successfulWorkflowCalls(events) {
  return workflowCalls(events).filter((call) => {
    const result = events.results.get(call.id);
    return result && !result.isError;
  });
}

function childFor(mission, key) {
  return mission.workflowChildren?.find((child) => child.key === key);
}

function fileBytes(filePath) {
  if (!filePath || !existsSync(filePath)) return undefined;
  return lstatSync(filePath).size;
}

function serializedBytes(value) {
  return value === undefined
    ? undefined
    : Buffer.byteLength(JSON.stringify(value), "utf8");
}

function activeResourceScriptProof() {
  const paths = {
    discovery: join(REPO_ROOT, "workflow-scripts", "discovery.js"),
    research: join(REPO_ROOT, "workflow-scripts", "research.js"),
    planning: join(REPO_ROOT, "workflow-scripts", "planning.js"),
  };
  return Object.fromEntries(
    Object.entries(paths).map(([name, filePath]) => {
      const source = readFileSync(filePath, "utf8");
      return [
        name,
        {
          path: filePath,
          fresh: source.includes('context: "fresh"'),
          foreground: source.includes("async: false"),
        },
      ];
    }),
  );
}

function collectEvidence({
  layout,
  pi,
  piSubagents,
  researchMode,
  runtime,
  before,
  diff,
  realAgent,
}) {
  if (runtime.timedOut) fail("Native Pi process timed out.");
  if (!runtime.settled) fail("Native Pi process did not emit agent_settled.");
  if (runtime.code !== 0 || runtime.signal) {
    fail(
      `Native Pi process ended with code ${String(runtime.code)} and signal ${String(runtime.signal)}.`,
    );
  }
  if (runtime.dialogRequests > 0)
    fail("Native proof requested Human UI; no answer was invented.");
  if (diff.length > 0) fail("Real Pi home changed during native validation.");

  const events = collectRuntimeEvents(layout);
  const violations = commandViolations(events, realAgent);
  if (violations.length > 0)
    fail(`Validation command guard rejected ${violations.length} command(s).`);

  const missionFiles = existsSync(layout.missions)
    ? readdirSync(layout.missions).filter((name) => name.endsWith(".json"))
    : [];
  if (missionFiles.length !== 1)
    fail(
      `Expected exactly one temporary Mission, found ${missionFiles.length}.`,
    );
  const missionPath = join(layout.missions, missionFiles[0]);
  const mission = readJson(missionPath);
  const missionId = mission.id;
  const statePath = join(layout.missions, missionId, "state.json");
  if (!existsSync(statePath)) fail("Temporary Mission state.json is missing.");
  const state = readJson(statePath);
  if (mission.status !== "active")
    fail(
      `Native phase Mission was not normalized to active: ${mission.status}.`,
    );
  if (state.phase !== "plan-review")
    fail(`Expected plan-review phase, got ${String(state.phase)}.`);
  if (!state.discoveryRef || !state.discoveryMeta)
    fail("Discovery handoff is incomplete.");
  if (!state.planRef || !state.planningDecision)
    fail("Planning handoff is incomplete.");
  if (researchMode === "completed") {
    if (state.researchMeta?.status !== "completed" || !state.researchRef)
      fail("Completed Research handoff is incomplete.");
  } else if (
    state.researchMeta?.status !== "skipped" ||
    state.researchRef !== undefined
  ) {
    fail("Canonical skipped Research handoff is invalid.");
  }

  const expectedChildren = [
    "discovery-artifact",
    "discovery-metadata",
    "planning",
  ];
  if (researchMode === "completed") expectedChildren.splice(2, 0, "research");
  const children = Object.fromEntries(
    expectedChildren.map((key) => {
      const child = childFor(mission, key);
      if (!child || child.status !== "completed" || !child.runId)
        fail(`Native child '${key}' did not complete.`);
      return [key, child];
    }),
  );

  const namedCalls = successfulWorkflowCalls(events);
  let callIndex = 0;
  const namedEvidence = {};
  for (const name of RESOURCE_NAMES) {
    const call = namedCalls
      .slice(callIndex)
      .find((candidate) => candidate.arguments.workflow === name);
    if (!call) fail(`Named resource '${name}' was not invoked.`);
    callIndex = namedCalls.indexOf(call) + 1;
    const args = call.arguments;
    if (!args || typeof args !== "object")
      fail(`Named resource '${name}' received invalid arguments.`);
    const result = events.results.get(call.id);
    const forbidden = [
      "agent",
      "task",
      "workflowScript",
      "workflowScriptPath",
      "outputSchema",
      "output",
      "outputPath",
    ];
    if (args.async !== false)
      fail(`Named resource '${name}' was not invoked with async:false.`);
    if (args.missionId !== missionId)
      fail(`Named resource '${name}' used the wrong Mission.`);
    if (
      !isWithin(layout.fixture, args.cwd) ||
      !isWithin(args.cwd, layout.fixture)
    )
      fail(`Named resource '${name}' used a non-fixture working directory.`);
    if (forbidden.some((key) => Object.hasOwn(args, key)))
      fail(`Named resource '${name}' received caller-owned transport fields.`);
    if (!result || result.isError)
      fail(`Named resource '${name}' returned an error.`);
    const resource = result.details?.workflow?.resource;
    if (
      resource?.kind !== "workflow" ||
      resource.name !== name ||
      resource.invocation !== "named"
    ) {
      fail(
        `Named resource '${name}' did not return named-resource provenance.`,
      );
    }
    namedEvidence[name] = {
      toolCallId: call.id,
      workflowRunId: result.details?.runId,
      childRunIds:
        result.details?.workflow?.trace
          ?.filter((entry) => entry.state === "completed" && entry.runId)
          .map((entry) => entry.runId) ?? [],
      workflowValueBytes: serializedBytes(result.details?.workflow?.value),
      wholeToolResultBytes: serializedBytes(result),
    };
  }
  if (
    events.allToolCalls.some(
      (call) =>
        call.name === "pi_workflow_prepare_phase" ||
        call.name === "pi_workflow_plan_review",
    )
  ) {
    fail("Legacy phase transport or Plan Review was invoked.");
  }

  const runtimeMetadata = walkFiles(layout.runtime)
    .filter((filePath) => filePath.endsWith("_meta.json"))
    .map((filePath) => ({ path: filePath, metadata: readJson(filePath) }));
  const agents = runtimeMetadata.map(({ metadata }) => metadata.agent);
  if (agents.filter((agent) => agent === "scout").length < 2)
    fail("Discovery did not run two fresh scout children.");
  if (!agents.includes("reviewer")) fail("Planning did not run reviewer.");
  if (researchMode === "completed" && !agents.includes("pi-ketch.researcher"))
    fail("Research did not run pi-ketch.researcher.");
  const allRuntimePaths = [
    missionPath,
    statePath,
    mission.cwd,
    mission.ownerSessionId,
    state.discoveryRef,
    state.researchRef,
    state.planRef,
    ...mission.artifacts.map((artifact) => artifact.path),
    ...mission.workflowChildren.flatMap((child) => [
      child.sessionPath,
      ...(child.artifactPaths ?? []),
    ]),
    ...runtimeMetadata.map(({ metadata }) => metadata.transcriptPath),
  ].filter(Boolean);
  if (allRuntimePaths.some((filePath) => !isWithin(layout.root, filePath))) {
    fail(
      "A Mission, session, artifact, or transcript path escaped the temporary root.",
    );
  }
  if (namedCalls.length !== RESOURCE_NAMES.length)
    fail(
      "Unexpected extra successful named workflow resource invocation was recorded.",
    );

  const scriptProof = activeResourceScriptProof();
  if (
    Object.values(scriptProof).some(
      (proof) => !proof.fresh || !proof.foreground,
    )
  ) {
    fail(
      "Active resource scripts do not encode fresh/async:false child policy.",
    );
  }
  const fixtureStatus = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: layout.fixture,
      stdio: "pipe",
    },
  ).toString();
  if (fixtureStatus.trim())
    fail("Native validation changed the temporary fixture.");

  const discoveryBytes = fileBytes(state.discoveryRef);
  const researchBytes = fileBytes(state.researchRef);
  const planBytes = fileBytes(state.planRef);
  const planningChild = children.planning;
  const planningResult = events.results.get(
    namedEvidence["pi-workflow.planning"]?.toolCallId,
  );
  const planningDecisionPath = planningChild.artifactPaths?.find((filePath) =>
    filePath.endsWith(".json"),
  );
  const references = {
    discoveryRef: state.discoveryRef,
    researchRef: state.researchRef ?? null,
    planRef: state.planRef,
  };
  const referenceBytes = Object.fromEntries(
    Object.entries(references).map(([key, value]) => [
      key,
      value === null ? null : Buffer.byteLength(value, "utf8"),
    ]),
  );

  return {
    status: "PASS",
    pi: {
      version: pi.packageJson.version,
      packageRoot: pi.packageRoot ?? pi.root,
    },
    piSubagents: {
      version: piSubagents.packageJson.version,
      packageRoot: piSubagents.packageRoot,
      versionVerification: "package metadata read-only",
      packageBin: piSubagents.packageJson.bin,
      packageBinExecuted: false,
      installerExecuted: false,
    },
    temporaryEnvironment: {
      root: layout.root,
      home: layout.home,
      piAgentRoot: layout.agent,
      fixture: layout.fixture,
      sessionRoot: layout.sessions,
      childSessionRoot: layout.childSessions,
      runtimeRoot: layout.runtime,
      missions: layout.missions,
      outputs: layout.outputs,
      temporaryPathsOnly: true,
    },
    realEnvironment: {
      home: process.env.HOME ?? homedir(),
      agentRoot: join(process.env.HOME ?? homedir(), ".pi", "agent"),
      usedForWrites: false,
      snapshotDiff: [],
      extensionsSubagent: existsSync(
        join(
          process.env.HOME ?? homedir(),
          ".pi",
          "agent",
          "extensions",
          "subagent",
        ),
      )
        ? "PRESENT"
        : "ABSENT",
      excludedCurrentSession: before.excludedCurrentSession,
    },
    native: {
      missionId,
      missionStatus: mission.status,
      discoveryRunId: children["discovery-artifact"].runId,
      discoveryMetadataRunId: children["discovery-metadata"].runId,
      researchRunId: children.research?.runId ?? null,
      researchStatus: state.researchMeta.status,
      planningRunId: children.planning.runId,
      resourceCalls: namedEvidence,
      resourcesActive: RESOURCE_NAMES,
      freshAsyncFalsePolicy: scriptProof,
      discoveryRef: state.discoveryRef,
      researchRef: state.researchRef ?? null,
      planRef: state.planRef,
      planPhase: state.phase,
      noPlanReview: true,
    },
    sizes: {
      discoveryArtifactBytes: discoveryBytes,
      researchArtifactBytes: researchBytes ?? null,
      planningDecisionBytes: serializedBytes(state.planningDecision),
      planningDecisionArtifactBytes: fileBytes(planningDecisionPath),
      planArtifactBytes: planBytes,
      ...referenceBytes,
      planningWorkflowValueBytes:
        namedEvidence["pi-workflow.planning"]?.workflowValueBytes,
      wholePlanningToolResultBytes:
        namedEvidence["pi-workflow.planning"]?.wholeToolResultBytes,
      missionStateBytes: fileBytes(statePath),
      missionStateJsonBytes: serializedBytes(state),
      planningToolResultPresent: planningResult !== undefined,
    },
    fixture: { gitStatus: fixtureStatus.trim() || "clean" },
    guards: {
      dangerousPackageCommand: "not executed",
      installerCommand: "not executed",
      commandViolations: [],
      realPiHomeDiff: "NONE",
      allPersistentRuntimePathsWithinTemporaryRoot: true,
    },
  };
}

function parseOptions(argv) {
  const options = {
    researchMode: "completed",
    timeoutMs: 1_200_000,
    cleanup: false,
  };
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--cleanup") options.cleanup = true;
    else if (argument.startsWith("--research=")) {
      const mode = argument.slice("--research=".length);
      if (mode !== "completed" && mode !== "skip")
        fail("--research must be completed or skip.");
      options.researchMode = mode;
    } else if (argument.startsWith("--timeout-ms=")) {
      const value = Number(argument.slice("--timeout-ms=".length));
      if (!Number.isSafeInteger(value) || value < 1)
        fail("--timeout-ms must be a positive integer.");
      options.timeoutMs = value;
    } else {
      fail(`Unknown option '${argument}'.`);
    }
  }
  return options;
}

function printHelp() {
  console.log(
    [
      "Usage: node scripts/validate-unit5-isolated.mjs [options]",
      "",
      "Runs the Unit 5 Discovery -> Research -> Planning native proof in a temporary Pi environment.",
      "The temporary root is retained by default so evidence can be inspected.",
      "",
      "Options:",
      "  --research=completed|skip  Require completed Research (default) or canonical skip path",
      "  --timeout-ms=N             Native Pi deadline in milliseconds",
      "  --cleanup                  Remove the temporary root after the report is written",
    ].join("\n"),
  );
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const realHome = resolve(process.env.HOME ?? homedir());
  const realAgent = join(realHome, ".pi", "agent");
  const accidentalExtension = join(realAgent, "extensions", "subagent");
  if (existsSync(accidentalExtension)) {
    console.error(
      `Unit 5.1 isolated native validation: BLOCKED\nAccidental extension path exists; refusing to touch it: ${accidentalExtension}`,
    );
    process.exitCode = 1;
    return;
  }

  const before = protectedPiSnapshot(realHome);
  let layout;
  let after;
  let diff = [];
  try {
    const piSubagentsRoot = resolve(REPO_ROOT, "node_modules", "pi-subagents");
    const piSubagents = packageMetadata(
      piSubagentsRoot,
      "pi-subagents",
      PI_SUBAGENTS_VERSION,
    );
    if (piSubagents.packageJson.bin?.["pi-subagents"] !== PI_SUBAGENTS_BIN) {
      fail(
        "pi-subagents package bin metadata changed; refusing to execute it as a version CLI.",
      );
    }
    const piInvocation = resolvePiInvocation();
    const pi = piInvocation.package;

    layout = createLayout();
    const packageRoots = prepareFixture(layout, options.researchMode, realHome);
    writeTemporarySettings(layout, piSubagents.packageRoot, packageRoots);
    const environment = buildEnvironment(layout);
    const runtime = await runPiRpc({
      layout,
      environment,
      piInvocation,
      researchMode: options.researchMode,
      timeoutMs: options.timeoutMs,
    });
    after = protectedPiSnapshot(realHome);
    diff = snapshotDiff(before, after);
    if (existsSync(accidentalExtension))
      fail("FAIL: extensions/subagent was recreated during validation.");

    const evidence = collectEvidence({
      layout,
      pi,
      piSubagents,
      researchMode: options.researchMode,
      runtime,
      before,
      diff,
      realAgent,
    });
    writeFileSync(
      join(layout.root, "evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    console.log("Unit 5.1 isolated native validation: PASS");
    console.log(JSON.stringify(evidence, null, 2));
    if (options.cleanup) rmSync(layout.root, { recursive: true, force: true });
  } catch (error) {
    if (layout) {
      try {
        after = protectedPiSnapshot(realHome);
        diff = snapshotDiff(before, after);
        writeFileSync(
          join(layout.root, "failure.json"),
          `${JSON.stringify({ status: "FAIL", error: error instanceof Error ? error.message : String(error), realPiHomeDiff: diff }, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      } catch {
        // Preserve the original failure; the temporary root remains for inspection.
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Unit 5.1 isolated native validation: ${message.startsWith("BLOCKED") ? "BLOCKED" : "FAIL"}`,
    );
    console.error(message);
    if (layout) console.error(`Evidence root retained: ${layout.root}`);
    if (diff.length > 0)
      console.error(`Real Pi home differences: ${diff.length}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}

export { protectedPiSnapshot, snapshotDiff, packageMetadata, buildEnvironment };
