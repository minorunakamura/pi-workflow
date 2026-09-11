#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  packageMetadata,
  protectedPiSnapshot,
  snapshotDiff,
} from "./validate-unit5-isolated.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PI_VERSION = "0.85.1";
const PI_SUBAGENTS_VERSION = "0.67.0";
const PI_SUBAGENTS_BIN = "install.mjs";
const RESEARCH_TOOLS = [
  "pi_workflow_ketch_search",
  "ketch_code",
  "ketch_docs",
  "ketch_scrape",
];
const FORBIDDEN_TOOLS = ["ketch_search", "multi", "random"];
const CLEAR_ENVIRONMENT_KEYS = new Set([
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

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function createLayout() {
  const root = resolve(
    mkdtempSync(join(tmpdir(), "pi-workflow-research-isolation-")),
  );
  const layout = {
    root,
    home: join(root, "home"),
    agent: join(root, "pi-agent"),
    sessions: join(root, "sessions"),
    runtime: join(root, "pi-subagents-temp"),
    tmp: join(root, "tmp"),
    fixture: join(root, "fixture"),
    helper: join(root, "helper"),
    outputs: join(root, "outputs"),
  };
  for (const directory of Object.values(layout)) {
    if (directory !== root)
      mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  symlinkSync(
    join(REPO_ROOT, "node_modules"),
    join(layout.helper, "node_modules"),
  );
  return layout;
}

function writeSettings(layout, piSubagentsRoot, piKetchRoot) {
  writeFileSync(
    join(layout.agent, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.6-luna",
        defaultThinkingLevel: "off",
        quietStartup: true,
        enableInstallTelemetry: false,
        defaultProjectTrust: "always",
        packages: [REPO_ROOT, piSubagentsRoot, piKetchRoot],
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  mkdirSync(join(layout.agent, "extensions", "subagent"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    join(layout.agent, "extensions", "subagent", "config.json"),
    `${JSON.stringify(
      {
        artifactDir: "temp",
        defaultSessionDir: layout.sessions,
        singleRunOutputBaseDir: layout.outputs,
        missions: {
          directory: join(layout.root, "missions"),
          globalIndex: false,
        },
        asyncByDefault: false,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function buildEnvironment(layout) {
  const environment = { ...process.env };
  // Never inherit Ketch selection or credential overrides into isolation.
  for (const key of [...Object.keys(environment), ...CLEAR_ENVIRONMENT_KEYS]) {
    if (
      CLEAR_ENVIRONMENT_KEYS.has(key) ||
      key.startsWith("PI_SUBAGENT") ||
      key.startsWith("KETCH_")
    )
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
  delete environment.NODE_PATH;
  return environment;
}

function writeProbe(layout, piKetchRoot) {
  const researcherSource = pathToFileURL(
    join(REPO_ROOT, "src", "researcher-tools.ts"),
  ).href;
  const workflowResourcesSource = pathToFileURL(
    join(REPO_ROOT, "src", "runtime", "workflow-resources.ts"),
  ).href;
  const outputPath = JSON.stringify(join(layout.root, "probe.json"));
  const ketchRoot = JSON.stringify(piKetchRoot);
  const expectedTools = JSON.stringify(RESEARCH_TOOLS);
  const forbiddenTools = JSON.stringify(FORBIDDEN_TOOLS);

  writeFileSync(
    join(layout.helper, "probe.mjs"),
    `import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { executeSearch } from "pi-ketch/search";
import { resolveSubagentLaunchContract } from "pi-subagents/preflight";
import { createResearchSearchTool, RESEARCH_SEARCH_BACKENDS } from ${JSON.stringify(researcherSource)};
import { WORKFLOW_RESOURCE_DEFINITIONS } from ${JSON.stringify(workflowResourcesSource)};

const expectedTools = ${expectedTools};
const forbiddenTools = ${forbiddenTools};
const probePath = ${outputPath};
const ketchRoot = ${ketchRoot};
const researcherSource = ${JSON.stringify(fileURLToPath(researcherSource))};

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sameArray(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function publicSearchFixture(cwd) {
  const calls = [];
  const pi = {
    exec: async (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd });
      return { stdout: "[]", stderr: "", code: 0, killed: false };
    },
  };
  const response = await executeSearch(
    pi,
    { query: "public configured", provider: { mode: "configured" } },
    { cwd },
  );
  assert(response.results.length === 0, "Public pi-ketch/search fixture returned unexpected results.");
  return { calls, response };
}

async function restrictedSearchFixture(cwd) {
  const calls = [];
  const pi = {
    exec: async (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd });
      return { stdout: "[]", stderr: "", code: 0, killed: false };
    },
  };
  const tool = createResearchSearchTool(pi);
  const configured = await tool.execute(
    "configured",
    { query: "  configured query  " },
    undefined,
    undefined,
    { cwd },
  );
  let duplicateCode;
  try {
    await tool.execute(
      "configured-duplicate",
      { query: "configured query" },
      undefined,
      undefined,
      { cwd },
    );
  } catch (error) {
    duplicateCode = error?.code;
  }
  assert(duplicateCode === "duplicate_search", "Normalized duplicate Search was executable.");
  const single = await tool.execute(
    "single",
    { query: "single query", backend: " brave " },
    undefined,
    undefined,
    { cwd },
  );
  const rejected = {};
  for (const backend of ["multi", "random", "all", "brave,ddg"]) {
    try {
      await tool.execute(
        "invalid",
        { query: "query", backend },
        undefined,
        undefined,
        { cwd },
      );
      rejected[backend] = false;
    } catch {
      rejected[backend] = true;
    }
  }
  try {
    await tool.execute(
      "invalid-query",
      { query: "   " },
      undefined,
      undefined,
      { cwd },
    );
    rejected.blankQuery = false;
  } catch {
    rejected.blankQuery = true;
  }

  const fields = Object.keys(tool.parameters.properties ?? {});
  assert(sameArray(fields, ["query", "backend"]), "Restricted Search schema exposed extra fields.");
  assert(tool.parameters.additionalProperties === false, "Restricted Search schema is not closed.");
  assert(Array.isArray(tool.parameters.required) && tool.parameters.required.includes("query"), "Restricted Search query is not required.");
  assert(sameArray(calls[0]?.args, ["search", "configured query", "--json"]), "Configured Search did not use the configured provider path.");
  assert(sameArray(calls[1]?.args, ["search", "single query", "--backend", "brave", "--json"]), "Single Search did not use provider.mode=single.");
  assert(calls.length === 2, "Normalized duplicate Search executed the underlying provider.");
  assert(Object.values(rejected).every(Boolean), "A forbidden Search contract input was executable.");

  return {
    schema: { fields, additionalProperties: tool.parameters.additionalProperties, required: tool.parameters.required },
    calls,
    configured: configured.details,
    single: single.details,
    duplicateCode,
    rejected,
    allowedBackends: [...RESEARCH_SEARCH_BACKENDS],
  };
}

async function failedSearchFixture(cwd) {
  const calls = [];
  const pi = {
    exec: async (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd });
      return { stdout: "", stderr: "missing configuration", code: 5, killed: false };
    },
  };
  const tool = createResearchSearchTool(pi);
  const errors = [];
  for (const callId of ["failed", "failed-retry"]) {
    try {
      await tool.execute(
        callId,
        { query: "same precondition search" },
        undefined,
        undefined,
        { cwd },
      );
    } catch (error) {
      errors.push({ name: error?.name, code: error?.code });
    }
  }
  assert(calls.length === 1, "A repeated non-recoverable Search executed twice.");
  assert(errors[0]?.code === "precondition", "Initial precondition failure was not preserved.");
  assert(errors[1]?.code === "failed_search", "Failed Search suppression was not distinguishable.");
  return { calls, errors };
}

async function childToolSurface(cwd) {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [ketchRoot, researcherSource],
  });
  await loader.reload();
  const extensionsResult = loader.getExtensions();
  assert(extensionsResult.errors.length === 0, "Child extension fixture failed: " + JSON.stringify(extensionsResult.errors));
  const sessionResult = await createAgentSession({
    cwd,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    resourceLoader: loader,
    tools: expectedTools,
    sessionManager: SessionManager.inMemory(cwd),
  });
  try {
    const tools = sessionResult.session.agent.state.tools.map((tool) => tool.name);
    assert(sameArray(tools, expectedTools), "Child model-visible tools differ: " + JSON.stringify(tools));
    assert(!tools.includes("ketch_search"), "Generic ketch_search was model-visible in the child fixture.");
    return {
      tools,
      extensionPaths: extensionsResult.extensions.map((extension) => extension.path),
      loadedToolNames: extensionsResult.extensions.flatMap((extension) => [...extension.tools.keys()]),
    };
  } finally {
    sessionResult.session.dispose();
  }
}

async function validate(ctx) {
  const cwd = ctx.cwd;
  const preflight = await resolveSubagentLaunchContract({
    agent: "pi-workflow.researcher",
    cwd,
    context: "fresh",
    sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
    availableModels: [],
    intercomBridge: { mode: "off" },
  });
  assert(preflight.ok, preflight.ok ? "" : preflight.message);
  const contract = preflight.contract;
  assert(contract.agent.name === "pi-workflow.researcher", "Preflight resolved the wrong Agent.");
  assert(contract.agent.packageName === "pi-workflow", "Preflight did not resolve the package-owned Agent.");
  assert(contract.agent.source === "package", "Research Agent was not discovered as a package Agent.");
  assert(contract.agent.filePath.endsWith("agents/researcher.md"), "Preflight used an unexpected Agent definition.");
  assert(contract.tools.explicitAllowlist === true, "Research Agent did not resolve with a strict allowlist.");
  assert(sameArray(contract.tools.effectiveAllowlist, expectedTools), "Unexpected preflight tool surface: " + JSON.stringify(contract.tools.effectiveAllowlist));
  assert(!contract.tools.effectiveAllowlist.some((tool) => forbiddenTools.includes(tool)), "Forbidden Search capability appeared in preflight tools.");
  assert(contract.tools.configuredExtensions.some((path) => path.endsWith("src/researcher-tools.ts")), "Restricted Search child-only extension was not resolved.");
  assert(contract.tools.disableAmbientExtensions === true, "Research Agent did not disable ambient extensions.");

  const researchDefinition = WORKFLOW_RESOURCE_DEFINITIONS.find((definition) => definition.name === "pi-workflow.research");
  assert(researchDefinition !== undefined, "Research resource was not present.");
  const researchResolution = researchDefinition.resolve({});
  assert("script" in researchResolution, researchResolution.error ?? "Research resource did not resolve.");
  assert(researchResolution.script.includes('agent: "pi-workflow.researcher"'), "Research resource selected the wrong Agent.");
  assert(!researchResolution.script.includes('agent: "pi-ketch.researcher"'), "Research resource selected generic pi-ketch.researcher.");

  const child = await childToolSurface(cwd);
  const publicSearch = await publicSearchFixture(cwd);
  const restrictedSearch = await restrictedSearchFixture(cwd);
  const failedSearch = await failedSearchFixture(cwd);
  const publicSearchUrl = typeof import.meta.resolve === "function" ? import.meta.resolve("pi-ketch/search") : undefined;
  if (publicSearchUrl !== undefined) {
    assert(publicSearchUrl.includes("pi-ketch"), "Public Search API resolved outside pi-ketch: " + publicSearchUrl);
    assert(!publicSearchUrl.includes("pi-ketch/src/runtime"), "Public Search API resolved through a private runtime path.");
  }

  return {
    status: "PASS",
    agentDiscovery: {
      status: "PASS",
      canonicalName: contract.agent.name,
      packageName: contract.agent.packageName,
      source: contract.agent.source,
      filePath: contract.agent.filePath,
      genericKetchResearcherSelected: false,
    },
    effectiveTools: {
      status: "PASS",
      preflight: contract.tools.effectiveAllowlist,
      childModelVisible: child.tools,
      restrictedSearch: true,
      ketchCode: true,
      ketchDocs: true,
      ketchScrape: true,
      genericKetchSearch: false,
      multi: false,
      random: false,
      providerMissingFirstTurn: "not-exercised; no model/provider success is required by this fixture",
      childExtensions: child.extensionPaths,
      childLoadedTools: child.loadedToolNames,
    },
    publicBoundary: {
      status: "PASS",
      importSpecifier: "pi-ketch/search",
      resolvedSpecifier: publicSearchUrl ?? null,
      calls: publicSearch.calls,
      response: publicSearch.response,
      deepImport: false,
      privateRuntimeImport: false,
      globalInstallDependency: false,
      filesystemAbsoluteDependency: false,
    },
    restrictedSearch: {
      status: "PASS",
      schema: restrictedSearch.schema,
      allowedBackends: restrictedSearch.allowedBackends,
      calls: restrictedSearch.calls,
      configuredDefault: "PASS",
      singleBackend: "PASS",
      rejected: restrictedSearch.rejected,
      duplicateCode: restrictedSearch.duplicateCode,
      failedSignature: {
        calls: failedSearch.calls,
        errors: failedSearch.errors,
      },
    },
    resourceSelection: {
      status: "PASS",
      resource: researchDefinition.name,
      agent: "pi-workflow.researcher",
      genericAgent: "pi-ketch.researcher",
      genericAgentSelected: false,
    },
    temporaryEnvironment: {
      home: process.env.HOME,
      piAgentRoot: process.env.PI_CODING_AGENT_DIR,
      sessionRoot: process.env.PI_CODING_AGENT_SESSION_DIR,
      tmpdir: process.env.TMPDIR,
      piSubagentsTempRoot: process.env.PI_SUBAGENTS_TEMP_ROOT,
      cwd,
      temporaryPathsOnly: true,
    },
  };
}

export default function (pi) {
  pi.registerCommand("pi-workflow-research-isolation", {
    description: "Run the isolated Research Agent validation fixture",
    handler: async (_args, ctx) => {
      let report;
      try {
        report = await validate(ctx);
      } catch (error) {
        report = {
          status: "FAIL",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      writeFileSync(probePath, JSON.stringify(report, null, 2) + "\\n", { encoding: "utf8", mode: 0o600 });
    },
  });
}
`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function resolvePiInvocation() {
  const pi = packageMetadata(
    join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent"),
    "@earendil-works/pi-coding-agent",
    PI_VERSION,
  );
  const cli = join(pi.packageRoot, "dist", "bundle", "cli.js");
  assert(existsSync(cli), `Pi CLI bundle is missing: ${cli}`);
  return { binary: process.execPath, args: [cli], package: pi };
}

function runPiProbe({ layout, environment, piInvocation, timeoutMs }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      piInvocation.binary,
      [
        ...piInvocation.args,
        "--mode",
        "rpc",
        "--no-session",
        "--session-dir",
        layout.sessions,
        "--extension",
        join(layout.helper, "probe.mjs"),
      ],
      {
        cwd: layout.fixture,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdoutPath = join(layout.root, "rpc.jsonl");
    const stderrPath = join(layout.root, "stderr.log");
    const stdout = [];
    const stderr = [];
    let buffer = "";
    let commandSent = false;
    let inputClosed = false;
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);

    function closeInput() {
      if (inputClosed || child.stdin.destroyed) return;
      inputClosed = true;
      child.stdin.end();
    }

    function handleLine(line) {
      if (!line) return;
      stdout.push(line);
      try {
        const event = JSON.parse(line);
        if (!commandSent && event.type === "extension_ui_request") {
          commandSent = true;
          child.stdin.write(
            `${JSON.stringify({ id: "research-isolation", type: "prompt", message: "/pi-workflow-research-isolation" })}\n`,
          );
        }
        if (
          event.type === "response" &&
          event.id === "research-isolation" &&
          event.success === true
        ) {
          setTimeout(closeInput, 25).unref();
        }
      } catch {
        // Preserve the raw RPC line; the report parser below handles only JSON.
      }
    }

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
    });
    child.stdout.on("end", () => {
      if (buffer) handleLine(buffer.replace(/\r$/u, ""));
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      writeFileSync(stdoutPath, `${stdout.join("\n")}\n`, { mode: 0o600 });
      writeFileSync(stderrPath, stderr.join(""), { mode: 0o600 });
      if (!settled) {
        settled = true;
        resolveRun({ code, signal, timedOut, stdoutPath, stderrPath });
      }
    });
  });
}

function parseOptions(argv) {
  const options = { cleanup: false, timeoutMs: 120_000 };
  for (const argument of argv) {
    if (argument === "--cleanup") options.cleanup = true;
    else if (argument.startsWith("--timeout-ms=")) {
      const value = Number(argument.slice("--timeout-ms=".length));
      if (!Number.isSafeInteger(value) || value < 1)
        fail("--timeout-ms must be a positive integer.");
      options.timeoutMs = value;
    } else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node scripts/validate-research-isolation.mjs [--timeout-ms=N] [--cleanup]",
      );
      return { ...options, help: true };
    } else fail(`Unknown option '${argument}'.`);
  }
  return options;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) return;

  const realHome = resolve(process.env.HOME ?? homedir());
  const before = protectedPiSnapshot(realHome);
  let layout;
  let after;
  let homeDiff = [];
  try {
    const piInvocation = resolvePiInvocation();
    const piSubagents = packageMetadata(
      join(REPO_ROOT, "node_modules", "pi-subagents"),
      "pi-subagents",
      PI_SUBAGENTS_VERSION,
    );
    assert(
      piSubagents.packageJson.bin?.["pi-subagents"] === PI_SUBAGENTS_BIN,
      "pi-subagents package bin metadata changed.",
    );
    const piKetch = packageMetadata(
      join(REPO_ROOT, "node_modules", "pi-ketch"),
      "pi-ketch",
      readJson(join(REPO_ROOT, "node_modules", "pi-ketch", "package.json"))
        .version,
    );
    const packageJson = readJson(join(REPO_ROOT, "package.json"));
    const dependency = packageJson.dependencies?.["pi-ketch"];
    assert(
      typeof dependency === "string" &&
        dependency.includes("github.com/minorunakamura/pi-ketch"),
      "pi-ketch is not a package runtime dependency.",
    );
    assert(
      !dependency.startsWith("/"),
      "pi-ketch uses a filesystem-absolute dependency.",
    );
    assert(
      piKetch.packageJson.exports?.["./search"] === "./src/api/search.ts",
      "pi-ketch/search public export is missing.",
    );
    const researcherSource = readFileSync(
      join(REPO_ROOT, "src", "researcher-tools.ts"),
      "utf8",
    );
    for (const forbidden of [
      "pi-ketch/src/",
      "pi-ketch/src/runtime/",
      "pi-ketch/src/tools/",
      "runKetch",
      "child_process",
    ]) {
      assert(
        !researcherSource.includes(forbidden),
        `Restricted Search source uses forbidden private dependency: ${forbidden}`,
      );
    }

    layout = createLayout();
    writeSettings(layout, piSubagents.packageRoot, piKetch.packageRoot);
    writeProbe(layout, piKetch.packageRoot);
    const environment = buildEnvironment(layout);
    const runtime = await runPiProbe({
      layout,
      environment,
      piInvocation,
      timeoutMs: options.timeoutMs,
    });
    after = protectedPiSnapshot(realHome);
    homeDiff = snapshotDiff(before, after);
    assert(
      runtime.code === 0 && runtime.signal === null,
      `Isolated Pi exited abnormally: code=${String(runtime.code)} signal=${String(runtime.signal)}.`,
    );
    assert(!runtime.timedOut, "Isolated Research validation timed out.");
    assert(
      homeDiff.length === 0,
      "Real Pi home changed during isolated Research validation.",
    );
    const probePath = join(layout.root, "probe.json");
    assert(existsSync(probePath), `Native probe did not write ${probePath}.`);
    const probe = readJson(probePath);
    assert(
      probe.status === "PASS",
      probe.error ?? "Native Research isolation probe failed.",
    );

    const evidence = {
      ...probe,
      pi: {
        version: piInvocation.package.packageJson.version,
        packageRoot: piInvocation.package.packageRoot,
      },
      piSubagents: {
        version: piSubagents.packageJson.version,
        packageRoot: piSubagents.packageRoot,
        versionVerification: "package metadata read-only",
        packageBin: piSubagents.packageJson.bin,
        packageBinExecuted: false,
        installerExecuted: false,
      },
      piKetch: {
        version: piKetch.packageJson.version,
        packageRoot: piKetch.packageRoot,
        publicSearchExport: piKetch.packageJson.exports["./search"],
      },
      isolation: {
        root: layout.root,
        realHome: realHome,
        realPiHomeDiff: [],
        temporaryPathsOnly: true,
        stdoutPath: runtime.stdoutPath,
        stderrPath: runtime.stderrPath,
      },
      guards: {
        multi: "unreachable/rejected",
        random: "unreachable/rejected",
        commaAggregation: "unreachable/rejected",
        rawArbitraryFlags: "schema-rejected",
      },
    };
    writeFileSync(
      join(layout.root, "evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    console.log("Research Agent isolation targeted native validation: PASS");
    console.log(JSON.stringify(evidence, null, 2));
    if (options.cleanup) rmSync(layout.root, { recursive: true, force: true });
  } catch (error) {
    if (layout) {
      try {
        after = protectedPiSnapshot(realHome);
        homeDiff = snapshotDiff(before, after);
        writeFileSync(
          join(layout.root, "failure.json"),
          `${JSON.stringify({ status: "FAIL", error: error instanceof Error ? error.message : String(error), realPiHomeDiff: homeDiff }, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      } catch {
        // Preserve the original failure and temporary evidence root.
      }
    }
    console.error(
      `Research Agent isolation targeted native validation: ${homeDiff.length > 0 ? "FAIL (real Pi home changed)" : "FAIL"}`,
    );
    console.error(error instanceof Error ? error.message : String(error));
    if (layout) console.error(`Evidence root retained: ${layout.root}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
